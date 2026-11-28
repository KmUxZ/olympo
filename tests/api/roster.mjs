import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (email) => (await call('POST', '/api/auth/login', null, { email, password: pass })).cookie;
const adm = await login('admin@demo.olympo.test');
const sel = await login('vendedora1@demo.olympo.test');
const add = (k, n) => new Date(new Date(`${k}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const utc = new Date().toISOString().slice(0, 10);
const range = `from=${add(utc, -3)}&to=${add(utc, 3)}`;

let r = await call('GET', `/api/argos/roster?${range}`, adm);
check('admin ve la malla vacía con las 3 vendedoras', r.status === 200 && r.json.people.length === 3 && r.json.entries.length === 0 && r.json.canEdit === true && r.json.people[0].schedule, r);
const today = r.json.today;
const [v1, v2, v3] = ['vendedora1', 'vendedora2', 'vendedora3'].map((n) => r.json.people.find((p) => p.email.startsWith(n)).id);

r = await call('PUT', '/api/argos/roster', adm, { entries: [
  { userId: v1, day: today, startTime: null, endTime: null },
  { userId: v2, day: today, startTime: '00:00', endTime: '23:59' },
  { userId: v3, day: add(today, 1), startTime: '10:00', endTime: '19:00' },
  { userId: v3, day: add(today, 2), remove: true },
] });
check('guarda varias celdas', r.status === 200 && r.json.saved === 4, r);
r = await call('GET', `/api/argos/roster?${range}`, adm);
check('la malla devuelve lo guardado', r.json.entries.length === 3 && r.json.entries.find((e) => e.userId === v1).startTime === null && r.json.entries.find((e) => e.userId === v3).startTime === '10:00', r.json.entries);

r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: v2, day: today, startTime: '00:00', endTime: '23:58' }] });
r = await call('GET', `/api/argos/roster?${range}`, adm);
check('guardar de nuevo reemplaza la celda', r.json.entries.length === 3 && r.json.entries.find((e) => e.userId === v2).endTime === '23:58', r.json.entries);

r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: v1, day: today, startTime: '08:00', endTime: null }] });
check('rechaza turno sin hora de fin', r.status === 400, r);
r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: v1, day: today, startTime: '08:00', endTime: '08:00' }] });
check('rechaza inicio igual a fin', r.status === 400, r);
r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: v1, day: '2026-02-31x', startTime: '08:00', endTime: '09:00' }] });
check('rechaza fecha mal escrita', r.status === 400, r);
r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: '00000000-0000-4000-8000-000000000000', day: today, startTime: '08:00', endTime: '09:00' }] });
check('rechaza persona que no es vendedora de la empresa', r.status === 400 && r.json.error?.code === 'persona_no_valida', r);

r = await call('GET', `/api/argos/roster?${range}`, sel);
check('la vendedora solo ve su propia malla y no puede editar', r.status === 200 && r.json.people.length === 1 && r.json.people[0].id === v1 && r.json.canEdit === false && r.json.entries.every((e) => e.userId === v1), r);
r = await call('PUT', '/api/argos/roster', sel, { entries: [{ userId: v1, day: today, startTime: '08:00', endTime: '09:00' }] });
check('la vendedora no puede cambiar la malla', r.status === 403, r);
r = await call('GET', `/api/argos/roster?from=${add(utc, -30)}&to=${add(utc, 30)}`, adm);
check('rechaza rangos de más de 42 días', r.status === 400, r);

r = await call('GET', '/api/argos/dashboard', adm);
const d1 = r.json.sellers.find((s) => s.user.id === v1), d2 = r.json.sellers.find((s) => s.user.id === v2);
check('tablero: descanso en la malla = hoy no está programada', r.status === 200 && d1.scheduledNow === false, d1);
check('tablero: el turno de la malla manda sobre el horario fijo', d2.scheduledNow === true && d2.schedule.startTime === '00:00' && d2.schedule.weekdays.length === 1, d2);

r = await call('GET', '/api/argos/reports/attendance?days=14', adm);
const a1 = r.json.rows.find((x) => x.userId === v1).days.find((d) => d.day === today);
const a2 = r.json.rows.find((x) => x.userId === v2).days.find((d) => d.day === today);
check('cumplimiento: día de descanso no cuenta como programado', r.status === 200 && a1.scheduled === false, a1);
check('cumplimiento: usa las horas de la malla', a2.scheduled === true, a2);

r = await call('PUT', '/api/argos/roster', adm, { entries: [{ userId: v1, day: today, remove: true }] });
r = await call('GET', `/api/argos/roster?${range}`, adm);
check('quitar una celda la devuelve al horario fijo', r.json.entries.length === 2 && !r.json.entries.some((e) => e.userId === v1), r.json.entries);
r = await call('GET', '/api/audit', adm);
check('queda en auditoría', r.status === 200 && JSON.stringify(r.json).includes('turno.malla'), r.status);
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
