// Prueba directa de la puesta al día de guías ya enlazadas. Usa una base TEMPORAL (DATA_DIR).
const { db } = await import('../../apps/server/src/db/db.ts');
const bot = await import('../../apps/server/src/hermes/bot.ts');
const routes = await import('../../apps/server/src/hermes/routes.ts');
const hoko = await import('../../apps/server/src/hermes/hoko.ts');
let f = 0; const check = (n: string, c: boolean, x: unknown = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const companyId = (await db.query(`SELECT id FROM core_companies ORDER BY created_at LIMIT 1`)).rows[0].id;
const ctx = { companyId, role: 'admin', userId: null, name: 'Prueba' };
const get = async (id: string) => (await db.query(`SELECT * FROM hermes_orders WHERE id = $1`, [id])).rows[0];
const opId = (await db.query(`INSERT INTO hermes_operators (company_id, name, carrier) VALUES ($1, 'Hoko País', 'Hoko') RETURNING id`, [companyId])).rows[0].id;
const make = async (name: string, phone: string) => {
  const b = routes.parseOrder({ customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }).data!;
  const id = (await routes.createOrder(ctx, b, await routes.inspectOrder(ctx, b), 'manual')).id as string;
  await bot.confirm(await get(id), 'Prueba');
  return id;
};
// Como quedaron los pedidos reales: enlazados, guía generada, aún confirmados.
const link = async (id: string, ref: string, guide: string, state: string) => {
  await db.query(`UPDATE hermes_orders SET operator_id = $2, operator_ref = $3, operator_state = $4 WHERE id = $1`, [id, opId, ref, state]);
  await db.query(`INSERT INTO hermes_operator_events (company_id, operator_id, external_ref, guide_number, state, state_name, phone, order_id, result) VALUES ($1, $2, $3, $4, $5, 'Generada', '', $6, 'x')`, [companyId, opId, ref, guide, state, id]);
};
const a = await make('Ana Uno', '3007770001'); await link(a, '5001', 'HK5001', '5');
const b = await make('Beto Dos', '3007770002'); await link(b, '5002', '', '13');
const c = await make('Caro Tres', '3007770003');
await hoko.dispatchLinkedGuides();
let o = await get(a);
check('el enlazado con guía queda despachado', o.status === 'despachado' && o.tracking_number === 'HK5001' && o.carrier === 'Hoko', o);
const n = (await db.query(`SELECT count(*)::int AS n FROM hermes_messages WHERE order_id = $1 AND direction = 'out' AND body LIKE '%HK5001%'`, [a])).rows[0].n;
check('recibe la guía una sola vez', n === 1, n);
check('sin número de guía no se despacha', (await get(b)).status === 'confirmado');
check('el que no está enlazado no se toca', (await get(c)).status === 'confirmado');
await hoko.dispatchLinkedGuides();
const n2 = (await db.query(`SELECT count(*)::int AS n FROM hermes_messages WHERE order_id = $1 AND direction = 'out' AND body LIKE '%HK5001%'`, [a])).rows[0].n;
check('repetir la tarea no repite el mensaje', n2 === 1, n2);
// Avisos que no enlazaron en su momento (el pedido esperaba confirmación)
const ev = (ref: string, guide: string, state: string, phone: string, ago = '0 minutes') => db.query(`INSERT INTO hermes_operator_events (company_id, operator_id, external_ref, guide_number, state, state_name, phone, result, at) VALUES ($1, $2, $3, $4, $5, 'x', $6, 'Sin pedido', now() - $7::interval)`, [companyId, opId, ref, guide, state, phone, ago]);
const mk = async (name: string, phone: string, confirmIt = true) => {
  const b2 = routes.parseOrder({ customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }).data!;
  const id = (await routes.createOrder(ctx, b2, await routes.inspectOrder(ctx, b2), 'manual')).id as string;
  if (confirmIt) await bot.confirm(await get(id), 'Prueba');
  return id;
};
const p1 = await mk('Pedro Uno', '3007771001', false); await ev('7001', 'HK7001', '5', '573007771001');
const p2 = await mk('Pedro Dos', '3007771002'); await ev('7002', 'HK7002', '3', '573007771002');
const p3 = await mk('Pedro Tres', '3007771003'); await ev('7003', 'HK7003', '9', '573007771003', '2 days'); await ev('7003', 'HK7003', '9', '573007771003');
const p4 = await mk('Pedro Cuatro', '3007771004'); await ev('7004', '', '13', '573007771004');
await hoko.dispatchLinkedGuides();
o = await get(p1);
check('aviso recuperado: el pedido sin confirmar recibe su guía', o.status === 'despachado' && o.tracking_number === 'HK7001' && o.operator_ref === '7001', o);
const evRow = (await db.query(`SELECT order_id, result FROM hermes_operator_events WHERE external_ref = '7001'`)).rows[0];
check('el aviso queda enlazado al pedido', evRow.order_id === p1 && /Recuperado/.test(evRow.result), evRow);
check('una guía ya entregada no se recupera', (await get(p2)).status === 'confirmado');
check('una guía anterior al pedido no se le pega', (await get(p3)).status === 'confirmado');
check('un aviso sin número de guía no despacha', (await get(p4)).status === 'confirmado');
await hoko.dispatchLinkedGuides();
const n7 = (await db.query(`SELECT count(*)::int AS n FROM hermes_messages WHERE order_id = $1 AND direction = 'out' AND body LIKE '%HK7001%'`, [p1])).rows[0].n;
check('repetir no reenvía la guía recuperada', n7 === 1, n7);
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
process.exit(f ? 1 : 0);
