// Argos · ventana emergente. Muestra siempre a la persona qué está pasando con su turno y el registro.
const DEFAULT_SERVER = 'http://localhost:4000';
const BREAK_LABEL = { descanso: 'Descanso', almuerzo: 'Almuerzo', personal: 'Personal', capacitacion: 'Capacitación o reunión', otro: 'Otro' };
const INCIDENT_LABEL = { conexion: 'Falla de conexión', linea: 'Problema con la línea', plataforma: 'Falla de una plataforma', ausencia: 'Ausencia', otro: 'Otro' };
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

const app = document.getElementById('app');
const logoutBtn = document.getElementById('logout');
let ui = { busy: false, error: '', notice: '', panel: null }; // panel: 'pause' | 'incident' | 'end' | 'order' | null
// Borrador del pedido: se guarda aparte para que no se pierda lo escrito si la ventana se vuelve a pintar.
const EMPTY_ORDER = { customerName: '', phone: '', city: '', address: '', neighborhood: '', notes: '', products: '', total: '', payment: 'contraentrega' };
let draft = { ...EMPTY_ORDER };
// La ventanita de la extensión se cierra en cuanto se hace clic fuera (por ejemplo, para copiar un dato del chat).
// Por eso: (1) el borrador se guarda en cada tecla y se recupera al volver a abrir, y
// (2) «Nuevo pedido» se abre en el panel lateral de Chrome, que sí permanece abierto junto al chat.
const SIDE = new URLSearchParams(location.search).has('side');
if (SIDE) document.body.classList.add('side');
const saveDraft = () => chrome.storage.local.set({ orderDraft: draft }).catch(() => {});
const clearDraft = () => {
  draft = { ...EMPTY_ORDER };
  chrome.storage.local.remove('orderDraft').catch(() => {});
};
let currentWindowId = null;
chrome.windows.getCurrent().then((w) => (currentWindowId = w.id)).catch(() => {});
const hasDraft = () => Object.keys(EMPTY_ORDER).some((k) => draft[k] !== EMPTY_ORDER[k]);

/** Abre el formulario de pedido en el panel lateral. Si el navegador no lo permite, lo muestra aquí mismo. */
async function openOrder() {
  if (!SIDE && chrome.sidePanel?.open && currentWindowId !== null) {
    try {
      // El identificador de la ventana se obtiene al cargar: Chrome exige abrir el panel en el mismo clic, sin esperas previas.
      await chrome.sidePanel.open({ windowId: currentWindowId });
      window.close();
      return;
    } catch {
      /* se muestra dentro de esta ventana */
    }
  }
  ui.panel = 'order';
  render();
}
let data = { auth: null, state: null };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const time = (t) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `hace ${s} s` : `hace ${duration(s * 1000)}`;
}

async function send(message, { keepPanel = false } = {}) {
  ui = { ...ui, busy: true, error: '', notice: '' };
  render();
  const res = await chrome.runtime.sendMessage(message).catch(() => ({ ok: false, message: 'La extensión no respondió. Vuelve a abrir esta ventana.' }));
  ui.busy = false;
  if (!res?.ok) ui.error = res?.message ?? 'Ocurrió un error.';
  else if (!keepPanel) ui.panel = null;
  // Recupera el borrador que hubiera quedado a medias.
const stored = (await chrome.storage.local.get('orderDraft')).orderDraft;
if (stored) draft = { ...EMPTY_ORDER, ...stored };
if (SIDE) ui.panel = 'order';
await load();
  return Boolean(res?.ok);
}

async function load() {
  data = await chrome.storage.local.get(['auth', 'state']);
  render();
}

function toolOrigins(tools) {
  return [...new Set((tools ?? []).flatMap((t) => t.hosts.map((host) => `https://${host}/*`)))];
}

