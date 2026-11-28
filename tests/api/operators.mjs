import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 700)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && m !== 'DELETE' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && m !== 'DELETE' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const adm = await login('admin'), sup = await login('supervisora'), v1 = await login('vendedora1');
const order = async (name, phone) => (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] })).json;
const confirm = (id) => call('POST', `/api/hermes/orders/${id}/action`, sup, { action: 'confirmar' });
const get = async (id) => (await call('GET', `/api/hermes/orders/${id}`, sup)).json;

// Operadores: permisos y alta
check('vendedora no ve operadores', (await call('GET', '/api/hermes/operators', v1)).status === 403);
check('supervisora no crea operadores', (await call('POST', '/api/hermes/operators', sup, { name: 'Uno' })).status === 403);
let r = await call('POST', '/api/hermes/operators', adm, { name: 'Operador A', carrier: 'Interrapidísimo' });
check('admin crea operador A', r.status === 200 && r.json.id, r);
const A = r.json.id;
r = await call('POST', '/api/hermes/operators', adm, { name: 'Operador B' });
const B = r.json.id;
check('admin crea operador B', r.status === 200 && B, r);
check('nombre repetido → 400', (await call('POST', '/api/hermes/operators', adm, { name: 'operador a' })).status === 400);
r = await call('GET', '/api/hermes/operators', sup);
check('lista con dos operadores', r.json.operators?.length === 2 && r.json.unassignedToDispatch === 0, r.json);

// Pedidos
const o1 = await order('Ana Uno', '3005550001'), o2 = await order('Beto Dos', '3005550002'), o3 = await order('Caro Tres', '3005550003'), o4 = await order('Dani Cuatro', '3005550004');
const o5a = await order('Eva Cinco', '3005550005'), o5b = await order('Eva Cinco', '3005550005');
for (const o of [o1, o2, o5a, o5b, o4]) await confirm(o.id);
check('pedidos creados', [o1, o2, o3, o4, o5a, o5b].every((o) => o.id), [o1, o5b]);

// Asignación
check('vendedora no asigna', (await call('POST', '/api/hermes/orders/assign-operator', v1, { orderIds: [o1.id], operatorId: A })).status === 403);
r = await call('POST', '/api/hermes/orders/assign-operator', sup, { orderIds: [o1.id, o3.id], operatorId: A });
check('asigna dos pedidos a A', r.status === 200 && r.json.assigned === 2, r);
r = await call('POST', '/api/hermes/orders/assign-operator', sup, { orderIds: [o4.id], operatorId: B });
check('asigna uno a B', r.json.assigned === 1, r);
let d = await get(o1.id);
check('el pedido muestra su operador', d.order.operatorId === A && d.order.operatorName === 'Operador A' && d.events.some((e) => e.type === 'operador_asignado'), d.order);
r = await call('GET', `/api/hermes/orders?operator=${A}`, sup);
check('filtro por operador', r.json.orders?.length === 2 && r.json.orders.every((o) => o.operatorId === A), r.json.orders?.map((o) => o.code));
r = await call('GET', '/api/hermes/orders?operator=ninguno', sup);
check('filtro sin operador', r.json.orders?.length === 3, r.json.orders?.map((o) => o.code));
check('operador de otra empresa o inexistente → 404', (await call('POST', '/api/hermes/orders/assign-operator', sup, { orderIds: [o1.id], operatorId: '00000000-0000-4000-8000-000000000000' })).status === 404);
r = await call('GET', '/api/hermes/orders', v1);
check('la vendedora no recibe datos de operador', !JSON.stringify(r.json).includes('operator'), r.json);

