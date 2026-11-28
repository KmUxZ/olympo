// Recorrido completo de un turno desde la extensión: aviso, inicio, actividad, pausa, cierre y lo que ve la supervisión.
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0, n = 0; const check = (name, c, x = '') => { n++; console.log(`${c ? 'OK  ' : 'FAIL'} ${name} ${c ? '' : JSON.stringify(x).slice(0, 400)}`); if (!c) f++; };
const call = async (m, p, auth, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(auth?.startsWith('olympo_session') ? { cookie: auth } : auth ? { authorization: `Bearer ${auth}` } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const ext = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass, client: 'extension' })).json.token;
const adm = (await call('POST', '/api/auth/login', null, { email: 'admin@demo.olympo.test', password: pass })).cookie;
const t1 = await ext('vendedora1'), t2 = await ext('vendedora2');
const minute = (ago) => new Date(Math.floor((Date.now() - ago * 60000) / 60000) * 60000).toISOString();

let r = await call('GET', '/api/argos/me/state', t1);
check('la extensión recibe su estado, con los productos de la empresa', r.status === 200 && r.json.shift === null && Array.isArray(r.json.company.products) && r.json.tools.length > 0, r.json);
const tool = r.json.tools[0].id, version = r.json.consent.version;
r = await call('POST', '/api/argos/shifts/start', t1);
check('sin aceptar el aviso no se puede iniciar turno', r.status === 403 && r.json.error?.code === 'consentimiento_requerido', r);
r = await call('POST', '/api/argos/consent', t1, { version });
check('acepta el aviso de qué se registra', r.status === 200 && r.json.consent.accepted, r);
r = await call('POST', '/api/argos/shifts/start', t1);
const shift = r.json.shift?.id;
check('inicia turno', r.status === 200 && shift && r.json.alreadyActive === false, r);
r = await call('POST', '/api/argos/shifts/start', t1);
check('iniciar dos veces no crea dos turnos', r.status === 200 && r.json.alreadyActive === true && r.json.shift.id === shift, r);
r = await call('GET', '/api/argos/extension/status', adm.replace(/.*/, adm));
r = await call('POST', `/api/argos/shifts/${shift}/sync`, t1, { sentAt: new Date().toISOString(), minutes: [
  { minute: minute(0), systemState: 'active', tools: [{ toolId: tool, focusSeconds: 60, activeSeconds: 40, keys: 30, clicks: 5, scrolls: 2 }] },
  { minute: minute(1), systemState: 'active', tools: [] },
] });
check('sincroniza minutos de actividad', r.status === 200, r);
r = await call('POST', `/api/argos/shifts/${shift}/sync`, t1, { sentAt: new Date().toISOString(), minutes: [{ minute: minute(0), systemState: 'active', tools: [{ toolId: tool, focusSeconds: 60, activeSeconds: 40, keys: 30, clicks: 5, scrolls: 2 }] }] });
check('reenviar el mismo minuto no duplica', r.status === 200, r);
r = await call('POST', `/api/argos/shifts/${shift}/sync`, t2, { sentAt: new Date().toISOString(), minutes: [{ minute: minute(1), systemState: 'active', tools: [] }] });
check('otra vendedora no puede enviar datos a este turno', r.status === 403, r);
r = await call('POST', `/api/argos/shifts/${shift}/end`, t2);
check('otra vendedora no puede cerrar este turno', r.status === 403, r);
r = await call('GET', `/api/argos/shifts/${shift}`, t2);
check('otra vendedora no puede ver este turno', r.status === 403, r);
r = await call('POST', `/api/argos/shifts/${shift}/sync`, t1, { sentAt: new Date().toISOString(), minutes: [{ minute: minute(1), systemState: 'active', tools: [{ toolId: tool, focusSeconds: 999999, activeSeconds: -5, keys: 1, clicks: 1, scrolls: 1 }] }] });
check('rechaza valores imposibles en la sincronización', r.status === 400, r);

r = await call('GET', '/api/argos/dashboard', adm);
const row = r.json.sellers.find((s) => s.shift?.id === shift);
check('el tablero muestra el turno con su actividad', r.status === 200 && row && row.observedMinutes === 1 && row.state !== 'fuera_de_turno', row);
check('el tablero no expone conteos de teclas ni clics', !/keyCount|clickCount|"keys"|"clicks"/.test(JSON.stringify(r.json)), '');
const sup = (await call('POST', '/api/auth/login', null, { email: 'supervisora@demo.olympo.test', password: pass })).cookie;
r = await call('GET', `/api/argos/shifts/${shift}`, sup);
check('la supervisora ve el turno sin conteos de teclas ni clics', r.status === 200 && r.json.summary.countsHidden === true && !/keyCount|clickCount|scrollCount/.test(JSON.stringify(r.json)), Object.keys(r.json.summary ?? {}));
r = await call('GET', `/api/argos/shifts/${shift}/minutes`, sup);
check('el detalle por minuto para la supervisora tampoco trae conteos', r.status === 200 && !/"keys"|"clicks"|keyCount|clickCount/.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 300));

r = await call('POST', `/api/argos/shifts/${shift}/breaks`, t1, { reason: 'almuerzo' });
check('inicia una pausa', r.status === 200 && r.json.openBreak, r);
r = await call('GET', '/api/argos/dashboard', adm);
check('el tablero la muestra en pausa', r.json.sellers.find((s) => s.shift?.id === shift)?.state === 'en_pausa', r.json.sellers.map((s) => s.state));
r = await call('POST', `/api/argos/shifts/${shift}/breaks/end`, t1);
check('reanuda', r.status === 200 && r.json.openBreak === null, r);
r = await call('POST', '/api/argos/incidents', t1, { type: 'conexion', description: 'Se cayó el internet' });
check('reporta una novedad', r.status === 200, r);
r = await call('POST', `/api/argos/shifts/${shift}/end`, t1);
check('finaliza el turno y recibe su resumen', r.status === 200 && r.json.shift.status === 'ended' && r.json.summary, r);
r = await call('GET', '/api/argos/me/state', t1);
check('queda sin turno activo', r.status === 200 && r.json.shift === null, r.json.shift);
r = await call('GET', `/api/argos/shifts?userId=${row.user.id}`, adm);
check('el turno aparece en el historial', r.status === 200 && r.json.shifts.some((s) => s.id === shift && s.status === 'ended'), r.json.shifts?.length);
const today = (await call('GET', '/api/argos/roster?from=2026-01-01&to=2026-01-02', adm)).json.today;
r = await call('GET', `/api/argos/roster?from=${today}&to=${today}`, adm);
check('la malla muestra la hora real de inicio', r.status === 200 && r.json.worked.some((w) => w.userId === row.user.id && /^\d\d:\d\d$/.test(w.firstStart)), r.json.worked);
r = await call('POST', '/api/auth/logout', t1);
check('al cerrar sesión el token de la extensión deja de servir', r.status === 200 && (await call('GET', '/api/argos/me/state', t1)).status === 401, r);
console.log(f ? `\n${f} FALLOS de ${n}` : `\nTODO OK (${n} comprobaciones)`); process.exit(f ? 1 : 0);
