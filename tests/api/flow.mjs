// Prueba de extremo a extremo de la API contra una base TEMPORAL (no la de desarrollo).
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /Contraseña \(todas las cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${cond ? '' : extra}`); if (!cond) failures++; };

async function call(method, path, { token, cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const loginWeb = async (email, password = pass) => (await call('POST', '/api/auth/login', { body: { email, password } }));
const loginExt = async (email, password = pass) => (await call('POST', '/api/auth/login', { body: { email, password, client: 'extension' } }));

// 1. Admin crea usuaria, equipo, línea, turno
const admin = (await loginWeb('admin@demo.olympo.test')).cookie;
check('login admin', !!admin);
check('login con clave errónea → 401', (await loginWeb('admin@demo.olympo.test', 'x')).status === 401);
const teams = (await call('GET', '/api/teams', { cookie: admin })).json.teams;
const created = await call('POST', '/api/users', { cookie: admin, body: { name: 'Prueba Nueva', email: 'nueva@demo.olympo.test', role: 'seller', teamId: teams[0].id } });
check('admin crea usuaria', created.status === 200 && !!created.json.tempPassword, JSON.stringify(created.json));
const newId = created.json.user.id;
const line = await call('POST', '/api/argos/lines', { cookie: admin, body: { label: 'Línea prueba', channel: 'whatsapp', identifier: '+00 1', assignedUserId: newId } });
check('admin crea y asigna línea', line.status === 200, JSON.stringify(line.json));
const sched = await call('PUT', `/api/argos/schedules/${newId}`, { cookie: admin, body: { weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' } });
check('admin programa turno', sched.status === 200, JSON.stringify(sched.json));

// La extensión rechaza la contraseña temporal; la usuaria la cambia en la web
check('extensión exige cambio de contraseña', (await loginExt('nueva@demo.olympo.test', created.json.tempPassword)).status === 403);
const nw = (await loginWeb('nueva@demo.olympo.test', created.json.tempPassword)).cookie;
check('bloqueo hasta cambiar contraseña', (await call('GET', '/api/argos/me/state', { cookie: nw })).status === 403);
const ch = await call('POST', '/api/auth/change-password', { cookie: nw, body: { current: created.json.tempPassword, next: 'una-clave-larga-123' } });
check('cambio de contraseña', ch.status === 200, JSON.stringify(ch.json));

// 2. Vendedora inicia sesión en la extensión e inicia turno
const ext = (await loginExt('nueva@demo.olympo.test', 'una-clave-larga-123')).json.token;
check('login extensión', !!ext);
const state = (await call('GET', '/api/argos/me/state', { token: ext })).json;
check('estado: línea y herramientas', state.lines.length === 1 && state.tools.length === 2 && state.schedule, JSON.stringify(state));
// Antes de su primer turno la persona debe aceptar el aviso de qué se registra.
await call('POST', '/api/argos/consent', { token: ext, body: { version: state.consent.version } });
const start = await call('POST', '/api/argos/shifts/start', { token: ext, body: {} });
check('inicia turno', start.status === 200 && start.json.shift.status === 'active', JSON.stringify(start.json));
const again = await call('POST', '/api/argos/shifts/start', { token: ext, body: {} });
check('iniciar dos veces es idempotente', again.json.alreadyActive === true && again.json.shift.id === start.json.shift.id);
const sid = start.json.shift.id;

// 3. Sincronización (dos veces el mismo lote → sin duplicados)
const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
const batch = { sentAt: new Date().toISOString(), minutes: [{ minute, systemState: 'active', tools: [{ toolId: state.tools[0].id, focusSeconds: 40, activeSeconds: 25, keys: 120, clicks: 9, scrolls: 3 }] }] };
const s1 = await call('POST', `/api/argos/shifts/${sid}/sync`, { token: ext, body: batch });
check('sync', s1.status === 200 && s1.json.accepted === 1, JSON.stringify(s1.json));
await call('POST', `/api/argos/shifts/${sid}/sync`, { token: ext, body: { ...batch, sentAt: new Date().toISOString() } });
const raw = (await call('GET', `/api/argos/shifts/${sid}/minutes`, { token: ext })).json;
check('reenvío no duplica', raw.activity.length === 1 && raw.activity[0].keyCount === 120 && raw.presence.length === 1, JSON.stringify(raw));
const bogus = await call('POST', `/api/argos/shifts/${sid}/sync`, { token: ext, body: { sentAt: new Date().toISOString(), minutes: [{ minute: '2020-01-01T00:00:00Z', systemState: 'active', tools: [] }] } });
check('minutos fuera del turno se descartan', bogus.json.accepted === 0);

// 4. Supervisor ve el estado
const sup = (await loginWeb('supervisora@demo.olympo.test')).cookie;
let dash = (await call('GET', '/api/argos/dashboard', { cookie: sup })).json;
let row = dash.sellers.find((s) => s.user.id === newId);
check('dashboard: actividad observada', row?.state === 'actividad_observada' && row.lastTool === state.tools[0].name, JSON.stringify(row));
check('dashboard: demás fuera de turno', dash.counts.fuera_de_turno === 3 && dash.counts.enTurno === 1, JSON.stringify(dash.counts));

// 5. Pausa y novedad
const br = await call('POST', `/api/argos/shifts/${sid}/breaks`, { token: ext, body: { reason: 'almuerzo' } });
check('inicia pausa', br.status === 200 && br.json.openBreak.reason === 'almuerzo', JSON.stringify(br.json));
dash = (await call('GET', '/api/argos/dashboard', { cookie: sup })).json;
check('dashboard: en pausa', dash.sellers.find((s) => s.user.id === newId)?.state === 'en_pausa');
check('fin de pausa', (await call('POST', `/api/argos/shifts/${sid}/breaks/end`, { token: ext, body: {} })).status === 200);
const inc = await call('POST', '/api/argos/incidents', { token: ext, body: { type: 'conexion', description: 'Se cayó el internet 5 minutos' } });
check('vendedora registra novedad', inc.status === 200, JSON.stringify(inc.json));
check('vendedora no puede cambiar estado de novedad', (await call('PATCH', `/api/argos/incidents/${inc.json.id}`, { token: ext, body: { status: 'resuelta' } })).status === 403);
check('supervisora resuelve novedad', (await call('PATCH', `/api/argos/incidents/${inc.json.id}`, { cookie: sup, body: { status: 'resuelta', resolutionNote: 'ok' } })).status === 200);

// Permisos
const other = (await loginExt('vendedora1@demo.olympo.test')).json.token;
check('otra vendedora no ve el turno', (await call('GET', `/api/argos/shifts/${sid}`, { token: other })).status === 403);
check('vendedora no ve dashboard', (await call('GET', '/api/argos/dashboard', { token: other })).status === 403);
check('vendedora no ve usuarios', (await call('GET', '/api/users', { token: other })).status === 403);
check('supervisora no ve auditoría', (await call('GET', '/api/audit', { cookie: sup })).status === 403);
check('supervisora no crea usuarios', (await call('POST', '/api/users', { cookie: sup, body: { name: 'X Y', email: 'x@y.co', role: 'admin' } })).status === 403);
check('sin sesión → 401', (await call('GET', '/api/argos/dashboard')).status === 401);
check('vendedora solo ve sus turnos', (await call('GET', '/api/argos/shifts', { token: other })).json.shifts.length === 0);

// 6. Fin de turno y resumen
const end = await call('POST', `/api/argos/shifts/${sid}/end`, { token: ext, body: {} });
check('fin de turno con resumen', end.status === 200 && end.json.summary && end.json.summary.keyCount === 120 && end.json.summary.incidents === 1 && end.json.summary.breaks.length === 1, JSON.stringify(end.json));
console.log('   resumen:', JSON.stringify({ ...end.json.summary, timeline: end.json.summary.timeline }));
const detail = await call('GET', `/api/argos/shifts/${sid}`, { cookie: sup });
check('supervisora ve el resumen', detail.status === 200 && detail.json.summary.tools[0]?.name === state.tools[0].name, JSON.stringify(detail.json));
dash = (await call('GET', '/api/argos/dashboard', { cookie: sup })).json;
check('dashboard: feed con eventos', dash.feed.length >= 5, JSON.stringify(dash.feed));

// 7. Auditoría
const auditLog = (await call('GET', '/api/audit', { cookie: admin })).json.entries;
const actions = new Set(auditLog.map((e) => e.action));
for (const a of ['usuario.creado', 'linea.creada', 'turno.programacion', 'acceso.inicio', 'acceso.fallido', 'usuario.cambio_contrasena', 'novedad.estado'])
  check(`auditoría: ${a}`, actions.has(a));
check('no se puede desactivar al último admin', (await call('PATCH', `/api/users/${auditLog.find((e) => e.action === 'acceso.inicio' && e.actorName === 'Admin Demo') ? (await call('GET', '/api/auth/me', { cookie: admin })).json.user.id : ''}`, { cookie: admin, body: { status: 'disabled' } })).status === 400);

console.log(failures ? `\n${failures} FALLOS` : '\nTODO OK');
process.exit(failures ? 1 : 0);