// Guías en lote
const rows = [
  { phone: '300 555 0001', trackingNumber: '240000000001', operatorRef: 'A-77' },           // lista
  { phone: '3005550002', trackingNumber: '240000000002' },                                    // lista, sin operador previo
  { phone: '3005550003', trackingNumber: '240000000003' },                                    // aún sin confirmar
  { phone: '3005550004', trackingNumber: '240000000004' },                                    // asignado a B
  { phone: '3005550005', trackingNumber: '240000000005' },                                    // dos confirmados
  { phone: '3009999999', trackingNumber: '240000000006' },                                    // no existe
  { phone: '3005550001', trackingNumber: '240000000007' },                                    // repetido en el archivo
  { phone: '3005550002', trackingNumber: '' },                                                // sin guía
];
check('vendedora no sube guías', (await call('POST', '/api/hermes/guides/preview', v1, { operatorId: A, rows })).status === 403);
r = await call('POST', '/api/hermes/guides/preview', sup, { operatorId: A, rows });
const pv = r.json;
check('vista previa: 2 de 8', r.status === 200 && pv.total === 8 && pv.valid === 2, pv);
check('fila 1 lista con su pedido', pv.rows[0].ok && pv.rows[0].code === o1.code && pv.rows[0].carrier === 'Interrapidísimo', pv.rows[0]);
check('sin confirmar se explica', !pv.rows[2].ok && /confirmado/.test(pv.rows[2].detail), pv.rows[2]);
check('otro operador se rechaza', !pv.rows[3].ok && /otro operador/.test(pv.rows[3].detail), pv.rows[3]);
check('dos confirmados se rechaza', !pv.rows[4].ok && /2 pedidos/.test(pv.rows[4].detail), pv.rows[4]);
check('teléfono sin pedido', !pv.rows[5].ok && /No hay un pedido/.test(pv.rows[5].detail), pv.rows[5]);
check('repetido en el archivo', !pv.rows[6].ok && /repite/.test(pv.rows[6].detail), pv.rows[6]);
check('sin guía', !pv.rows[7].ok, pv.rows[7]);
check('la vista previa no despacha', (await get(o1.id)).order.status === 'confirmado');

r = await call('POST', '/api/hermes/guides', sup, { operatorId: A, rows });
check('despacha 2 y omite 6', r.status === 200 && r.json.dispatched?.length === 2 && r.json.skipped?.length === 6, r.json);
d = await get(o1.id);
check('pedido 1 despachado con guía, operador y referencia', d.order.status === 'despachado' && d.order.trackingNumber === '240000000001' && d.order.carrier === 'Interrapidísimo' && d.order.operatorId === A && d.order.operatorRef === 'A-77', d.order);
check('al cliente se le avisa la guía', d.messages.some((m) => m.direction === 'out' && m.body.includes('240000000001')), d.messages.map((m) => m.body));
d = await get(o2.id);
check('pedido 2 queda con el operador del archivo', d.order.status === 'despachado' && d.order.operatorId === A, d.order);
check('pedido de B intacto', (await get(o4.id)).order.status === 'confirmado');
r = await call('POST', '/api/hermes/guides/preview', sup, { operatorId: A, rows: [rows[0]] });
check('subir dos veces la misma guía no repite', r.json.valid === 0 && /ya tenía esta guía/.test(r.json.rows[0].detail), r.json);
r = await call('POST', '/api/hermes/orders/assign-operator', sup, { orderIds: [o1.id], operatorId: B });
check('no se reasigna un pedido ya despachado', r.json.assigned === 0 && r.json.skipped === 1, r.json);

// Despacho a mano con operador
r = await call('POST', `/api/hermes/orders/${o4.id}/action`, sup, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '240000000044' });
d = await get(o4.id);
check('despacho a mano conserva el operador asignado', r.status === 200 && d.order.status === 'despachado' && d.order.operatorId === B, d.order);
r = await call('POST', `/api/hermes/orders/${o5a.id}/action`, sup, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '240000000055', operatorId: B, operatorRef: 'B-9' });
d = await get(o5a.id);
check('despacho a mano eligiendo operador', r.status === 200 && d.order.operatorId === B && d.order.operatorRef === 'B-9', d.order);

// Edición y panel
r = await call('PATCH', `/api/hermes/operators/${B}`, adm, { name: 'Operador B', carrier: '', active: false });
check('admin desactiva B', r.status === 200, r);
check('no se asigna a un operador desactivado', (await call('POST', '/api/hermes/orders/assign-operator', sup, { orderIds: [o3.id], operatorId: B })).status === 400);
r = await call('GET', '/api/hermes/operators', sup);
const a = r.json.operators.find((x) => x.id === A);
check('conteos por operador', a.onTheWay === 2 && a.toDispatch === 0, r.json);
r = await call('GET', '/api/hermes/panel', sup);
check('panel por operador', r.json.byOperator?.length === 2 && r.json.byOperator.find((x) => x.name === 'Operador A')?.total === 3, r.json.byOperator);
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
