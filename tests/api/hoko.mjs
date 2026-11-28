import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 700)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && m !== 'DELETE' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && m !== 'DELETE' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const adm = await login('admin'), sup = await login('supervisora');
const order = async (name, phone) => (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] })).json;
const confirm = (id) => call('POST', `/api/hermes/orders/${id}/action`, sup, { action: 'confirmar' });
const get = async (id) => (await call('GET', `/api/hermes/orders/${id}`, sup)).json;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let r = await call('POST', '/api/hermes/operators', adm, { name: 'Hoko', carrier: 'Interrapidísimo' });
const H = r.json.id;
check('supervisora no conecta', (await call('POST', `/api/hermes/operators/${H}/connect`, sup, { driver: 'hoko' })).status === 403);
r = await call('GET', '/api/hermes/operators', adm);
check('sin conectar no hay dirección', r.json.operators[0].webhookUrl === null && r.json.operators[0].driver === 'manual', r.json);
r = await call('POST', `/api/hermes/operators/${H}/connect`, adm, { driver: 'hoko' });
check('admin conecta Hoko', r.status === 200, r);
r = await call('GET', '/api/hermes/operators', adm);
const url = r.json.operators[0].webhookUrl;
check('admin ve la dirección de avisos', /\/api\/hermes\/webhook\/hoko\/[A-Za-z0-9_-]{30,}$/.test(url ?? ''), r.json);
check('supervisora no ve la dirección', (await call('GET', '/api/hermes/operators', sup)).json.operators[0].webhookUrl === null);
const path = new URL(url).pathname;
const hook = async (body, type = 'json') => {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }, body: type === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString() });
  await sleep(350);
  return res.status;
};
const events = async () => (await call('GET', `/api/hermes/operators/${H}/events`, sup)).json.events;