// ───────── Vistas ─────────
function loginView() {
  // La extensión que se descarga desde la plataforma ya trae su servidor: el campo solo se muestra en desarrollo.
  const devBuild = /\/\/(localhost|127\.0\.0\.1)/.test(DEFAULT_SERVER);
  const server = h('input', { name: 'serverUrl', value: devBuild ? (data.auth?.serverUrl ?? DEFAULT_SERVER) : DEFAULT_SERVER, autocomplete: 'off' });
  const email = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  return h(
    'form',
    {
      class: 'stack',
      style: 'display:grid;gap:12px',
      onsubmit: async (e) => {
        e.preventDefault();
        const serverUrl = devBuild ? server.value.trim().replace(/\/+$/, '') || DEFAULT_SERVER : DEFAULT_SERVER;
        // Si el servidor no es el local por defecto, Chrome pide permiso para conectarse a él.
        try {
          const origin = `${new URL(serverUrl).origin}/*`;
          if (!(await chrome.permissions.contains({ origins: [origin] }))) {
            const ok = await chrome.permissions.request({ origins: [origin] });
            if (!ok) return void ((ui.error = 'Se necesita permiso para conectar con el servidor.'), render());
          }
        } catch {
          return void ((ui.error = 'La dirección del servidor no es válida.'), render());
        }
        await send({ type: 'login', serverUrl, email: email.value.trim(), password: password.value });
      },
    },
    h('p', { class: 'muted' }, 'Inicia sesión con tu cuenta de la plataforma.'),
    h('label', {}, 'Correo', email),
    h('label', {}, 'Contraseña', password),
    ...(devBuild ? [h('details', {}, h('summary', {}, 'Servidor'), h('label', { style: 'margin-top:6px' }, 'Dirección del servidor', server))] : []),
    h('button', { class: 'primary', type: 'submit', disabled: ui.busy }, ui.busy ? 'Entrando…' : 'Iniciar sesión'),
  );
}

function permissionCard(state) {
  if (!state.tools?.length) return h('div', { class: 'note warn' }, 'Tu administrador aún no ha definido herramientas de trabajo autorizadas.');
  if (state.permissionsOk) return null;
  return h(
    'div',
    { class: 'card' },
    h('strong', {}, 'Autoriza tus herramientas de trabajo'),
    h('span', { class: 'small muted' }, `El registro solo funciona dentro de: ${state.tools.map((t) => t.name).join(', ')}. Chrome te mostrará exactamente qué sitios son.`),
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          // Debe pedirse aquí, con un clic de la persona. Si Chrome cierra esta ventana al mostrar el aviso, el permiso se aplica igual.
          await chrome.permissions.request({ origins: toolOrigins(state.tools) }).catch(() => false);
          await send({ type: 'apply' });
        },
      },
      'Autorizar',
    ),
  );
}

