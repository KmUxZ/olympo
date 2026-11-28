// Prueba de Hermes de punta a punta contra una base TEMPORAL (modo simulado).
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); if (!c) failures++; };
async function call(method, path, cookie, body) {
  const res = await fetch(BASE + path, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const admin = await login('admin'), sup = await login('supervisora'), v1 = await login('vendedora1'), v2 = await login('vendedora2');
const base = { customerName: 'Laura Gómez', address: 'Calle 10 # 5-20, barrio Centro', city: 'Cali', items: [{ name: 'Faja reductora', qty: 2, price: 45000 }, { name: 'Crema', qty: 1, price: 30000 }] };
const get = async (id, c = sup) => (await call('GET', `/api/hermes/orders/${id}`, c)).json;
const reply = (id, body) => call('POST', `/api/hermes/orders/${id}/simulate-reply`, sup, body);
const act = (id, body, c = sup) => call('POST', `/api/hermes/orders/${id}/action`, c, body);
const lastOut = (d) => d.messages.filter((m) => m.direction === 'out').at(-1);

// ── 1. Camino feliz: crear → confirmar → despachar → reparto → entregado
const o1 = await call('POST', '/api/hermes/orders', v1, { ...base, phone: '300 123 4567' });
check('vendedora crea pedido', o1.status === 200 && o1.json.code === 'H-000001', o1.json);
let d = await get(o1.json.id);
check('total calculado, teléfono normalizado y atribuido a la vendedora', d.order.total === 120000 && d.order.phone === '573001234567' && d.order.sellerName === 'Vendedora Demo 1', d.order);
check('el bot pide confirmación con 3 botones', d.order.status === 'por_confirmar' && lastOut(d).template === 'hermes_confirmacion' && lastOut(d).buttons.length === 3 && lastOut(d).body.includes('$120.000') && lastOut(d).status === 'simulado', lastOut(d));
await reply(o1.json.id, { payload: 'CONFIRMAR' });
d = await get(o1.json.id);
check('cliente confirma con el botón', d.order.status === 'confirmado' && !!d.order.confirmedAt && lastOut(d).template === 'hermes_confirmado', d.order);
check('no se puede despachar sin datos de guía', (await act(o1.json.id, { action: 'despachar', carrier: 'X' })).status === 400);
check('despachar envía la guía', (await act(o1.json.id, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '240001234567', trackingUrl: 'https://rastreo.ejemplo.co/240001234567' })).status === 200);
d = await get(o1.json.id);
check('mensaje de guía con número, sin enlace si no hay cuenta del operador', d.order.status === 'despachado' && lastOut(d).body.includes('240001234567') && !lastOut(d).body.includes('http'), lastOut(d));
await act(o1.json.id, { action: 'en_reparto' });
d = await get(o1.json.id);
check('aviso de reparto con el valor a pagar', d.order.status === 'en_reparto' && lastOut(d).body.includes('$120.000'), lastOut(d));
await act(o1.json.id, { action: 'entregado' });
d = await get(o1.json.id);
check('entregado', d.order.status === 'entregado' && lastOut(d).template === 'hermes_entregado' && d.events.some((e) => e.type === 'entregado'), d.order);
check('una acción fuera de orden se rechaza', (await act(o1.json.id, { action: 'despachar', carrier: 'Xyz', trackingNumber: '123' })).status === 400);

// ── 2. Corregir dirección y confirmar escribiendo "sí"
const o2 = (await call('POST', '/api/hermes/orders', admin, { ...base, phone: '3009990000', customerName: 'Pedro Ruiz' })).json;
await reply(o2.id, { payload: 'CORREGIR' });
d = await get(o2.id);
check('pide la dirección', d.order.awaiting === 'direccion' && lastOut(d).template === 'hermes_pedir_direccion');
await reply(o2.id, { text: 'Carrera 80 # 12-34 apto 501, barrio Laureles, Medellín' });
d = await get(o2.id);
check('actualiza la dirección y vuelve a pedir confirmación', d.order.address.includes('Carrera 80') && d.order.awaiting === 'confirmacion' && lastOut(d).template === 'hermes_datos_actualizados' && d.events.some((e) => e.type === 'direccion_corregida' && e.detail.includes('Calle 10')), d.order);
await reply(o2.id, { text: 'Si, confirmo' });
check('entiende "sí" escrito', (await get(o2.id)).order.status === 'confirmado');

// ── 3. Cancelación por el cliente y mensaje que el bot no entiende
const o3 = (await call('POST', '/api/hermes/orders', admin, { ...base, phone: '3001112222', customerName: 'Ana Díaz' })).json;
await reply(o3.id, { payload: 'CANCELAR' });
d = await get(o3.id);
check('cliente cancela', d.order.status === 'cancelado' && d.order.cancelReason.includes('cliente'), d.order);
const o4 = (await call('POST', '/api/hermes/orders', admin, { ...base, phone: '3003334444', customerName: 'Luis Mora' })).json;
await reply(o4.id, { text: '¿Tienen en talla XL? y cuánto demora' });
await reply(o4.id, { text: 'hola?' });
d = await get(o4.id);
check('mensaje libre pasa a una persona', d.order.attention === true && d.order.status === 'por_confirmar', d.order);
check('el aviso de "te responderá una persona" se envía una sola vez', d.messages.filter((m) => m.template === 'hermes_humano').length === 1, d.messages.map((m) => m.template));
check('una persona responde dentro del chat', (await call('POST', `/api/hermes/orders/${o4.id}/message`, sup, { body: 'Sí hay XL, llega en 2 días.' })).status === 200 && lastOut(await get(o4.id)).sender === 'Supervisora Demo');
await act(o4.id, { action: 'confirmar' });
check('confirmación manual limpia la atención', (d = await get(o4.id)).order.status === 'confirmado' && d.order.attention === false);

// ── 4. Novedad: dirección errada → cliente corrige → gestión → reparto → entregado
await act(o2.id, { action: 'despachar', carrier: 'Coordinadora', trackingNumber: '99887766', trackingUrl: '' });
await act(o2.id, { action: 'novedad', type: 'direccion', description: 'No existe la nomenclatura' });
d = await get(o2.id);
check('novedad avisa al cliente con opciones', d.order.status === 'novedad' && d.incidents.length === 1 && lastOut(d).buttons.length === 3 && lastOut(d).template === 'hermes_novedad', lastOut(d));
await reply(o2.id, { payload: 'CORREGIR_DIR' });
await reply(o2.id, { text: 'Carrera 80 # 12-34 torre 2 apto 501, barrio Laureles' });
d = await get(o2.id);
check('cliente corrige la dirección de la novedad y queda para gestionar', d.order.address.includes('torre 2') && d.incidents[0].status === 'por_gestionar' && d.incidents[0].customerChoice === 'corrige_direccion' && d.order.attention === true, d.incidents[0]);
const inbox = (await call('GET', '/api/hermes/incidents', sup)).json;
check('bandeja de novedades', inbox.incidents.length === 1 && inbox.incidents[0].code === 'H-000002', inbox.incidents);
check('gestionar la novedad', (await call('POST', `/api/hermes/incidents/${d.incidents[0].id}/resolve`, sup, { resolution: 'Dirección corregida enviada a la transportadora' })).status === 200 && (await get(o2.id)).order.attention === false);
await act(o2.id, { action: 'en_reparto' });
await act(o2.id, { action: 'entregado' });
check('entregado tras la novedad', (await get(o2.id)).order.status === 'entregado');

// ── 5. Novedad rehusado → devuelto; duplicados; recordatorios
const o5 = (await call('POST', '/api/hermes/orders', admin, { ...base, phone: '3005556666', customerName: 'Rosa Paz', city: 'Bogotá' })).json;
await reply(o5.id, { payload: 'CONFIRMAR' });
await act(o5.id, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '2400099', trackingUrl: '' });
await act(o5.id, { action: 'novedad', type: 'rehusado' });
await reply(o5.id, { payload: 'RECHAZAR' });
d = await get(o5.id);
check('cliente rechaza: pasa a una persona', d.order.attention === true && d.incidents[0].customerChoice === 'rechaza', d.incidents[0]);
await act(o5.id, { action: 'devuelto' });
d = await get(o5.id);
check('devuelto cierra la novedad', d.order.status === 'devuelto' && d.incidents[0].status === 'devolucion', d.order);
const dup = (await call('POST', '/api/hermes/orders', admin, { ...base, phone: '3003334444', customerName: 'Luis Mora' })).json;
check('avisa de posible duplicado', dup.possibleDuplicateOf === 'H-000004' && (await get(dup.id)).order.attention === true, dup);
await call('PUT', '/api/hermes/settings', admin, { reminderMinutes: [5], escalateMinutes: 15 });
await call('POST', '/api/hermes/run-reminders', admin);
check('recordatorio no se envía antes de tiempo', (await get(dup.id)).order.remindersSent === 0);

