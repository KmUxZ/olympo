import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 600)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const sup = await login('supervisora'), v1 = await login('vendedora1'), v2 = await login('vendedora2');
const body = (name, phone) => ({ customerName: name, phone, address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] });
const SECRET = ['status', 'trackingNumber', 'carrier', 'customerRisk', 'attention', 'attentionReason', 'deliveredAt', 'returnedAt', 'awaiting', 'addressCheck', 'cancelReason', 'sellerName'];

// La vendedora 1 sube dos pedidos; la 2, uno; la supervisora, uno sin atribuir.
let r = await call('POST', '/api/hermes/orders', v1, body('Ana Uno', '3010000001'));
check('vendedora crea pedido y la respuesta no trae riesgo ni duplicados', r.status === 200 && r.json.code && !('customerRisk' in r.json) && !('possibleDuplicateOf' in r.json), r);
const a = r.json.id;
const b = (await call('POST', '/api/hermes/orders', v1, body('Beto Dos', '3010000002'))).json.id;
const c = (await call('POST', '/api/hermes/orders', v2, body('Caro Tres', '3010000003'))).json.id;
await call('POST', '/api/hermes/orders', sup, body('Dora Cuatro', '3010000004'));

// Logística mueve el pedido A hasta entregado
await call('POST', `/api/hermes/orders/${a}/simulate-reply`, sup, { payload: 'CONFIRMAR' });
await call('POST', `/api/hermes/orders/${a}/action`, sup, { action: 'despachar', carrier: 'Envía', trackingNumber: 'G123456', trackingUrl: '' });
await call('POST', `/api/hermes/orders/${a}/action`, sup, { action: 'entregado' });

r = await call('GET', '/api/hermes/orders', v1);
check('solo ve sus pedidos', r.json.orders.length === 2 && r.json.orders.every((o) => [a, b].includes(o.id)), r.json.orders?.map((o) => o.customerName));
check('la lista no trae datos de logística', r.json.orders.every((o) => SECRET.every((k) => !(k in o))) && !('counts' in r.json), Object.keys(r.json.orders[0] ?? {}));
check('ni rastro de entregado o guía en la respuesta', !/entregado|G123456|Envía|despachado/i.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 300));
check('contadores propios', r.json.mine.total === 2 && r.json.mine.toFix === 0, r.json.mine);
r = await call('GET', `/api/hermes/orders/${a}`, v1);
check('el detalle tampoco: sin conversación, historial ni estado', r.status === 200 && !('messages' in r.json) && !('events' in r.json) && !('incidents' in r.json) && SECRET.every((k) => !(k in r.json.order)), Object.keys(r.json));
check('no abre pedidos de otra vendedora', (await call('GET', `/api/hermes/orders/${c}`, v1)).status === 403);
r = await call('POST', '/api/hermes/validate', v1, { phone: '3010000001', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali' });
check('validador sin historial del cliente para vendedora', r.json.history === null && r.json.address?.level, r.json);
r = await call('POST', '/api/hermes/validate', sup, { phone: '3010000001', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali' });
check('la supervisora sí ve el historial', r.json.history !== null, r.json);
check('vendedora sin panel, chats ni novedades', (await call('GET', '/api/hermes/panel', v1)).status === 403 && (await call('GET', '/api/hermes/chats', v1)).status === 403 && (await call('GET', '/api/hermes/incidents', v1)).status === 403);

// Correcciones
check('vendedora no puede corregir sin que se lo pidan', (await call('PUT', `/api/hermes/orders/${b}/correction`, v1, { customerName: 'Beto Dos', phone: '3010000002', address: 'Calle 10 # 5-20, barrio Centro', city: 'Cali' })).status === 400);
check('vendedora no pide correcciones', (await call('POST', `/api/hermes/orders/${b}/request-correction`, v1, { note: 'algo' })).status === 403);
check('no se pide corrección en pedido cerrado', (await call('POST', `/api/hermes/orders/${a}/request-correction`, sup, { note: 'dirección errada' })).status === 400);
r = await call('POST', `/api/hermes/orders/${b}/request-correction`, sup, { note: 'El cliente dice que la dirección es otra' });
check('supervisora pide corrección', r.status === 200, r);
r = await call('GET', '/api/hermes/orders', v1);
const ob = r.json.orders.find((o) => o.id === b);
check('la vendedora la ve primero y con la nota', r.json.orders[0].id === b && ob.needsCorrection === true && ob.correctionNote.includes('dirección es otra') && r.json.mine.toFix === 1, ob);
check('filtro por corregir', (await call('GET', '/api/hermes/orders?attention=1', v1)).json.orders.length === 1);
check('aviso en el menú de la vendedora', (await call('GET', '/api/argos/notifications', v1)).json.hermesAttention === 1, (await call('GET', '/api/argos/notifications', v1)).json);
check('otra vendedora no corrige el pedido ajeno', (await call('PUT', `/api/hermes/orders/${b}/correction`, v2, { customerName: 'Beto Dos', phone: '3010000002', address: 'Carrera 8 # 12-40, barrio Granada', city: 'Cali' })).status === 403);
r = await call('PUT', `/api/hermes/orders/${b}/correction`, v1, { customerName: 'Beto Dos', phone: '3010000002', address: 'por el parque', city: 'Cali' });
check('corrección con dirección incompleta se rechaza', r.status === 400 && r.json.error?.code === 'direccion_incompleta', r);
r = await call('PUT', `/api/hermes/orders/${b}/correction`, v1, { customerName: 'Beto Dos', phone: '3010000002', address: 'Carrera 8 # 12-40 apto 302, barrio Granada', city: 'Cali', notes: 'Portería' });
check('corrección válida', r.status === 200, r);
r = await call('GET', '/api/hermes/orders', v1);
check('queda como recibido y corregido', r.json.mine.toFix === 0 && r.json.orders.find((o) => o.id === b).needsCorrection === false && !!r.json.orders.find((o) => o.id === b).correctedAt && r.json.orders.find((o) => o.id === b).address.includes('Carrera 8'), r.json.orders.find((o) => o.id === b));
const d = (await call('GET', `/api/hermes/orders/${b}`, sup)).json;
check('logística ve la corrección y le toca revisarla', d.order.address.includes('Carrera 8') && d.order.attention === true && d.order.attentionReason.includes('corrigió') && d.events.some((e) => e.type === 'correccion_pedida') && d.events.some((e) => e.type === 'corregido' && e.detail.includes('dirección')), d.order);
check('se vuelve a pedir confirmación con los datos corregidos', d.messages.filter((m) => m.template === 'hermes_confirmacion').length === 2 && d.messages.at(-1).body.includes('Carrera 8'), d.messages.map((m) => m.template));
// Retirar una corrección
await call('POST', `/api/hermes/orders/${c}/request-correction`, sup, { note: 'revisar teléfono' });
check('retirar corrección', (await call('POST', `/api/hermes/orders/${c}/cancel-correction`, sup)).status === 200 && (await call('GET', '/api/hermes/orders', v2)).json.mine.toFix === 0);
const un = (await call('GET', '/api/hermes/orders?q=Dora', sup)).json.orders[0];
check('sin vendedora no se puede pedir corrección', (await call('POST', `/api/hermes/orders/${un.id}/request-correction`, sup, { note: 'revisar' })).status === 400);
check('la supervisora sigue viendo todo', (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 4 && 'status' in un && 'counts' in (await call('GET', '/api/hermes/orders', sup)).json);
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