/** Aviso y aceptación: sin esto no se puede iniciar turno (el servidor también lo exige). */
function consentCard(state) {
  if (!state.consent || state.consent.accepted) return null;
  const box = h('input', { type: 'checkbox', id: 'consent-check', style: 'width:auto' });
  const accept = h('button', { class: 'primary', disabled: true, onclick: () => send({ type: 'acceptConsent', version: state.consent.version }) }, 'Acepto');
  box.addEventListener('change', () => (accept.disabled = !box.checked));
  return h(
    'div',
    { class: 'card' },
    h('strong', {}, 'Antes de empezar: qué registra Argos'),
    h('span', { class: 'small' }, 'Durante tu turno, y solo en tus herramientas de trabajo, se registra: inicio y fin de turno, tus pausas, y cuántas teclas, clics y segundos de uso hubo por minuto.'),
    h('span', { class: 'small' }, 'Nunca se registra qué escribes, contraseñas, conversaciones, capturas ni sitios personales. Tampoco nada fuera de turno o en pausa.'),
    h('a', { class: 'small', href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Leer el detalle completo'),
    h('label', { style: 'display:flex;gap:8px;align-items:flex-start;color:var(--text);font-size:13px' }, box, h('span', {}, 'He leído y acepto este registro durante mis turnos.')),
    accept,
  );
}

/** Formulario rápido para crear un pedido en Hermes sin salir del chat. */
let validateTimer = null;
/** Pinta el resultado del validador en su propio recuadro, sin repintar el formulario (para no perder el foco). */
function showValidation(box, v) {
  const LEVEL = { completa: ['ok', 'Dirección completa'], revisar: ['warn', 'Dirección por revisar'], incompleta: ['danger', 'Dirección incompleta'] };
  const RISK = { alto: ['danger', 'Riesgo alto de devolución'], medio: ['warn', 'Historial mixto'], bueno: ['ok', 'Cliente cumplido'] };
  const parts = [];
  if (v?.blocked) parts.push(h('div', { class: 'note danger' }, h('strong', {}, 'Cliente bloqueado'), `. ${v.blocked.reason}. No se le pueden crear pedidos.`));
  if (v?.address) parts.push(h('div', { class: `note ${LEVEL[v.address.level][0]}` }, h('strong', {}, LEVEL[v.address.level][1]), v.address.city ? ` · ${v.address.city.name}, ${v.address.city.department}` : ''));
  const issues = [...(v?.contact ?? []), ...(v?.address?.issues ?? [])];
  if (issues.length) parts.push(h('ul', { class: 'small', style: 'margin:0;padding-left:18px' }, issues.map((i) => h('li', {}, i.message))));
  if (v?.history && RISK[v.history.risk]) parts.push(h('div', { class: `note ${RISK[v.history.risk][0]}` }, h('strong', {}, RISK[v.history.risk][1]), `. ${v.history.message}`));
  box.replaceChildren(...parts);
}

function orderForm() {
  const validationBox = h('div', { style: 'display:grid;gap:6px', 'aria-live': 'polite' });
  const validate = () => {
    clearTimeout(validateTimer);
    if (!draft.address.trim() && !draft.phone.trim()) return void validationBox.replaceChildren();
    validateTimer = setTimeout(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'validateOrder', data: { address: draft.address, neighborhood: draft.neighborhood, city: draft.city, phone: draft.phone, customerName: draft.customerName } }).catch(() => null);
      if (res?.ok) showValidation(validationBox, res.result);
    }, 600);
  };
  const field = (key, label, attrs = {}) => {
    const input = h('input', { value: draft[key], ...attrs });
    input.addEventListener('input', () => {
      draft[key] = input.value;
      saveDraft();
      if (['address', 'neighborhood', 'city', 'phone', 'customerName'].includes(key)) validate();
    });
    return h('label', {}, label, input);
  };
  // Campo abierto: la vendedora escribe todos los productos como quiera.
  const productsArea = h('textarea', { maxlength: '400', placeholder: 'Ej.: 2 fajas talla M negras y 1 crema reductora' });
  productsArea.value = draft.products;
  productsArea.addEventListener('input', () => {
    draft.products = productsArea.value;
    saveDraft();
  });
  const productsField = h('label', {}, 'Productos', productsArea);
  const payment = h('select', {}, h('option', { value: 'contraentrega' }, 'Contraentrega'), h('option', { value: 'pagado' }, 'Ya pagado'));
  payment.value = draft.payment;
  payment.addEventListener('change', () => {
    draft.payment = payment.value;
    saveDraft();
  });
  const submit = async () => {
    const total = Math.max(0, Math.round(Number(String(draft.total).replace(/[^\d]/g, '')) || 0));
    const missing = !draft.customerName.trim() || !draft.phone.trim() || !draft.city.trim() || draft.address.trim().length < 5 || !draft.neighborhood.trim() || !draft.products.trim();
    if (missing) return void ((ui.error = 'Completa nombre, WhatsApp, dirección, barrio, ciudad y productos.'), render());
    if (!total && draft.payment === 'contraentrega') return void ((ui.error = 'Escribe el valor total a cobrar.'), render());
    ui = { ...ui, busy: true, error: '', notice: '' };
    render();
    const res = await chrome.runtime
      .sendMessage({
        type: 'createOrder',
        order: {
          customerName: draft.customerName.trim(), phone: draft.phone.trim(), city: draft.city.trim(), address: draft.address.trim(), neighborhood: draft.neighborhood.trim(), notes: draft.notes.trim(),
          // Los productos van como texto libre (pueden ser varios) con el valor total del pedido.
          payment: draft.payment, items: [{ free: true, name: draft.products.trim(), qty: 1, price: total }],
        },
      })
      .catch(() => ({ ok: false, message: 'La extensión no respondió. Vuelve a abrir esta ventana.' }));
    ui.busy = false;
    if (!res?.ok) ui.error = res?.message ?? 'No se pudo crear el pedido.';
    else {
      clearDraft();
      ui.panel = SIDE ? 'order' : null; // en el panel lateral queda listo para el siguiente pedido
      ui.notice = `Pedido ${res.result.code} creado. Hermes ya le pidió la confirmación al cliente.${res.result.possibleDuplicateOf ? ` Ojo: ese número ya tenía abierto el pedido ${res.result.possibleDuplicateOf}.` : ''}`;
    }
    render();
  };
  validate(); // si había un borrador, se revisa al abrir
  return h(
    'div',
    { class: 'card' },
    h('strong', {}, 'Nuevo pedido'),
    field('customerName', 'Nombre del cliente', { autocomplete: 'off' }),
    field('phone', 'WhatsApp del cliente', { inputmode: 'tel', placeholder: '300 123 4567', autocomplete: 'off' }),
    h('div', { class: 'row' }, field('city', 'Ciudad', { autocomplete: 'off' }), h('label', {}, 'Pago', payment)),
    field('address', 'Dirección', { placeholder: 'Calle 10 # 5-20 apto 201', autocomplete: 'off' }),
    field('neighborhood', 'Barrio', { autocomplete: 'off' }),
    validationBox,
    field('notes', 'Indicaciones (opcional)', { autocomplete: 'off' }),
    productsField,
    field('total', 'Valor total a cobrar', { inputmode: 'numeric', placeholder: '120000', autocomplete: 'off' }),
    h('div', { class: 'row' }, h('button', { onclick: () => ((ui.panel = null), (ui.error = ''), render()) }, 'Volver'), hasDraft() ? h('button', { onclick: () => (clearDraft(), render()) }, 'Limpiar') : null, h('button', { class: 'primary', disabled: ui.busy, onclick: submit }, ui.busy ? 'Creando…' : 'Crear pedido')),
    h('span', { class: 'small muted' }, 'El pedido queda a tu nombre.'),
  );
}