// ── 6. Permisos y panel
check('vendedora ve solo sus pedidos', (await call('GET', '/api/hermes/orders', v1)).json.orders.length === 1 && (await call('GET', '/api/hermes/orders', v2)).json.orders.length === 0);
check('vendedora no ve el pedido de otra', (await call('GET', `/api/hermes/orders/${o2.id}`, v1)).status === 403);
check('vendedora no ejecuta acciones ni ve el panel', (await act(o1.json.id, { action: 'entregado' }, v1)).status === 403 && (await call('GET', '/api/hermes/panel', v1)).status === 403);
check('supervisora no cambia ajustes', (await call('PUT', '/api/hermes/settings', sup, { reminderMinutes: [30], escalateMinutes: 60 })).status === 403);
const panel = (await call('GET', '/api/hermes/panel', sup)).json;
check('panel: totales', panel.totals.total === 6 && panel.totals.delivered === 2 && panel.totals.returned === 1 && panel.totals.cancelled === 1 && panel.totals.deliveredValue === 240000, panel.totals);
check('panel: por vendedora, ciudad, transportadora y novedad', panel.bySeller.some((s) => s.name === 'Vendedora Demo 1' && s.delivered === 1) && panel.byCity.length >= 2 && panel.byCarrier.some((c) => c.name === 'Interrapidísimo') && panel.byIncident.length === 2, panel);
const list = (await call('GET', '/api/hermes/orders?q=laura', sup)).json;
check('búsqueda y contadores', list.orders.length === 1 && list.counts.length >= 3, list.counts);
check('avisos del menú cuentan pedidos por atender', (await call('GET', '/api/argos/notifications', sup)).json.hermesAttention === 1);

console.log(failures ? `\n${failures} FALLOS` : '\nTODO OK');
process.exit(failures ? 1 : 0);
