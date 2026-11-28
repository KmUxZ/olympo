import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 400)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const sup = (await call('POST', '/api/auth/login', null, { email: 'supervisora@demo.olympo.test', password: pass })).cookie;
const items = [{ name: 'Faja', qty: 1, price: 80000 }];
const get = async (id) => (await call('GET', `/api/hermes/orders/${id}`, sup)).json;
const act = (id, b) => call('POST', `/api/hermes/orders/${id}/action`, sup, b);
const reply = (id, b) => call('POST', `/api/hermes/orders/${id}/simulate-reply`, sup, b);

let v = (await call('POST', '/api/hermes/validate', sup, { address: 'Calle 10 barrio Centro', city: 'Cali', phone: '3001112233', customerName: 'Ana' })).json;
check('validación previa: dirección incompleta, nombre corto, cliente nuevo', v.address.level === 'incompleta' && v.contact.some((i) => i.code === 'nombre_incompleto') && v.history.risk === 'nuevo', v);
v = (await call('POST', '/api/hermes/validate', sup, { address: '', city: '', phone: '300', customerName: '' })).json;
check('no opina de lo que aún no se escribió', v.address === null && v.contact.length === 1 && v.contact[0].code === 'telefono_corto', v);

const rejected = await call('POST', '/api/hermes/orders', sup, { customerName: 'Ana Ruiz', phone: '3001112233', address: 'Calle 10 # 5-20', city: 'cali', items });
check('sin barrio NO se crea el pedido', rejected.status === 400 && rejected.json.error.code === 'direccion_incompleta' && rejected.json.error.message.includes('barrio'), rejected.json);
check('sin número tampoco', (await call('POST', '/api/hermes/orders', sup, { customerName: 'Ana Ruiz', phone: '3001112233', address: 'Calle 10', neighborhood: 'Centro', city: 'Cali', items })).status === 400);
check('nada quedó creado', (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 0);
const o1 = (await call('POST', '/api/hermes/orders', sup, { customerName: 'Ana Ruiz', phone: '3001112233', address: 'Calle 10 # 5-20', neighborhood: 'San Antonio', city: 'cali', items })).json;
let d = await get(o1.id);
check('con el barrio en su campo se crea, y normaliza la ciudad', o1.addressLevel === 'completa' && d.order.address === 'Calle 10 # 5-20, barrio San Antonio' && d.order.city === 'Cali' && d.order.department === 'Valle del Cauca', d.order);
// El cliente corrige con una dirección incompleta: el bot no la acepta y dice qué falta; a la segunda pasa a una persona
await reply(o1.id, { payload: 'CORREGIR' });
await reply(o1.id, { text: 'calle 20 con 5' });
d = await get(o1.id);
check('dirección incompleta del cliente: no se acepta y el bot dice qué falta', d.order.address.includes('Calle 10') && d.order.awaiting === 'direccion' && d.messages.at(-1).template === 'hermes_direccion_incompleta' && d.messages.at(-1).body.includes('me falta'), d.messages.at(-1));
await reply(o1.id, { text: 'la casa azul de la esquina' });
d = await get(o1.id);
check('segunda vez incompleta: pasa a una persona', d.order.attention === true && d.order.address.includes('Calle 10'), d.order);
await reply(o1.id, { text: 'Calle 20 # 5-11 barrio San Fernando' });
d = await get(o1.id);
check('cuando llega completa, se acepta', d.order.address.includes('Calle 20 # 5-11') && d.order.addressCheck.level === 'completa' && d.order.awaiting === 'confirmacion', d.order);
// Productos en texto libre
const free = (await call('POST', '/api/hermes/orders', sup, { customerName: 'Rosa Paz', phone: '3007776655', address: 'Carrera 5 # 10-20', neighborhood: 'El Prado', city: 'Barranquilla', items: [{ free: true, name: '2 fajas talla M negras y 1 crema reductora', qty: 1, price: 150000 }] })).json;
const fm = (await get(free.id)).messages[0].body;
check('productos en texto libre: se muestran tal cual', fm.includes('2 fajas talla M negras y 1 crema reductora') && !fm.includes('1 × 2 fajas') && fm.includes('$150.000'), fm);

// Historial: este cliente rechaza y se devuelve → el siguiente pedido sale como riesgo alto
await reply(o1.id, { payload: 'CONFIRMAR' });
await act(o1.id, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '111222', trackingUrl: '' });
await act(o1.id, { action: 'devuelto' });
v = (await call('POST', '/api/hermes/validate', sup, { address: 'Calle 10 # 5-20 barrio San Antonio', city: 'Cali', phone: '300 111 2233', customerName: 'Ana Ruiz' })).json;
check('validación avisa riesgo alto por historial', v.history.risk === 'alto' && v.history.returned === 1, v.history);
const o2 = (await call('POST', '/api/hermes/orders', sup, { customerName: 'Ana Ruiz', phone: '3001112233', address: 'Calle 10 # 5-20 barrio San Antonio', city: 'Cali', items })).json;
d = await get(o2.id);
check('pedido de cliente de riesgo queda para atención', o2.customerRisk === 'alto' && d.order.attention && d.order.attentionReason.includes('riesgo'), d.order);
const good = (await call('POST', '/api/hermes/orders', sup, { customerName: 'Luis Mora', phone: '3009998877', address: 'Carrera 80 # 12-34 apto 501 barrio Laureles', city: 'Medellín', items })).json;
check('pedido con dirección completa no genera aviso', good.addressLevel === 'completa' && !(await get(good.id)).messages[0].body.includes('nos falta'));
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
