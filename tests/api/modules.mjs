// Prueba de los módulos (Alarmas, Reportes, Agenda, Mensajes, Acompañamiento, Calidad) contra una base TEMPORAL.
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : String(x).slice(0, 400)}`); if (!c) failures++; };
async function call(method, path, cookie, body) {
  const res = await fetch(BASE + path, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const admin = await login('admin'), sup = await login('supervisora'), v1 = await login('vendedora1'), v2 = await login('vendedora2');
const users = (await call('GET', '/api/users', admin)).json.users;
const id = (who) => users.find((u) => u.email === `${who}@demo.olympo.test`).id;
const teamId = users.find((u) => u.teamId).teamId;
const J = JSON.stringify;

// ───── Alarmas ─────
for (const who of ['vendedora1', 'vendedora2', 'vendedora3']) await call('PUT', `/api/argos/schedules/${id(who)}`, admin, { weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' });
const consent = (await call('GET', '/api/argos/me/state', v1)).json.consent.version;
await call('POST', '/api/argos/consent', v1, { version: consent });
const shift = (await call('POST', '/api/argos/shifts/start', v1)).json.shift;
let rules = (await call('GET', '/api/argos/alarms/rules', admin)).json.rules;
check('alarmas: 5 reglas con valores por defecto', rules.length === 5 && rules.every((r) => r.enabled), J(rules));
const setRules = (patch) => call('PUT', '/api/argos/alarms/rules', admin, { rules: rules.map((r) => ({ type: r.type, enabled: r.enabled, thresholdMinutes: r.thresholdMinutes, ...(patch[r.type] ?? {}) })) });
// Si es justo después de medianoche, el umbral de 1 min podría no cumplirse: se usa el mínimo.
check('alarmas: guardar reglas', (await setRules({ turno_no_iniciado: { thresholdMinutes: 1 } })).status === 200);
let alerts = (await call('GET', '/api/argos/alerts', sup)).json.alerts;
const notStarted = alerts.filter((a) => a.type === 'turno_no_iniciado').map((a) => a.userId);
check('alarmas: avisa de quien no inició (v2 y v3) y no de quien sí (v1)', notStarted.includes(id('vendedora2')) && notStarted.includes(id('vendedora3')) && !notStarted.includes(id('vendedora1')), J(alerts));
check('alarmas: vendedora no accede', (await call('GET', '/api/argos/alerts', v1)).status === 403);
check('alarmas: supervisora no cambia reglas', (await setRulesAs(sup)).status === 403);
async function setRulesAs(c) { return call('PUT', '/api/argos/alarms/rules', c, { rules: [{ type: 'sin_senal', enabled: false, thresholdMinutes: 5 }] }); }
let noti = (await call('GET', '/api/argos/notifications', sup)).json;
check('avisos: cuenta alertas abiertas', noti.openAlerts === 2, J(noti));
const a2 = alerts.find((a) => a.userId === id('vendedora2'));
check('alarmas: marcar enterado', (await call('POST', `/api/argos/alerts/${a2.id}/ack`, sup)).status === 200 && (await call('GET', '/api/argos/notifications', sup)).json.openAlerts === 1);
await call('POST', '/api/argos/consent', v2, { version: consent });
await call('POST', '/api/argos/shifts/start', v2);
await setRules({ turno_no_iniciado: { thresholdMinutes: 1 } });
alerts = (await call('GET', '/api/argos/alerts?state=all', sup)).json.alerts;
check('alarmas: se cierra sola cuando v2 inicia turno', !!alerts.find((a) => a.id === a2.id)?.resolvedAt && alerts.filter((a) => !a.resolvedAt).length === 1, J(alerts));
check('alarmas: desactivar regla cierra sus alertas', (await setRules({ turno_no_iniciado: { enabled: false } })).status === 200 && (await call('GET', '/api/argos/alerts', sup)).json.alerts.length === 0);

// ───── Reportes ─────
await call('POST', `/api/argos/shifts/${shift.id}/end`, v1);
const range = `from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`;
let rep = (await call('GET', `/api/argos/reports?${range}`, sup)).json;
check('reportes: por persona y por día', rep.byUser?.length === 2 && rep.byDay?.length >= 1 && rep.byUser.find((r) => r.userId === id('vendedora1')).shifts === 1 && rep.byUser.find((r) => r.userId === id('vendedora2')).openShifts === 1, J(rep));
check('reportes: sin conteos de teclas', !J(rep).includes('keyCount'));
check('reportes: filtro por persona', (await call('GET', `/api/argos/reports?${range}&userId=${id('vendedora1')}`, sup)).json.byUser.length === 1);
const line1 = (await call('GET', '/api/argos/lines', admin)).json.lines.find((l) => l.assignedUserId === id('vendedora1'));
check('reportes: filtro por línea', (await call('GET', `/api/argos/reports?${range}&lineId=${line1.id}`, sup)).json.byUser.map((r) => r.userId).join() === id('vendedora1'));
check('reportes: filtro por equipo', (await call('GET', `/api/argos/reports?${range}&teamId=${teamId}`, admin)).json.byUser.length === 2);
check('reportes: vendedora no accede', (await call('GET', `/api/argos/reports?${range}`, v1)).status === 403);

// ───── Agenda ─────
const at = new Date(Date.now() + 3600000).toISOString();
const agRange = `from=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`;
check('agenda: admin crea para toda la empresa', (await call('POST', '/api/argos/agenda', admin, { title: 'Reunión general', kind: 'reunion', startsAt: at })).status === 200);
check('agenda: supervisora no crea para toda la empresa', (await call('POST', '/api/argos/agenda', sup, { title: 'Para todos', kind: 'reunion', startsAt: at })).status === 403);
check('agenda: supervisora crea para su equipo', (await call('POST', '/api/argos/agenda', sup, { title: 'Capacitación', kind: 'actividad', startsAt: at, teamId })).status === 200);
check('agenda: supervisora crea para v1', (await call('POST', '/api/argos/agenda', sup, { title: 'Llamar cliente', kind: 'compromiso', startsAt: at, userId: id('vendedora1') })).status === 200);
const own = await call('POST', '/api/argos/agenda', v1, { title: 'Mi tarea', kind: 'tarea', startsAt: at, userId: id('vendedora2') });
let ag1 = (await call('GET', `/api/argos/agenda?${agRange}`, v1)).json.items;
let ag2 = (await call('GET', `/api/argos/agenda?${agRange}`, v2)).json.items;
check('agenda: lo que crea una vendedora es siempre para ella', own.status === 200 && ag1.find((i) => i.id === own.json.id)?.userId === id('vendedora1'));
check('agenda: v1 ve 4 (empresa, equipo, suyo, propio); v2 ve 2', ag1.length === 4 && ag2.length === 2, `${ag1.length}/${ag2.length}`);
check('agenda: v2 no puede tocar la tarea de v1', (await call('PATCH', `/api/argos/agenda/${own.json.id}`, v2, { status: 'hecha' })).status === 404);
check('agenda: v1 marca hecha', (await call('PATCH', `/api/argos/agenda/${own.json.id}`, v1, { status: 'hecha' })).status === 200);
check('agenda: pendientes de hoy', (await call('GET', '/api/argos/notifications', v1)).json.pendingToday === 3, J((await call('GET', '/api/argos/notifications', v1)).json));
check('agenda: v2 no borra lo de otro', (await call('DELETE', `/api/argos/agenda/${own.json.id}`, v2)).status === 403);

// ───── Mensajes ─────
const rec1 = (await call('GET', '/api/argos/messages/recipients', v1)).json;
check('mensajes: vendedora solo puede escribir a supervisión y administración', rec1.users.every((u) => u.role !== 'seller') && rec1.teams.length === 0 && !rec1.canAll, J(rec1));
check('mensajes: v1 → supervisora', (await call('POST', '/api/argos/messages', v1, { body: 'Hola, tengo una duda', toUserId: id('supervisora') })).status === 200);
check('mensajes: v1 → v2 rechazado', (await call('POST', '/api/argos/messages', v1, { body: 'hola', toUserId: id('vendedora2') })).status === 403);
check('mensajes: v1 no escribe a toda la empresa', (await call('POST', '/api/argos/messages', v1, { body: 'hola', toAll: true })).status === 403);
check('mensajes: supervisora → su equipo', (await call('POST', '/api/argos/messages', sup, { body: 'Recuerden la capacitación', toTeamId: teamId })).status === 200);
check('mensajes: admin → toda la empresa', (await call('POST', '/api/argos/messages', admin, { body: 'Bienvenidas', toAll: true })).status === 200);
check('mensajes: dos destinatarios se rechaza', (await call('POST', '/api/argos/messages', admin, { body: 'x', toAll: true, toTeamId: teamId })).status === 400);
check('mensajes: v2 tiene 2 sin leer; supervisora 2', (await call('GET', '/api/argos/notifications', v2)).json.unreadMessages === 2 && (await call('GET', '/api/argos/notifications', sup)).json.unreadMessages === 2);
const m2 = (await call('GET', '/api/argos/messages', v2)).json.messages;
check('mensajes: v2 no ve el directo de v1', m2.length === 2 && !m2.some((m) => m.body.includes('duda')), J(m2.map((m) => m.body)));
await call('POST', '/api/argos/messages/read', v2);
check('mensajes: marcar leídos', (await call('GET', '/api/argos/notifications', v2)).json.unreadMessages === 0 && (await call('GET', '/api/argos/messages', v2)).json.messages.every((m) => m.read));

// ───── Acompañamiento ─────
const sess = await call('POST', '/api/argos/coaching', sup, { userId: id('vendedora1'), heldAt: new Date().toISOString(), topic: 'Seguimiento semanal', notes: 'Buen avance', commitments: [{ text: 'Responder en menos de 5 min', dueDate: '2026-12-01' }, { text: 'Usar el guion de cierre' }] });
check('acompañamiento: supervisora crea sesión con compromisos', sess.status === 200, J(sess.json));
check('acompañamiento: vendedora no crea', (await call('POST', '/api/argos/coaching', v1, { userId: id('vendedora1'), heldAt: new Date().toISOString(), topic: 'x x' })).status === 403);
const c1 = (await call('GET', '/api/argos/coaching', v1)).json.sessions;
check('acompañamiento: v1 ve la suya con 2 compromisos; v2 no ve nada', c1.length === 1 && c1[0].commitments.length === 2 && (await call('GET', '/api/argos/coaching', v2)).json.sessions.length === 0);
check('acompañamiento: v1 no cambia el compromiso', (await call('PATCH', `/api/argos/coaching/commitments/${c1[0].commitments[0].id}`, v1, { status: 'cumplido' })).status === 403);
check('acompañamiento: supervisora lo marca cumplido', (await call('PATCH', `/api/argos/coaching/commitments/${c1[0].commitments[0].id}`, sup, { status: 'cumplido' })).status === 200);

// ───── Calidad ─────
check('calidad: sin criterios no se evalúa', (await call('POST', '/api/argos/quality/evaluations', sup, { userId: id('vendedora1'), scores: [{ criterionId: id('vendedora1'), score: 3 }] })).status === 400);
check('calidad: supervisora no crea criterios', (await call('POST', '/api/argos/quality/criteria', sup, { name: 'Saludo' })).status === 403);
const k1 = (await call('POST', '/api/argos/quality/criteria', admin, { name: 'Saludo y cordialidad', weight: 2 })).json.id;
const k2 = (await call('POST', '/api/argos/quality/criteria', admin, { name: 'Cierre', weight: 1 })).json.id;
check('calidad: falta una nota → rechazo', (await call('POST', '/api/argos/quality/evaluations', sup, { userId: id('vendedora1'), scores: [{ criterionId: k1, score: 5 }] })).status === 400);
const ev = await call('POST', '/api/argos/quality/evaluations', sup, { userId: id('vendedora1'), reference: 'Conversación del 21/11', feedback: 'Mejorar el cierre', scores: [{ criterionId: k1, score: 5 }, { criterionId: k2, score: 2 }] });
check('calidad: nota ponderada 80', ev.status === 200 && ev.json.total === 80, J(ev.json));
const e1 = (await call('GET', '/api/argos/quality/evaluations', v1)).json.evaluations;
check('calidad: v1 ve la suya; v2 ninguna', e1.length === 1 && e1[0].scores.length === 2 && (await call('GET', '/api/argos/quality/evaluations', v2)).json.evaluations.length === 0);
check('calidad: v2 no confirma lectura ajena', (await call('POST', `/api/argos/quality/evaluations/${e1[0].id}/ack`, v2)).status === 403);
check('calidad: v1 confirma lectura', (await call('POST', `/api/argos/quality/evaluations/${e1[0].id}/ack`, v1)).status === 200 && !!(await call('GET', '/api/argos/quality/evaluations', sup)).json.evaluations[0].acknowledgedAt);
await call('PATCH', `/api/argos/quality/criteria/${k2}`, admin, { name: 'Cierre', weight: 9 });
check('calidad: cambiar criterios no altera evaluaciones pasadas', (await call('GET', '/api/argos/quality/evaluations', sup)).json.evaluations[0].total === 80);

console.log(failures ? `\n${failures} FALLOS` : '\nTODO OK');
process.exit(failures ? 1 : 0);
