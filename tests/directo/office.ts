// Prueba directa (sin servidor) de los recordatorios de oficina. Usa una base TEMPORAL (DATA_DIR).
const { db } = await import('../../apps/server/src/db/db.ts');
const bot = await import('../../apps/server/src/hermes/bot.ts');
const routes = await import('../../apps/server/src/hermes/routes.ts');
let f = 0; const check = (n: string, c: boolean, x: unknown = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const companyId = (await db.query(`SELECT id FROM core_companies ORDER BY created_at LIMIT 1`)).rows[0].id;
const ctx = { companyId, role: 'admin', userId: null, name: 'Prueba' };
const get = async (id: string) => (await db.query(`SELECT * FROM hermes_orders WHERE id = $1`, [id])).rows[0];
const msgs = async (id: string) => (await db.query(`SELECT direction, template, body, buttons FROM hermes_messages WHERE order_id = $1 ORDER BY created_at`, [id])).rows;
const days = (id: string, d: number) => db.query(`UPDATE hermes_orders SET office_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(Math.round(d * 24))]);
const inOffice = async (name: string, phone: string) => {
  const b = routes.parseOrder({ customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }).data!;
  const id = (await routes.createOrder(ctx, b, await routes.inspectOrder(ctx, b), 'manual')).id as string;
  await bot.confirm(await get(id), 'Prueba');
  await bot.dispatch(await get(id), { carrier: 'Interrapidísimo', trackingNumber: '2400' + phone.slice(-6), trackingUrl: '' }, 'Prueba');
  await bot.readyForPickup(await get(id), 'Prueba');
  return id;
};

const a = await inOffice('Ana Uno', '3008880001');
let o = await get(a);
check('al quedar en oficina empieza a contar', o.office_at !== null && o.office_reminders === 0);
await days(a, 1.5); await bot.runReminders();
check('al día y medio no recuerda', (await get(a)).office_reminders === 0);
await days(a, 2.1); await bot.runReminders();
o = await get(a); let m = (await msgs(a)).at(-1);
check('a los 2 días recuerda, con botones', o.office_reminders === 1 && o.awaiting === 'oficina' && m.template === 'hermes_oficina_recordatorio' && m.body.includes('hace 2 días en la oficina de Interrapidísimo en Cali') && m.buttons.length === 3, m);
await bot.runReminders();
check('no repite el mismo recordatorio', (await get(a)).office_reminders === 1);
await bot.handleInbound(companyId, '3008880001', { payload: 'OFICINA_VOY', text: 'Sí, voy a pasar' });
o = await get(a); m = (await msgs(a)).at(-1);
check('«voy a pasar»: le recuerda documento y guía, sin atención', o.attention === false && o.awaiting === null && m.body.includes('documento de identidad') && m.body.includes('2400880001'), m);
await days(a, 4.1); await bot.runReminders();
o = await get(a);
check('a los 4 días, segundo recordatorio', o.office_reminders === 2 && (await msgs(a)).at(-1).body.includes('hace 4 días'), await msgs(a));
await days(a, 5.5); await bot.runReminders();
check('a los 5 días y medio aún espera', (await get(a)).attention === false);
await days(a, 6.1); await bot.runReminders();
o = await get(a);
check('a los 6 días sin reclamar pasa a una persona', o.attention === true && /lleva 6 días en la oficina/.test(o.attention_reason), o);

const b = await inOffice('Beto Dos', '3008880002');
await days(b, 2.1); await bot.runReminders();
await bot.handleInbound(companyId, '3008880002', { payload: 'OFICINA_RECOGIDO', text: 'Ya lo recogí' });
o = await get(b);
check('«ya lo recogí»: deja de recordar y no marca entregado', o.office_at === null && o.status === 'despachado' && o.attention === false, o);
await db.query(`UPDATE hermes_orders SET office_at = NULL WHERE id = $1`, [b]); await bot.runReminders();
check('sin más recordatorios tras recogerlo', (await get(b)).office_reminders === 1);

const c = await inOffice('Caro Tres', '3008880003');
await days(c, 2.1); await bot.runReminders();
await bot.handleInbound(companyId, '3008880003', { text: 'No puedo ir', payload: bot.payloadOfLabel('No puedo ir') });
o = await get(c);
check('«no puedo ir» reconocido por el texto del botón: pasa a una persona', o.attention === true && /no puede ir a la oficina/.test(o.attention_reason) && o.office_at === null, o);

const d = await inOffice('Dani Cuatro', '3008880004');
await bot.delivered(await get(d), 'Prueba');
await days(d, 3); await bot.runReminders();
check('si ya se entregó, no recuerda', (await get(d)).office_reminders === 0);

console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
await db.close();
process.exit(f ? 1 : 0);
