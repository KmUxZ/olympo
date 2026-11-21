// Argos · service worker (Manifest V3).
// Responsable de: sesión, turno, pausas, agregación por minuto, cola local y sincronización con reintentos.
// Chrome puede detener este worker en cualquier momento: todo el estado vive en chrome.storage.local.

const DEFAULT_SERVER = 'http://localhost:4000';
const ALARM = 'argos-tick';
const SCRIPT_ID = 'argos-tracker';
const MIN = 60_000;
const PERIOD_MINUTES = 0.5;
const MAX_QUEUED_MINUTES = 2880; // 48 h de cola sin conexión
const BATCH = 1500;

const store = chrome.storage.local;
// El token de sesión solo es legible desde la propia extensión, nunca desde scripts de contenido.
store.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

const floorMin = (t) => Math.floor(t / MIN) * MIN;
const iso = (t) => new Date(t).toISOString();

// Cola de exclusión: las lecturas-modificaciones-escrituras del almacenamiento se ejecutan de una en una.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(serverUrl, token, method, path, body) {
  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError('sin_conexion', 'No hay conexión con el servidor.', 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json?.error?.code ?? 'error', json?.error?.message ?? 'Ocurrió un error.', res.status);
  return json;
}

async function api(method, path, body) {
  const { auth } = await store.get('auth');
  if (!auth?.token) throw new ApiError('no_autenticado', 'Inicia sesión.', 401);
  try {
    return await request(auth.serverUrl, auth.token, method, path, body);
  } catch (err) {
    if (err.status === 401) await signedOut();
    throw err;
  }
}

// ───────── Herramientas autorizadas ─────────
function hostMatches(pattern, host) {
  return pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern;
}
function toolForUrl(tools, url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  return tools.find((t) => t.hosts.some((h) => hostMatches(h, host))) ?? null;
}
const originsOf = (tools) => [...new Set(tools.flatMap((t) => t.hosts.map((h) => `https://${h}/*`)))];

async function toolsGranted(tools) {
  const origins = originsOf(tools);
  if (!origins.length) return false;
  return chrome.permissions.contains({ origins }).catch(() => false);
}

// ───────── Estado ─────────
async function getState() {
  return (await store.get('state')).state ?? null;
}
function patchState(patch) {
  return locked(async () => {
    const state = (await getState()) ?? {};
    const next = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    await store.set({ state: next });
    return next;
  });
}

async function signedOut() {
  const { auth } = await store.get('auth');
  await locked(() => store.set({ auth: { serverUrl: auth?.serverUrl ?? DEFAULT_SERVER }, state: null, buckets: {} }));
  await applyTracking();
}

/** Trae del servidor el estado propio (turno abierto, pausa, herramientas, líneas, programación). */
async function refreshState() {
  const remote = await api('GET', '/api/argos/me/state');
  await patchState({
    user: remote.user,
    company: remote.company,
    shift: remote.shift,
    openBreak: remote.openBreak,
    tools: remote.tools,
    lines: remote.lines,
    schedule: remote.schedule,
    breakReasons: remote.breakReasons,
    refreshedAt: Date.now(),
  });
  await applyTracking();
}

/**
 * Aplica el estado: los scripts de contenido solo quedan registrados durante un turno activo,
 * y solo cuentan cuando no hay pausa.
 */
async function applyTracking() {
  const state = await getState();
  const inShift = Boolean(state?.shift);
  const tracking = inShift && !state.openBreak;
  const tools = state?.tools ?? [];
  const origins = originsOf(tools);
  const granted = await toolsGranted(tools);

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  if (inShift && granted) {
    await chrome.scripting
      .registerContentScripts([{ id: SCRIPT_ID, matches: origins, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true }])
      .catch(() => {});
  }
  if (granted) {
    const tabs = await chrome.tabs.query({ url: origins }).catch(() => []);
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'argos:tracking', on: tracking });
      } catch {
        // Pestaña abierta antes de iniciar el turno: se inyecta ahora.
        if (tracking) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
      }
    }
  }
  await patchState({ permissionsOk: granted });
  await updateBadge();
}

