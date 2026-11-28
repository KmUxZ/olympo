// Prueba directa (sin servidor) de qué pasa cuando el cliente no responde. Usa una base TEMPORAL (DATA_DIR).
const { db } = await import('../../apps/server/src/db/db.ts');
const bot = await import('../../apps/server/src/hermes/bot.ts');
const routes = await import('../../apps/server/src/hermes/routes.ts');
let f = 0; const check = (n: string, c: boolean, x: unknown = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const companyId = (await db.query(`SELECT id FROM core_companies ORDER BY created_at LIMIT 1`)).rows[0].id;
const ctx = { companyId, role: 'admin', userId: null, name: 'Prueba' };
const mk = async (name: string, phone: string) => {
  const b = routes.parseOrder({ customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }).data!;
  return (await routes.createOrder(ctx, b, await routes.inspectOrder(ctx, b), 'manual')).id as string;
};
const get = async (id: string) => (await db.query(`SELECT * FROM hermes_orders WHERE id = $1`, [id])).rows[0];
const age = (id: string, minutes: number) => db.query(`UPDATE hermes_orders SET last_outbound_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, String(minutes)]);
const setMode = (mode: string) => db.query(`INSERT INTO hermes_settings (company_id, reminder_minutes, escalate_minutes, no_reply_action) VALUES ($1, '[30]'::jsonb, 60, $2) ON CONFLICT (company_id) DO UPDATE SET reminder_minutes = '[30]'::jsonb, escalate_minutes = 60, no_reply_action = $2`, [companyId, mode]);
const msgs = async (id: string) => (await db.query(`SELECT direction, template, body FROM hermes_messages WHERE order_id = $1 ORDER BY created_at`, [id])).rows;

// Modo por defecto: pasa a una persona
await setMode('persona');
const a = await mk('Ana Uno', '3007770001');
await age(a, 31); await bot.runReminders();
let o = await get(a);
check('recordatorio a su tiempo, con el texto nuevo', o.reminders_sent === 1 && (await msgs(a)).at(-1).body.includes('Quiero asegurarme de que tu pedido'), await msgs(a));
await age(a, 61); await bot.runReminders();
o = await get(a);
check('modo persona: queda por atender y sin confirmar', o.status === 'por_confirmar' && o.attention === true, o);

// Modo confirmar
await setMode('confirmar');
const b = await mk('Beto Dos', '3007770002');
await age(b, 31); await bot.runReminders();
await age(b, 59); await bot.runReminders();
check('antes de tiempo no confirma', (await get(b)).status === 'por_confirmar');
const before = (await msgs(b)).length;
await age(b, 61); await bot.runReminders();
o = await get(b);
check('modo confirmar: queda confirmado, sin atención', o.status === 'confirmado' && o.attention === false && o.confirmed_at !== null && o.awaiting === null, o);
check('no le escribe al cliente al confirmar solo', (await msgs(b)).length === before);
const ev = (await db.query(`SELECT detail FROM hermes_events WHERE order_id = $1 AND type = 'confirmado'`, [b])).rows;
check('queda en el historial como automático', ev.length === 1 && /automáticamente/.test(ev[0].detail), ev);

// Respuestas tardías sobre un pedido ya confirmado
await bot.handleInbound(companyId, '3007770002', { payload: 'CONFIRMAR', text: 'Confirmar pedido' });
o = await get(b);
check('confirma tarde: sigue confirmado y recibe respuesta', o.status === 'confirmado' && o.attention === false && (await msgs(b)).at(-1).template === 'hermes_confirmado', await msgs(b));
await bot.handleInbound(companyId, '3007770002', { payload: 'CANCELAR', text: 'Cancelar' });
o = await get(b);
check('cancela tarde: no se cancela solo, pasa a una persona', o.status === 'confirmado' && o.attention === true && /cancelar un pedido ya confirmado/.test(o.attention_reason), o);

// Riesgo alto: aunque el modo sea confirmar, va a una persona
const c = await mk('Caro Tres', '3007770003');
await db.query(`UPDATE hermes_orders SET customer_risk = 'alto', attention = false, attention_reason = '' WHERE id = $1`, [c]);
await age(c, 31); await bot.runReminders();
await age(c, 61); await bot.runReminders();
o = await get(c);
check('riesgo alto: no se confirma solo', o.status === 'por_confirmar' && o.attention === true && /riesgo alto/.test(o.attention_reason), o);

// Cliente que pidió corregir y no mandó la dirección: no se confirma solo
const d = await mk('Dani Cuatro', '3007770004');
await bot.handleInbound(companyId, '3007770004', { payload: 'CORREGIR', text: 'Corregir datos' });
await age(d, 500); await bot.runReminders();
check('esperando dirección: no se confirma solo', (await get(d)).status === 'por_confirmar');

console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
await db.close();
process.exit(f ? 1 : 0);
