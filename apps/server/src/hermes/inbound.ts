// Hermes · entrada de mensajes de clientes desde Pancake.
// Los mensajes siempre se leen de la API de Pancake (nunca del contenido de un aviso): así sirve igual con webhook o sin él,
// y nadie puede hacer actuar al bot con un aviso inventado.
import { db } from '../db/db.ts';
import * as bot from './bot.ts';
import * as pancake from './pancake.ts';

// Un cliente que escribe dos mensajes seguidos: el segundo espera a que termine el primero.
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, run);
  void run.finally(() => queues.get(key) === run && queues.delete(key)).catch(() => {});
  return run;
}

/**
 * Lee la conversación de un teléfono y procesa lo que aún no se había visto.
 * `since`: desde cuándo está activo el canal; lo anterior es historia y no se toca.
 * Devuelve cuántos mensajes nuevos procesó, o null si no se pudo consultar.
 */
export function ingestConversation(companyId: string, ch: pancake.Channel, phone: string, since: Date): Promise<number | null> {
  return inOrder(`${companyId}|${phone}`, async () => {
    const messages = await pancake.listMessages(ch, pancake.conversationId(ch.pageId, phone));
    if (!messages) return null;
    let handled = 0;
    // El mismo WhatsApp se usa para vender: lo que el cliente escribió antes de que existiera su pedido
    // es la conversación de la venta, no una respuesta a Hermes, y no se procesa.
    const open = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM hermes_orders WHERE company_id = $1 AND phone = $2 ORDER BY (status IN ('entregado', 'devuelto', 'cancelado')), created_at DESC LIMIT 1`,
      [companyId, bot.normalizePhone(phone)],
    );
    const from = open.rows[0] ? Math.max(since.getTime(), new Date(open.rows[0].created_at).getTime()) : since.getTime();
    for (const m of messages) {
      if (!m.at || m.at.getTime() < from) continue;
      const seen = await db.query(`SELECT 1 FROM hermes_messages WHERE company_id = $1 AND external_id = $2`, [companyId, m.id]);
      if (seen.rows.length) continue; // ya procesado, o es un mensaje que envió Hermes
      const text = m.text || (m.hasAttachment ? '[Archivo adjunto]' : '');
      if (!text) continue;
      if (m.sender === 'equipo') {
        // Solo se anota lo que escribió una persona desde Pancake; lo automático (incluidos los envíos de Hermes) se ignora.
        if (m.staffName) await bot.recordStaffMessage(companyId, phone, text, m.staffName, m.id);
        continue;
      }
      await bot.handleInbound(companyId, phone, { text, payload: bot.payloadOfLabel(text) }, { externalId: m.id });
      handled++;
    }
    return handled;
  });
}

/** Cada cuánto conviene revisar la conversación de un pedido, según hace cuánto hubo movimiento. */
const POLL_STEPS: [maxAgeMin: number, everyMin: number][] = [[10, 1], [60, 3], [1440, 15], [Infinity, 60]];

async function pollOrders(companyId: string, ch: pancake.Channel, since: Date): Promise<{ checked: number; failed: number }> {
  const steps = POLL_STEPS.map(([age, every]) => `WHEN age_min < ${Number.isFinite(age) ? age : 1e9} THEN ${every}`).join(' ');
  const { rows } = await db.query(
    `SELECT phone, min(id::text) AS id FROM (
       SELECT id, phone, polled_at, extract(epoch FROM (now() - greatest(coalesce(last_outbound_at, created_at), coalesce(last_inbound_at, created_at)))) / 60 AS age_min, status
         FROM hermes_orders WHERE company_id = $1
     ) o
      WHERE (status NOT IN ('entregado', 'devuelto', 'cancelado') OR age_min < 1440)
        AND (polled_at IS NULL OR polled_at <= now() - (CASE ${steps} END) * interval '1 minute')
      GROUP BY phone ORDER BY min(age_min) LIMIT 100`,
    [companyId],
  );
  let failed = 0;
  for (const r of rows) {
    const n = await ingestConversation(companyId, ch, r.phone, since);
    if (n === null) failed++;
    await db.query(`UPDATE hermes_orders SET polled_at = now() WHERE company_id = $1 AND phone = $2`, [companyId, r.phone]);
  }
  return { checked: rows.length, failed };
}

/** Consulta a Pancake los mensajes nuevos de una empresa. Primero pide la lista de conversaciones con movimiento; si no sirve, va pedido a pedido. */
export async function pollCompany(companyId: string): Promise<{ mode: string; processed: number; error: string }> {
  const { rows } = await db.query(`SELECT driver, channel_since, poll_cursor FROM hermes_settings WHERE company_id = $1`, [companyId]);
  const s = rows[0];
  const ch = (await bot.channelOf(companyId)).channel;
  if (!s || s.driver !== 'pancake' || !ch) return { mode: '', processed: 0, error: 'El canal no está activo.' };
  const since: Date = s.channel_since ?? new Date();
  const started = new Date();
  // Se repasan dos minutos ya consultados: lo repetido se descarta solo y así no se escapa nada en el borde.
  const from = new Date(Math.max(since.getTime(), (s.poll_cursor ?? since).getTime() - 120_000));
  let mode = 'lista';
  let processed = 0;
  let error = '';

  const list = await pancake.listUpdatedConversations(ch, from, started);
  const withPhone = (list ?? []).map((c) => ({ ...c, phone: pancake.phoneOf(c.id) })).filter((c) => c.phone && (!c.updatedAt || c.updatedAt.getTime() >= from.getTime()));
  // Si la lista no llegó, o trae conversaciones pero de ninguna se puede sacar el teléfono, no es de fiar: se consulta pedido a pedido.
  if (!list || (list.length > 0 && withPhone.length === 0 && list.some((c) => !pancake.phoneOf(c.id)))) {
    mode = 'pedidos';
    const res = await pollOrders(companyId, ch, since);
    processed = res.checked;
    if (res.checked > 0 && res.failed === res.checked) error = 'Pancake no respondió al consultar las conversaciones.';
  } else if (withPhone.length) {
    const phones = [...new Set(withPhone.map((c) => c.phone))];
    const known = await db.query(`SELECT DISTINCT phone FROM hermes_orders WHERE company_id = $1 AND phone IN (SELECT jsonb_array_elements_text($2::jsonb))`, [companyId, JSON.stringify(phones)]);
    for (const r of known.rows) {
      const n = await ingestConversation(companyId, ch, r.phone, since);
      if (n === null) error = 'Pancake no respondió al leer algunas conversaciones.';
      else processed += n;
    }
  }
  // Si algo falló, el cursor no avanza: la siguiente consulta repite el mismo tramo.
  await db.query(`UPDATE hermes_settings SET poll_at = now(), poll_status = $2, poll_cursor = CASE WHEN $3 THEN $4::timestamptz ELSE poll_cursor END WHERE company_id = $1`, [companyId, error ? `error: ${error}` : mode, !error, started.toISOString()]);
  return { mode, processed, error };
}

let polling = false;
/** Tarea periódica: todas las empresas con el canal activo. */
export async function pollInbound(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { rows } = await db.query(`SELECT s.company_id FROM hermes_settings s JOIN core_companies c ON c.id = s.company_id WHERE s.driver = 'pancake' AND c.status = 'active' AND c.products ? 'hermes'`);
    for (const r of rows) await pollCompany(r.company_id).catch(() => {});
  } finally {
    polling = false;
  }
}