async function updateBadge() {
  const state = await getState();
  let text = '';
  let color = '#6b7280';
  if (state?.shift) {
    if (state.openBreak) [text, color] = ['II', '#b45309'];
    else if (!state.permissionsOk || state.lastSyncOk === false) [text, color] = ['!', '#b91c1c'];
    else [text, color] = ['ON', '#0f9d92'];
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  const title = !state?.shift ? 'Argos — sin turno activo' : state.openBreak ? 'Argos — en pausa (no se registra actividad)' : 'Argos — turno activo: se registra actividad agregada';
  await chrome.action.setTitle({ title });
}

// ───────── Agregación por minuto ─────────
async function addActivity(sender, msg) {
  return locked(async () => {
    const { state, buckets = {} } = await store.get(['state', 'buckets']);
    const tracking = Boolean(state?.shift && !state.openBreak);
    if (!tracking) return { tracking: false };
    const tool = toolForUrl(state.tools ?? [], sender.tab?.url ?? sender.url ?? '');
    if (!tool) return { tracking: false };
    const key = iso(floorMin(Date.now()));
    const bucket = (buckets[key] ??= { systemState: 'active', tools: {} });
    const t = (bucket.tools[tool.id] ??= { focusSeconds: 0, activeSeconds: 0, keys: 0, clicks: 0, scrolls: 0 });
    const n = (v, max) => Math.max(0, Math.min(max, Number.isFinite(v) ? Math.round(v) : 0));
    t.focusSeconds = Math.min(60, t.focusSeconds + n(msg.focus, 60));
    t.activeSeconds = Math.min(60, t.activeSeconds + n(msg.active, 60));
    t.keys += n(msg.keys, 2000);
    t.clicks += n(msg.clicks, 2000);
    t.scrolls += n(msg.scrolls, 600);
    await store.set({ buckets });
    return { tracking: true };
  });
}

/** Marca "la extensión estaba viva" en cada minuto del turno, haya o no actividad. */
async function markPresence() {
  const systemState = await chrome.idle.queryState(60).catch(() => 'unknown');
  await locked(async () => {
    const { state, buckets = {} } = await store.get(['state', 'buckets']);
    if (!state?.shift) return;
    const now = Date.now();
    const current = floorMin(now);
    const from = state.lastTickAt && now - state.lastTickAt <= 130_000 ? floorMin(state.lastTickAt) : current;
    for (let m = from; m <= current; m += MIN) buckets[iso(m)] ??= { systemState, tools: {} };
    buckets[iso(current)].systemState = systemState;
    // Límite de la cola local: se descartan los minutos más antiguos.
    const keys = Object.keys(buckets).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_QUEUED_MINUTES))) delete buckets[k];
    await store.set({ buckets, state: { ...state, lastTickAt: now } });
  });
}

// ───────── Sincronización ─────────
let syncing = null;
async function sync(includeCurrent = false) {
  while (syncing) await syncing; // nunca dos envíos a la vez
  syncing = doSync(includeCurrent).finally(() => (syncing = null));
  return syncing;
}

async function doSync(includeCurrent) {
  const startedAt = Date.now();
  const { state, buckets = {} } = await store.get(['state', 'buckets']);
  if (!state?.shift) return;
  const current = floorMin(Date.now());
  // Se envía también el minuto en curso (parcial) para que el tablero vaya casi al día.
  // El servidor conserva el valor más alto de cada minuto, así que el envío final lo completa sin duplicar.
  const keys = Object.keys(buckets).sort().slice(0, BATCH);
  const minutes = keys.map((k) => ({
    minute: k,
    systemState: buckets[k].systemState ?? 'unknown',
    tools: Object.entries(buckets[k].tools).map(([toolId, v]) => ({ toolId, ...v })),
  }));
  try {
    // Aunque no haya minutos que enviar, la llamada sirve de señal de vida.
    const res = await api('POST', `/api/argos/shifts/${state.shift.id}/sync`, { sentAt: iso(Date.now()), minutes });
    const ended = res.shift?.status === 'ended';
    const changed = await locked(async () => {
      const fresh = await store.get(['state', 'buckets']);
      if (fresh.state?.shift?.id !== state.shift.id) return false; // el turno cambió mientras se enviaba
      const remaining = fresh.buckets ?? {};
      // El servidor es idempotente: si esta eliminación no llegara a guardarse, reenviar no duplica nada.
      // El minuto en curso se queda en la cola hasta que se cierre (salvo al finalizar el turno).
      for (const k of keys) if (includeCurrent || Date.parse(k) < current) delete remaining[k];
      const next = { ...fresh.state, lastSyncAt: Date.now(), lastSyncOk: true, lastError: null, pendingMinutes: Object.keys(remaining).length };
      // La pausa pudo iniciarse o terminarse desde la web; se respeta un cambio local más reciente que este envío.
      const before = Boolean(next.openBreak);
      if ((next.breakChangedAt ?? 0) < startedAt) next.openBreak = res.openBreak ?? null;
      if (ended) Object.assign(next, { shift: null, openBreak: null, endedRemotely: true });
      await store.set({ state: next, buckets: ended ? {} : remaining });
      return ended || before !== Boolean(next.openBreak);
    });
    if (changed) await applyTracking();
  } catch (err) {
    if (err.status === 401) return;
    const pending = Object.keys((await store.get('buckets')).buckets ?? {}).length;
    await patchState({ lastSyncOk: false, lastError: err.message, pendingMinutes: pending });
  }
  await updateBadge();
}

