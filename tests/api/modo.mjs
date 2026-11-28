import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 700)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const adm = await login('admin'), sup = await login('supervisora');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const order = async (name, phone) => (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] })).json;
const get = async (id) => (await call('GET', `/api/hermes/orders/${id}`, sup)).json;
const reply = (id, b) => call('POST', `/api/hermes/orders/${id}/simulate-reply`, sup, b);
const outs = (d) => d.messages.filter((m) => m.direction === 'out');
const base = { reminderMinutes: [30, 180], escalateMinutes: 360, botName: 'Valentina', noReplyAction: 'persona' };
let s = (await call('GET', '/api/hermes/settings', adm)).json.settings;
check('por defecto la confirmación es obligatoria', s.confirmationMode === 'obligatoria', s);
check('modo inventado se rechaza', (await call('PUT', '/api/hermes/settings', adm, { ...base, confirmationMode: 'otra' })).status === 400);
check('guardar sin el modo no lo cambia', (await call('PUT', '/api/hermes/settings', adm, base)).status === 200 && (await call('GET', '/api/hermes/settings', adm)).json.settings.confirmationMode === 'obligatoria');

// Informativa
check('guarda el modo informativo', (await call('PUT', '/api/hermes/settings', adm, { ...base, confirmationMode: 'informativa' })).status === 200);
const a = await order('Ana Uno', '3006660001');
let d = await get(a.id);
check('nace confirmado y con el mensaje de datos', d.order.status === 'confirmado' && outs(d).length === 1 && outs(d)[0].buttons.length === 2 && outs(d)[0].template === 'hermes_pedido_recibido' && /no tienes que hacer nada/.test(outs(d)[0].body) && !/Me confirmas/.test(outs(d)[0].body), [d.order.status, outs(d)]);
await reply(a.id, { payload: 'CONFIRMAR' });
d = await get(a.id);
check('si confirma, se le agradece una vez', d.order.status === 'confirmado' && outs(d).length === 2 && /quedó confirmado/.test(outs(d)[1].body), outs(d).map((m) => m.body));
await reply(a.id, { text: 'Listo' });
await reply(a.id, { text: 'Ok perfecto! Gracias' });
d = await get(a.id);
check('un «listo» posterior no repite la confirmación', outs(d).filter((m) => /quedó confirmado/.test(m.body)).length === 1, outs(d).map((m) => m.body));
const b = await order('Beto Dos', '3006660002');
await reply(b.id, { payload: 'CANCELAR' });
check('puede cancelar aunque ya estuviera confirmado', (await get(b.id)).order.status === 'cancelado');
const c = await order('Caro Tres', '3006660003');
await reply(c.id, { payload: 'CORREGIR' });
await reply(c.id, { text: 'Carrera 7 # 45-10 apto 301 barrio Chapinero' });
d = await get(c.id);
check('puede corregir la dirección y sigue confirmado', d.order.status === 'confirmado' && d.order.address.includes('Carrera 7'), d.order);
// La guía sale sin que haya respondido
const H = (await call('POST', '/api/hermes/operators', adm, { name: 'Hoko', carrier: 'Hoko' })).json.id;
await call('POST', `/api/hermes/operators/${H}/connect`, adm, { driver: 'hoko' });
const hookPath = new URL((await call('GET', '/api/hermes/operators', adm)).json.operators[0].webhookUrl).pathname;
const e = await order('Dani Cuatro', '3006660004');
await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_id: 6001, number: 'HK6001', last_state: 5, phone: '3006660004' }) });
await sleep(500);
d = await get(e.id);
check('sin responder, recibe la guía al generarse', d.order.status === 'despachado' && outs(d).some((m) => m.body.includes('HK6001')), [d.order.status, outs(d).map((m) => m.body)]);
await reply(e.id, { payload: 'CONFIRMAR' });
d = await get(e.id);
check('confirmar después de despachado no lo devuelve de estado', d.order.status === 'despachado', d.order.status);

// Ninguna
await call('PUT', '/api/hermes/settings', adm, { ...base, confirmationMode: 'ninguna' });
const g = await order('Eva Cinco', '3006660005');
d = await get(g.id);
check('sin mensaje: nace confirmado y no se le escribe', d.order.status === 'confirmado' && outs(d).length === 0, [d.order.status, outs(d)]);
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