function idleView(state) {
  if (ui.panel === 'order') return [orderForm()];
  const sched = state.schedule;
  const consent = consentCard(state);
  const perm = consent ? null : permissionCard(state);
  const summary = state.lastSummary;
  return [
    h('div', {}, h('strong', {}, `Hola, ${state.user?.name ?? ''}`), h('div', { class: 'status muted', style: 'font-weight:400' }, h('span', { class: 'dot' }), 'Sin turno activo: no se registra nada.')),
    state.endedRemotely ? h('div', { class: 'note warn' }, 'Tu turno anterior fue cerrado desde la plataforma o por falta de señal.') : null,
    h(
      'div',
      { class: 'card small' },
      h('span', {}, h('span', { class: 'muted' }, 'Línea: '), state.lines?.length ? state.lines.map((l) => l.label).join(', ') : 'sin asignar'),
      h('span', {}, h('span', { class: 'muted' }, 'Turno programado: '), sched ? `${sched.weekdays.map((d) => DAYS[d]).join(', ')} · ${sched.startTime}–${sched.endTime}` : 'sin programar'),
    ),
    consent,
    perm,
    h('button', { class: 'primary', disabled: ui.busy || Boolean(consent) || (Boolean(state.tools?.length) && !state.permissionsOk), onclick: () => send({ type: 'startShift' }) }, 'Iniciar turno'),
    h('button', { disabled: ui.busy, onclick: () => void openOrder() }, hasDraft() ? 'Continuar pedido' : 'Nuevo pedido'),
    summary
      ? h(
          'div',
          { class: 'card small' },
          h('strong', {}, 'Resumen de tu último turno'),
          h('span', {}, `Duración: ${duration(summary.durationMinutes * 60000)} · Pausas: ${duration(summary.breakMinutes * 60000)}`),
          h('span', {}, `Con actividad observada: ${duration(summary.observedMinutes * 60000)}`),
          h('span', { class: 'muted' }, 'El detalle completo está en la plataforma web, en «Mi turno».'),
        )
      : null,
  ];
}