async function tick() {
  const { auth } = await store.get('auth');
  if (!auth?.token) return;
  const state = await getState();
  if (!state?.shift) return;
  await markPresence();
  await sync(false);
}

function ensureAlarm() {
  // 30 s es el intervalo mínimo que permite Chrome para una extensión.
  chrome.alarms.get(ALARM).then((a) => {
    if (!a || a.periodInMinutes !== PERIOD_MINUTES) chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  });
}

// ───────── Acciones (desde la ventana emergente) ─────────
const actions = {
  async login({ serverUrl, email, password }) {
    const url = (serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '');
    const res = await request(url, null, 'POST', '/api/auth/login', { email, password, client: 'extension' });
    await locked(() => store.set({ auth: { serverUrl: url, token: res.token }, state: { user: res.user }, buckets: {} }));
    ensureAlarm();
    await refreshState();
  },
  async logout() {
    const state = await getState();
    if (state?.shift) throw new ApiError('turno_activo', 'Finaliza tu turno antes de cerrar sesión.', 400);
    await api('POST', '/api/auth/logout').catch(() => {});
    await signedOut();
  },
  async refresh() {
    const { auth } = await store.get('auth');
    if (auth?.token) await refreshState();
  },
  async apply() {
    await applyTracking();
  },
  async startShift() {
    const res = await api('POST', '/api/argos/shifts/start');
    await locked(async () => {
      const state = await getState();
      await store.set({
        state: { ...state, shift: res.shift, openBreak: null, lastTickAt: null, lastSyncAt: null, lastSyncOk: null, lastError: null, pendingMinutes: 0, endedRemotely: false, lastSummary: null },
        ...(res.alreadyActive ? {} : { buckets: {} }),
      });
    });
    ensureAlarm();
    await applyTracking();
    await markPresence();
    await sync(false);
  },
  async endShift() {
    const state = await getState();
    if (!state?.shift) return;
    await markPresence();
    await sync(true); // envía también el minuto en curso
    const res = await api('POST', `/api/argos/shifts/${state.shift.id}/end`);
    await locked(async () => {
      const s = await getState();
      await store.set({ state: { ...s, shift: null, openBreak: null, lastSummary: res.summary ?? null, lastSummaryAt: Date.now() }, buckets: {} });
    });
    await applyTracking();
  },
  async startBreak({ reason, note }) {
    const state = await getState();
    if (!state?.shift) return;
    const res = await api('POST', `/api/argos/shifts/${state.shift.id}/breaks`, { reason, note: note ?? '' });
    await patchState({ openBreak: res.openBreak, breakChangedAt: Date.now() });
    await applyTracking();
  },
  async endBreak() {
    const state = await getState();
    if (!state?.shift) return;
    await api('POST', `/api/argos/shifts/${state.shift.id}/breaks/end`);
    await patchState({ openBreak: null, breakChangedAt: Date.now() });
    await applyTracking();
  },
  async incident({ incidentType, description }) {
    await api('POST', '/api/argos/incidents', { type: incidentType, description });
  },
  async syncNow() {
    await markPresence();
    await sync(false);
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;
  // Mensajes de los scripts de contenido (páginas autorizadas).
  if (message.type === 'argos:activity') {
    addActivity(sender, message).then(sendResponse, () => sendResponse({ tracking: false }));
    return true;
  }
  if (message.type === 'argos:hello') {
    getState().then((state) => {
      const tracking = Boolean(state?.shift && !state.openBreak && toolForUrl(state.tools ?? [], sender.tab?.url ?? sender.url ?? ''));
      sendResponse({ tracking });
    });
    return true;
  }
  // Acciones de la ventana emergente: solo se aceptan desde páginas de la propia extensión.
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  const action = actions[message.type];
  if (!action) return;
  action(message)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, code: err.code ?? 'error', message: err.message ?? 'Ocurrió un error.' }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) tick();
});
chrome.permissions.onAdded.addListener(() => applyTracking());
chrome.permissions.onRemoved.addListener(() => applyTracking());

async function boot() {
  ensureAlarm();
  const { auth } = await store.get('auth');
  if (auth?.token) await refreshState().catch(() => updateBadge());
  else await updateBadge();
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