check('clave falsa → 404', (await fetch(BASE + '/api/hermes/webhook/hoko/' + 'x'.repeat(43), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 404);
check('comprobación GET de la dirección', (await fetch(BASE + path)).status === 200);
check('formulario en otra ruta sigue rechazado', (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' })).status === 415);

const o1 = await order('Ana Uno', '3005551001'), o2 = await order('Beto Dos', '3005551002'), o3 = await order('Caro Tres', '3005551003');
const o4a = await order('Dani Cuatro', '3005551004'), o4b = await order('Dani Cuatro', '3005551004'), o5 = await order('Eva Cinco', '3005551005'), o6 = await order('Fede Seis', '3005551006');
for (const o of [o1, o2, o4a, o4b, o5, o6]) await confirm(o.id);

// Pedido 1: ciclo completo
check('aviso aceptado', (await hook({ order_id: 9001, guide_id: 1, number: '240000009001', last_state: 1, last_state_name: 'Activa', customer_name: 'Ana Uno', phone: '3005551001', guide_histories: [] })) === 200);
let d = await get(o1.id);
check('guía generada: enlaza y despacha de una vez', d.order.status === 'despachado' && d.order.operatorRef === '9001' && d.order.operatorName === 'Hoko' && d.order.trackingNumber === '240000009001', d.order);
await hook({ order_id: 9001, number: '240000009001', last_state: 2, phone: '3005551001' });
d = await get(o1.id);
check('despachada: pedido despachado con guía', d.order.status === 'despachado' && d.order.trackingNumber === '240000009001' && d.order.carrier === 'Interrapidísimo', d.order);
check('el cliente recibe la guía una vez', d.messages.filter((m) => m.direction === 'out' && m.body.includes('240000009001')).length === 1, d.messages.map((m) => m.body));
const before = d.messages.length;
await hook({ order_id: 9001, number: '240000009001', last_state: 2, phone: '3005551001' });
await hook({ order_id: 9001, number: '240000009001', last_state: 9, phone: '3005551001' });
d = await get(o1.id);
check('aviso repetido y tránsito no repiten mensajes', d.messages.length === before && d.order.status === 'despachado', d.messages.length);
await hook({ order_id: 9001, number: '240000009001', last_state: 7 });
check('en reparto (sin teléfono, por número de orden)', (await get(o1.id)).order.status === 'en_reparto');
await hook({ order_id: 9001, number: '240000009001', last_state: 6, guide_histories: [{ state: '6', description: 'Dirección incorrecta', created_at: '2026-11-26 10:00:00' }] });
d = await get(o1.id);
check('novedad con su tipo', d.order.status === 'novedad' && d.incidents.length === 1 && d.incidents[0].type === 'direccion', d.incidents);
await hook({ order_id: 9001, number: '240000009001', last_state: 3 });
check('entregada', (await get(o1.id)).order.status === 'entregado');
await hook({ order_id: 9001, number: '240000009001', last_state: 11 });
check('pedido cerrado no se reabre', (await get(o1.id)).order.status === 'entregado');

// Pedido 2: llega directo en reparto, como formulario, y luego devolución
await hook({ order_id: '9002', number: '240000009002', last_state: '7', phone: '+57 300 555 1002' }, 'form');
d = await get(o2.id);
check('formulario: despacha y pasa a reparto', d.order.status === 'en_reparto' && d.order.trackingNumber === '240000009002', d.order);
await hook({ order_id: 9002, number: '240000009002', last_state: 19 });
d = await get(o2.id);
check('tránsito de devolución: pide atención, sin cerrar', d.order.status === 'en_reparto' && d.order.attention === true, d.order);
await hook({ order_id: 9002, number: '240000009002', last_state: 20 });
check('devolución', (await get(o2.id)).order.status === 'devuelto');

// Reclamar en oficina: en modo simulado el aviso sale y no pide atención
const o7 = await order('Gina Siete', '3005551007'); await confirm(o7.id);
await hook({ order_id: 9007, number: '240000009007', last_state: 10, phone: '3005551007' });
d = await get(o7.id);
check('reclamar en oficina: despacha y avisa al cliente', d.order.status === 'despachado' && d.order.attention === false && d.messages.some((m) => m.direction === 'out' && m.template === 'hermes_oficina' && m.body.includes('oficina de Interrapidísimo en Cali') && m.body.includes('240000009007')) && d.events.some((e) => e.type === 'en_oficina'), d.messages.map((m) => m.body));
check('la guía va en lista', d.messages.some((m) => m.template === 'hermes_guia' && m.body.includes('🚚 Transportadora: Interrapidísimo') && m.body.includes('🔢 Guía: 240000009007')), d.messages.map((m) => m.body));
check('la confirmación va en lista', d.messages[0].body.includes('🛍️ Productos: 1 × Faja') && d.messages[0].body.includes('📍 Dirección: Calle 10 # 5-20') && d.messages[0].body.includes('💵 Total a pagar al recibir: $90.000'), d.messages[0].body);

// Casos que no deben tocar nada
await hook({ order_id: 9003, number: '240000009003', last_state: 2, phone: '3005551003' });
d = await get(o3.id);
check('sin confirmar: se despacha igual y recibe la guía', d.order.status === 'despachado' && d.order.trackingNumber === '240000009003' && d.messages.filter((m) => m.direction === 'out' && m.body.includes('240000009003')).length === 1, d.order);
await hook({ order_id: 9004, number: '240000009004', last_state: 2, phone: '3005551004' });
check('dos confirmados: no se toca ninguno', (await get(o4a.id)).order.status === 'confirmado' && (await get(o4b.id)).order.status === 'confirmado');
await hook({ order_id: 9099, number: '240000009099', last_state: 2, phone: '3009990000' });
await hook({ number: 'x', last_state: 2 });
await hook({ order_id: 9005, number: '', last_state: 2, phone: '3005551005' });
check('sin número de guía: enlaza pero no despacha', (await get(o5.id)).order.status === 'confirmado');
await hook({ order_id: 9006, number: '240000009006', last_state: 99, phone: '3005551006' });
check('estado desconocido se trata como en tránsito', (await get(o6.id)).order.status === 'despachado');

const ev = await events();
const by = (ref) => ev.find((e) => e.externalRef === ref);
check('registro: el sin confirmar quedó enlazado', /Despachado con la guía/.test(by('9003')?.result ?? '') && by('9003').code !== null, by('9003'));
check('registro: varios pedidos explicado', /2 pedidos/.test(by('9004')?.result ?? ''), by('9004'));
check('registro: teléfono sin pedido', /No hay un pedido/.test(by('9099')?.result ?? ''), by('9099'));
check('registro: aviso incompleto', ev.some((e) => /incompleto/.test(e.result)), ev.slice(0, 3));
r = await call('GET', '/api/hermes/operators', adm);
check('conteo de avisos sin pedido y último aviso', r.json.operators[0].unmatched === 3 && r.json.operators[0].lastEventAt, r.json.operators[0]);

// Desconectar
r = await call('POST', `/api/hermes/operators/${H}/connect`, adm, { driver: 'manual' });
check('desconectar invalida la dirección', r.status === 200 && (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 404);
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