function shiftView(state) {
  const shift = state.shift;
  const onBreak = state.openBreak;
  const out = [];

  out.push(
    h(
      'div',
      {},
      h('div', { class: 'status' }, h('span', { class: `dot ${onBreak ? 'warn' : 'ok'}` }), onBreak ? `En pausa · ${BREAK_LABEL[onBreak.reason] ?? onBreak.reason}` : 'Turno en curso'),
      h('div', { class: 'small muted' }, `Desde las ${time(shift.startedAt)} (${duration(Date.now() - new Date(shift.startedAt).getTime())})`),
    ),
  );

  if (onBreak) out.push(h('div', { class: 'note warn' }, `Pausa desde las ${time(onBreak.startedAt)}. Durante la pausa no se registra actividad.`));
  else if (!state.permissionsOk) out.push(permissionCard(state));
  else out.push(h('div', { class: 'note ok' }, `Registro activo solo en: ${state.tools.map((t) => t.name).join(', ')}. Se cuentan eventos, nunca lo que escribes.`));

  const pending = state.pendingMinutes ?? 0;
  if (state.lastSyncOk === false) {
    out.push(h('div', { class: 'note danger' }, `Sin conexión con el servidor. ${pending} min guardados en este equipo; se enviarán solos al reconectar.`, ' ', h('button', { class: 'link', onclick: () => send({ type: 'syncNow' }, { keepPanel: true }) }, 'Reintentar')));
  } else {
    out.push(h('div', { class: 'small muted' }, state.lastSyncAt ? `Última sincronización: ${ago(state.lastSyncAt)}` : 'Sincronizando…'));
  }

  if (ui.panel === 'pause') {
    const reason = h('select', {}, (state.breakReasons ?? Object.keys(BREAK_LABEL)).map((r) => h('option', { value: r }, BREAK_LABEL[r] ?? r)));
    out.push(
      h('div', { class: 'card' }, h('label', {}, 'Motivo de la pausa', reason), h('div', { class: 'row' }, h('button', { onclick: () => ((ui.panel = null), render()) }, 'Cancelar'), h('button', { class: 'primary', disabled: ui.busy, onclick: () => send({ type: 'startBreak', reason: reason.value }) }, 'Iniciar pausa'))),
    );
  } else if (ui.panel === 'incident') {
    const type = h('select', {}, Object.entries(INCIDENT_LABEL).map(([v, label]) => h('option', { value: v }, label)));
    const description = h('textarea', { maxlength: 1000, placeholder: 'Describe brevemente qué pasó' });
    out.push(
      h(
        'div',
        { class: 'card' },
        h('label', {}, 'Tipo de novedad', type),
        h('label', {}, 'Descripción', description),
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => ((ui.panel = null), render()) }, 'Cancelar'),
          h(
            'button',
            {
              class: 'primary',
              disabled: ui.busy,
              onclick: async () => {
                if (description.value.trim().length < 3) return void ((ui.error = 'Escribe una descripción.'), render());
                if (await send({ type: 'incident', incidentType: type.value, description: description.value.trim() })) {
                  ui.notice = 'Novedad registrada. Tu supervisor ya puede verla.';
                  render();
                }
              },
            },
            'Registrar',
          ),
        ),
      ),
    );
  } else if (ui.panel === 'order') {
    out.push(orderForm());
  } else if (ui.panel === 'end') {
    out.push(
      h('div', { class: 'card' }, h('strong', {}, '¿Finalizar el turno?'), h('span', { class: 'small muted' }, 'Se detendrá el registro y se generará tu resumen.'), h('div', { class: 'row' }, h('button', { onclick: () => ((ui.panel = null), render()) }, 'Cancelar'), h('button', { class: 'danger', disabled: ui.busy, onclick: () => send({ type: 'endShift' }) }, 'Finalizar turno'))),
    );
  } else {
    out.push(
      h('button', { class: 'primary', disabled: ui.busy, onclick: () => void openOrder() }, hasDraft() ? 'Continuar pedido' : 'Nuevo pedido'),
      h(
        'div',
        { class: 'row' },
        onBreak ? h('button', { disabled: ui.busy, onclick: () => send({ type: 'endBreak' }) }, 'Reanudar') : h('button', { disabled: ui.busy, onclick: () => ((ui.panel = 'pause'), render()) }, 'Pausa'),
        h('button', { disabled: ui.busy, onclick: () => ((ui.panel = 'incident'), render()) }, 'Reportar novedad'),
      ),
      h('button', { class: 'danger', disabled: ui.busy, onclick: () => ((ui.panel = 'end'), render()) }, 'Finalizar turno'),
    );
  }
  return out;
}

function render() {
  const { auth, state } = data;
  const signedIn = Boolean(auth?.token);
  document.getElementById('company').textContent = signedIn && state?.company ? `${state.company.name}${state.company.isDemo ? ' · DEMO' : ''}` : '';
  logoutBtn.hidden = !signedIn || Boolean(state?.shift);

  const body = !signedIn ? [loginView()] : !state?.company ? [h('p', { class: 'muted' }, 'Cargando…')] : state.shift ? shiftView(state) : idleView(state);
  app.replaceChildren(
    ...[ui.error ? h('div', { class: 'note danger', role: 'alert' }, ui.error) : null, ui.notice ? h('div', { class: 'note ok', role: 'status' }, ui.notice) : null, ...body.flat()].filter(Boolean),
  );
}

logoutBtn.addEventListener('click', () => send({ type: 'logout' }));
chrome.storage.onChanged.addListener((_changes, area) => {
  // No se vuelve a pintar mientras la persona escribe en un formulario abierto.
  if (area === 'local' && !ui.panel && !ui.busy && document.activeElement?.tagName !== 'INPUT' && !document.getElementById('consent-check')?.checked) load();
});
setInterval(() => !ui.panel && !ui.busy && document.activeElement?.tagName !== 'INPUT' && !document.getElementById('consent-check')?.checked && render(), 15000);

await load();
if (data.auth?.token) chrome.runtime.sendMessage({ type: 'refresh' }).then(load, () => {});
