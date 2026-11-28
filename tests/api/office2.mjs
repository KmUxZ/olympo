import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 600)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const adm = await login('admin'), sup = await login('supervisora'), v1 = await login('vendedora1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (await call('POST', '/api/hermes/operators', adm, { name: 'Hoko', carrier: 'Hoko' })).json.id;
await call('POST', `/api/hermes/operators/${H}/connect`, adm, { driver: 'hoko' });
const hookPath = new URL((await call('GET', '/api/hermes/operators', adm)).json.operators[0].webhookUrl).pathname;
const hook = async (body) => { await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); await sleep(400); };
const order = async (name, phone) => { const o = (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] })).json; await call('POST', `/api/hermes/orders/${o.id}/action`, sup, { action: 'confirmar' }); return o; };
const office = async () => (await call('GET', '/api/hermes/office', sup)).json.orders;

check('vendedora no ve la bandeja', (await call('GET', '/api/hermes/office', v1)).status === 403);
check('bandeja vacía al empezar', (await office()).length === 0);
const a = await order('Ana Uno', '3009990001'), b = await order('Beto Dos', '3009990002'), c = await order('Caro Tres', '3009990003');
await hook({ order_id: 7001, number: 'HK7001', last_state: 10, phone: '3009990001' });
await hook({ order_id: 7002, number: 'HK7002', last_state: 10, phone: '3009990002' });
await hook({ order_id: 7003, number: 'HK7003', last_state: 2, phone: '3009990003' });
let rows = await office();
check('entran los dos que están en oficina, no el que va en camino', rows.length === 2 && rows.every((r) => r.since && r.trackingNumber.startsWith('HK70') && r.operatorName === 'Hoko'), rows);
check('sin respuesta ni gestión todavía', rows.every((r) => r.lastAnswer === null && r.note === null));
// Gestión
check('vendedora no registra gestión', (await call('POST', `/api/hermes/orders/${a.id}/office-note`, v1, { note: 'x' })).status === 403);
let r = await call('POST', `/api/hermes/orders/${a.id}/office-note`, sup, { note: 'Lo llamé: va a pasar mañana' });
rows = await office();
const ra = rows.find((x) => x.id === a.id);
check('la gestión queda con quién y cuándo', r.status === 200 && ra.note === 'Lo llamé: va a pasar mañana' && ra.noteBy === 'Supervisora Demo' && Boolean(ra.noteAt), ra);
const d = (await call('GET', `/api/hermes/orders/${a.id}`, sup)).json;
check('queda en el historial del pedido', d.events.some((e) => e.type === 'oficina_gestion' && e.detail.includes('va a pasar mañana')), d.events.map((e) => e.type));
// Sale de la bandeja cuando cambia el estado
await hook({ order_id: 7001, number: 'HK7001', last_state: 3 });
await hook({ order_id: 7002, number: 'HK7002', last_state: 7 });
rows = await office();
check('entregado y vuelto a reparto salen de la bandeja', rows.length === 0, rows);
// Marcar a mano (operador sin avisos)
await call('POST', `/api/hermes/orders/${c.id}/action`, sup, { action: 'en_reparto' });
const m = await order('Dani Cuatro', '3009990004');
await call('POST', `/api/hermes/orders/${m.id}/action`, sup, { action: 'despachar', carrier: 'Otra', trackingNumber: 'X123' });
r = await call('POST', `/api/hermes/orders/${m.id}/office`, sup, {});
rows = await office();
check('marcado a mano entra a la bandeja y avisa al cliente', r.status === 200 && rows.length === 1 && rows[0].id === m.id, { r, rows });
const n = await order('Eva Cinco', '3009990005');
check('no se puede marcar en oficina un pedido sin despachar', (await call('POST', `/api/hermes/orders/${n.id}/office`, sup, {})).status === 400);
await call('POST', `/api/hermes/orders/${m.id}/action`, sup, { action: 'devuelto' });
check('devuelto sale de la bandeja', (await office()).length === 0);
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
