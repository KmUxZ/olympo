// Hermes · rutas: pedidos, acciones, conversación, novedades, panel y ajustes.
// Quién ve qué: administrador y supervisor gestionan todos los pedidos de la empresa;
// una vendedora puede crear pedidos y ver únicamente los que se le atribuyen.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, forbidden, guard, notFound, parse } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';
import * as bot from './bot.ts';
import { checkAddress, checkContact, composeAddress, summarizeHistory } from './address.ts';

/** Historial de pedidos de un teléfono en la empresa: sirve para estimar el riesgo de devolución. */
async function customerHistory(companyId: string, phone: string) {
  const { rows } = await db.query(
    `SELECT (count(*) FILTER (WHERE o.status = 'entregado'))::int AS delivered,
            (count(*) FILTER (WHERE o.status = 'devuelto'))::int AS returned,
            (count(*) FILTER (WHERE o.status = 'cancelado'))::int AS cancelled,
            (count(*) FILTER (WHERE o.status NOT IN ('entregado', 'devuelto', 'cancelado')))::int AS open,
            (count(*) FILTER (WHERE o.status <> 'devuelto' AND EXISTS (SELECT 1 FROM hermes_incidents i WHERE i.order_id = o.id AND i.type = 'rehusado')))::int AS refused
       FROM hermes_orders o WHERE o.company_id = $1 AND o.phone = $2`,
    [companyId, phone],
  );
  return summarizeHistory(rows[0]);
}

const idParam = z.object({ id: z.uuid() });
const STATUSES = ['por_confirmar', 'confirmado', 'despachado', 'en_reparto', 'novedad', 'entregado', 'devuelto', 'cancelado'] as const;
const INCIDENT_TYPES = ['direccion', 'ausente', 'rehusado', 'telefono', 'zona', 'otro'] as const;

const orderBody = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(25),
  address: z.string().trim().min(5).max(300),
  neighborhood: z.string().trim().max(80).default(''),
  city: z.string().trim().min(2).max(80),
  department: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(300).default(''),
  items: z.array(z.object({ free: z.boolean().optional(), name: z.string().trim().min(1).max(400), qty: z.number().int().min(1).max(999), price: z.number().int().min(0).max(100_000_000) })).min(1).max(30),
  payment: z.enum(['contraentrega', 'pagado']).default('contraentrega'),
  sellerUserId: z.uuid().nullable().optional(),
  externalRef: z.string().trim().max(120).default(''),
});

const ORDER_COLUMNS = `o.id, o.code, o.customer_name AS "customerName", o.phone, o.address, o.city, o.department, o.notes, o.items, o.total, o.payment,
  o.status, o.awaiting, o.attention, o.attention_reason AS "attentionReason", o.seller_user_id AS "sellerUserId", u.name AS "sellerName",
  o.source, o.external_ref AS "externalRef", o.carrier, o.tracking_number AS "trackingNumber", o.tracking_url AS "trackingUrl",
  o.address_check AS "addressCheck", o.customer_risk AS "customerRisk",
  o.bot_paused AS "botPaused", o.taken_by AS "takenBy", o.attention_at AS "attentionAt",
  o.reminders_sent AS "remindersSent", o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt", o.dispatched_at AS "dispatchedAt",
  o.out_for_delivery_at AS "outForDeliveryAt", o.delivered_at AS "deliveredAt", o.returned_at AS "returnedAt", o.cancelled_at AS "cancelledAt", o.cancel_reason AS "cancelReason"`;

/** Filtro de alcance: una vendedora solo ve sus pedidos. */
function sellerScope(ctx: Ctx, params: unknown[]): string {
  if (ctx.role !== 'seller') return '';
  params.push(ctx.userId);
  return ` AND o.seller_user_id = $${params.length}`;
}

async function loadOrder(ctx: Ctx, id: string): Promise<bot.Order> {
  const o = await bot.getOrder(ctx.companyId, id);
  if (!o) throw notFound('Pedido no encontrado.');
  if (ctx.role === 'seller' && (o as unknown as { seller_user_id: string | null }).seller_user_id !== ctx.userId) throw forbidden();
  return o;
}

export function hermesRoutes(app: FastifyInstance): void {
  // ───────── Pedidos ─────────
  app.get('/api/hermes/orders', guard(), async (req) => {
    const q = parse(
      z.object({ status: z.enum(STATUSES).optional(), attention: z.enum(['1']).optional(), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(300).default(150) }),
      req.query,
    );
    const params: unknown[] = [req.ctx.companyId];
    let where = sellerScope(req.ctx, params);
    if (q.status) {
      params.push(q.status);
      where += ` AND o.status = $${params.length}`;
    }
    if (q.attention) where += ` AND o.attention`;
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (lower(o.customer_name) LIKE $${params.length} OR o.phone LIKE $${params.length} OR lower(o.code) LIKE $${params.length} OR o.tracking_number LIKE $${params.length})`;
    }
    params.push(q.limit);
    const { rows } = await db.query(
      `SELECT ${ORDER_COLUMNS} FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id
        WHERE o.company_id = $1 ${where} ORDER BY o.attention DESC, o.created_at DESC LIMIT $${params.length}`,
      params,
    );
    const countParams: unknown[] = [req.ctx.companyId];
    const scope = sellerScope(req.ctx, countParams);
    const counts = await db.query(
      `SELECT o.status, count(*)::int AS n, (count(*) FILTER (WHERE o.attention))::int AS attention FROM hermes_orders o WHERE o.company_id = $1 ${scope} GROUP BY o.status`,
      countParams,
    );
    return { orders: rows, counts: counts.rows };
  });

  /**
   * Validación previa de los datos de entrega. Los formularios la llaman mientras se escribe.
   * Revisa estructura de la dirección, ciudad, teléfono, nombre e historial del cliente.
   */
  app.post('/api/hermes/validate', guard(), async (req) => {
    const b = parse(z.object({ address: z.string().max(300).default(''), city: z.string().max(80).default(''), phone: z.string().max(25).default(''), customerName: z.string().max(120).default(''), neighborhood: z.string().max(80).default('') }), req.body);
    const phone = bot.normalizePhone(b.phone);
    const address = b.address.trim() ? checkAddress(composeAddress(b.address, b.neighborhood), b.city) : null;
    // Solo se opina de lo que ya se escribió.
    const contact = checkContact(phone, b.customerName).filter((i) => (i.code.startsWith('telefono') ? Boolean(b.phone.trim()) : Boolean(b.customerName.trim())));
    const history = phone.length >= 10 ? await customerHistory(req.ctx.companyId, phone) : null;
    return { address, contact, history };
  });

  app.post('/api/hermes/orders', guard(), async (req) => {
    const ctx = req.ctx;
    const b = parse(orderBody, req.body);
    const phone = bot.normalizePhone(b.phone);
    if (phone.length < 10) throw badRequest('El teléfono no parece válido. Escríbelo con indicativo o como celular de 10 dígitos.');
    const fullAddress = composeAddress(b.address, b.neighborhood);
    const addressCheck = checkAddress(fullAddress, b.city);
    // Una dirección incompleta es la primera causa de devolución: sin los datos obligatorios el pedido no se crea.
    const blocking = addressCheck.issues.filter((i) => i.severity === 'error');
    if (blocking.length) throw badRequest(`La dirección está incompleta. ${blocking.map((i) => i.message).join(' ')}`, 'direccion_incompleta');
    const history = await customerHistory(ctx.companyId, phone);
    const sellerId = ctx.role === 'seller' ? ctx.userId : (b.sellerUserId ?? null);
    if (sellerId && sellerId !== ctx.userId) {
      const ok = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2`, [sellerId, ctx.companyId]);
      if (!ok.rows.length) throw badRequest('La persona indicada no existe.');
    }
    const total = b.items.reduce((n, i) => n + i.qty * i.price, 0);

    // Número de pedido consecutivo por empresa.
    const counter = await db.query(
      `INSERT INTO hermes_settings (company_id, next_number) VALUES ($1, 2)
       ON CONFLICT (company_id) DO UPDATE SET next_number = hermes_settings.next_number + 1 RETURNING next_number - 1 AS n`,
      [ctx.companyId],
    );
    const code = `H-${String(counter.rows[0].n).padStart(6, '0')}`;

    // Aviso si el mismo teléfono ya tiene un pedido abierto: suele ser un duplicado.
    const duplicate = await db.query(`SELECT code FROM hermes_orders WHERE company_id = $1 AND phone = $2 AND status NOT IN ('entregado', 'devuelto', 'cancelado') LIMIT 1`, [ctx.companyId, phone]);

    const { rows } = await db.query(
      `INSERT INTO hermes_orders (company_id, code, customer_name, phone, address, city, department, notes, items, total, payment, seller_user_id, external_ref, created_by, address_check, customer_risk)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16) RETURNING *`,
      [
        ctx.companyId, code, b.customerName, phone, fullAddress, addressCheck.city?.name ?? b.city, b.department || addressCheck.city?.department || '', b.notes,
        JSON.stringify(b.items), total, b.payment, sellerId, b.externalRef, ctx.userId, JSON.stringify(addressCheck), history.risk,
      ],
    );
    const order: bot.Order = rows[0];
    await bot.logEvent(order, 'creado', `Pedido creado por ${ctx.name}`, ctx.name);
    if (duplicate.rows.length) await bot.setAttention(order, `Posible duplicado: este teléfono ya tiene abierto el pedido ${duplicate.rows[0].code}`);
    else if (history.risk === 'alto') await bot.setAttention(order, `Cliente de riesgo: ${history.message}`);
    if (addressCheck.level !== 'completa') await bot.logEvent(order, 'direccion_por_revisar', addressCheck.issues.map((i) => i.message).join(' '));
    await bot.startConfirmation(order);
    return { id: order.id, code, possibleDuplicateOf: duplicate.rows[0]?.code ?? null, addressLevel: addressCheck.level, customerRisk: history.risk };
  });

  app.get('/api/hermes/orders/:id', guard(), async (req) => {
    const { id } = parse(idParam, req.params);
    await loadOrder(req.ctx, id);
    const [order, events, messages, incidents, settings] = await Promise.all([
      db.query(`SELECT ${ORDER_COLUMNS} FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id WHERE o.id = $1`, [id]),
      db.query(`SELECT id, at, type, detail, actor FROM hermes_events WHERE order_id = $1 ORDER BY at`, [id]),
      db.query(`SELECT id, direction, kind, template, body, buttons, status, sender, created_at AS "createdAt" FROM hermes_messages WHERE order_id = $1 ORDER BY created_at`, [id]),
      db.query(`SELECT id, type, description, status, customer_choice AS "customerChoice", resolution, created_at AS "createdAt", resolved_at AS "resolvedAt" FROM hermes_incidents WHERE order_id = $1 ORDER BY created_at`, [id]),
      bot.settingsOf(req.ctx.companyId),
    ]);
    return { order: order.rows[0], events: events.rows, messages: messages.rows, incidents: incidents.rows, driver: settings.driver };
  });

  /** Acciones de gestión sobre un pedido. Cada una mueve el estado, deja historial y, si aplica, avisa al cliente. */
  app.post('/api/hermes/orders/:id/action', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('confirmar') }),
        z.object({ action: z.literal('cancelar'), reason: z.string().trim().min(2).max(200) }),
        z.object({ action: z.literal('despachar'), carrier: z.string().trim().min(2).max(60), trackingNumber: z.string().trim().min(3).max(60), trackingUrl: z.url().max(300).or(z.literal('')).default('') }),
        z.object({ action: z.literal('en_reparto') }),
        z.object({ action: z.literal('novedad'), type: z.enum(INCIDENT_TYPES), description: z.string().trim().max(300).default('') }),
        z.object({ action: z.literal('entregado') }),
        z.object({ action: z.literal('devuelto') }),
        z.object({ action: z.literal('atendido') }),
      ]),
      req.body,
    );
    const o = await loadOrder(ctx, id);
    const need = (allowed: string[]) => {
      if (!allowed.includes(o.status)) throw badRequest(`Esa acción no aplica a un pedido en estado «${o.status.replace('_', ' ')}».`, 'estado_no_valido');
    };
    switch (b.action) {
      case 'confirmar': need(['por_confirmar']); await bot.confirm(o, ctx.name); break;
      case 'cancelar':
        need(['por_confirmar', 'confirmado', 'novedad']);
        await bot.cancel(o, b.reason, ctx.name);
        await auditBy(ctx, { action: 'hermes.pedido_cancelado', entityType: 'pedido', entityId: id, summary: `Canceló el pedido ${o.code}: ${b.reason}` });
        break;
      case 'despachar': need(['confirmado']); await bot.dispatch(o, b, ctx.name); break;
      case 'en_reparto': need(['despachado', 'novedad']); await bot.outForDelivery(o, ctx.name); break;
      case 'novedad': need(['despachado', 'en_reparto']); await bot.reportIncident(o, b.type, b.description, ctx.name); break;
      case 'entregado': need(['despachado', 'en_reparto', 'novedad']); await bot.delivered(o, ctx.name); break;
      case 'devuelto': need(['despachado', 'en_reparto', 'novedad']); await bot.returned(o, ctx.name); break;
      case 'atendido':
        await db.query(`UPDATE hermes_orders SET attention = false, attention_reason = '', updated_at = now() WHERE id = $1`, [id]);
        await bot.logEvent(o, 'atendido', 'Marcado como atendido', ctx.name);
        break;
    }
    return { ok: true };
  });

  /** Respuesta escrita por una persona, dentro de la conversación del pedido. */
  app.post('/api/hermes/orders/:id/message', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(1000) }), req.body);
    const o = await loadOrder(req.ctx, id);
    await bot.send(o, { template: '', body: b.body }, req.ctx.name);
    // Al responder una persona, el caso deja de estar pendiente: ahora se espera al cliente.
    await db.query(`UPDATE hermes_orders SET attention = false, attention_reason = '', seen_at = now(), updated_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Marca una novedad como gestionada con la transportadora. */
  app.post('/api/hermes/incidents/:id/resolve', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ resolution: z.string().trim().min(2).max(300) }), req.body);
    const inc = (await db.query(`SELECT order_id FROM hermes_incidents WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!inc) throw notFound('Novedad no encontrada.');
    await db.query(`UPDATE hermes_incidents SET status = 'resuelta', resolution = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1`, [id, b.resolution, req.ctx.userId]);
    const o = await loadOrder(req.ctx, inc.order_id);
    await db.query(`UPDATE hermes_orders SET attention = false, attention_reason = '', awaiting = NULL, updated_at = now() WHERE id = $1`, [o.id]);
    await bot.logEvent(o, 'novedad_gestionada', b.resolution, req.ctx.name);
    return { ok: true };
  });

  // ───────── Bandeja de chats ─────────
  /**
   * Una conversación por pedido, con "quién tiene la pelota":
   *   persona  → necesita que alguien del equipo responda o gestione
   *   cliente  → el bot (o una persona) preguntó y se espera la respuesta del cliente
   *   proceso  → no se espera a nadie: el pedido sigue su curso logístico
   *   cerrado  → entregado, devuelto o cancelado
   * Se ordena por quién lleva más tiempo esperando.
   */
  app.get('/api/hermes/chats', guard('admin', 'supervisor'), async (req) => {
    const q = parse(z.object({ ball: z.enum(['persona', 'cliente', 'proceso', 'cerrado']).optional(), q: z.string().trim().max(80).optional() }), req.query);
    const FINAL = `('entregado', 'devuelto', 'cancelado')`;
    const BALL = `CASE WHEN o.attention THEN 'persona' WHEN o.status IN ${FINAL} THEN 'cerrado' WHEN o.awaiting IS NOT NULL THEN 'cliente' ELSE 'proceso' END`;
    const params: unknown[] = [req.ctx.companyId];
    let where = '';
    if (q.ball) {
      params.push(q.ball);
      where += ` AND ${BALL} = $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (lower(o.customer_name) LIKE $${params.length} OR o.phone LIKE $${params.length} OR lower(o.code) LIKE $${params.length} OR o.tracking_number LIKE $${params.length})`;
    }
    const [rows, counts] = await Promise.all([
      db.query(
        `SELECT o.id, o.code, o.customer_name AS "customerName", o.phone, o.city, o.status, o.awaiting, o.attention, o.attention_reason AS "attentionReason",
                o.bot_paused AS "botPaused", o.taken_by AS "takenBy", o.total, o.tracking_number AS "trackingNumber", ${BALL} AS ball,
                CASE WHEN o.attention THEN o.attention_at WHEN o.awaiting IS NOT NULL THEN o.last_outbound_at END AS "waitingSince",
                (o.last_inbound_at IS NOT NULL AND (o.seen_at IS NULL OR o.last_inbound_at > o.seen_at)) AS unread,
                m.body AS "lastBody", m.direction AS "lastDirection", m.sender AS "lastSender", coalesce(m.created_at, o.created_at) AS "lastAt"
           FROM hermes_orders o
           LEFT JOIN LATERAL (SELECT body, direction, sender, created_at FROM hermes_messages WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) m ON true
          WHERE o.company_id = $1 ${where}
          ORDER BY o.attention DESC, CASE WHEN o.attention THEN o.attention_at END ASC NULLS LAST, coalesce(m.created_at, o.created_at) DESC
          LIMIT 200`,
        params,
      ),
      db.query(`SELECT ${BALL} AS ball, count(*)::int AS n FROM hermes_orders o WHERE o.company_id = $1 GROUP BY 1`, [req.ctx.companyId]),
    ]);
    return { serverTime: new Date(), chats: rows.rows, counts: Object.fromEntries(counts.rows.map((c) => [c.ball, c.n])) };
  });

  /** Marca la conversación como vista por el equipo. */
  app.post('/api/hermes/orders/:id/seen', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    await loadOrder(req.ctx, id);
    await db.query(`UPDATE hermes_orders SET seen_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Tomar la conversación (pausa el bot en ese pedido) o devolverla al bot. */
  app.post('/api/hermes/orders/:id/takeover', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ paused: z.boolean() }), req.body);
    const o = await loadOrder(req.ctx, id);
    await bot.setBotPaused(o, b.paused, req.ctx.name);
    return { ok: true };
  });

  /** Vuelve a enviar la solicitud de confirmación (p. ej. tras hablar con el cliente). */
  app.post('/api/hermes/orders/:id/resend-confirmation', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const o = await loadOrder(req.ctx, id);
    if (o.status !== 'por_confirmar') throw badRequest('Solo se puede reenviar mientras el pedido está por confirmar.');
    await bot.startConfirmation(o);
    await db.query(`UPDATE hermes_orders SET attention = false, attention_reason = '', updated_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  // ───────── Bandeja de novedades ─────────
  app.get('/api/hermes/incidents', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(
      `SELECT i.id, i.type, i.description, i.status, i.customer_choice AS "customerChoice", i.resolution, i.created_at AS "createdAt", i.resolved_at AS "resolvedAt",
              o.id AS "orderId", o.code, o.customer_name AS "customerName", o.city, o.carrier, o.tracking_number AS "trackingNumber", o.address
         FROM hermes_incidents i JOIN hermes_orders o ON o.id = i.order_id
        WHERE i.company_id = $1 ORDER BY (i.status IN ('resuelta', 'devolucion')), i.created_at DESC LIMIT 200`,
      [req.ctx.companyId],
    );
    return { incidents: rows, labels: bot.INCIDENT_LABEL };
  });

  // ───────── Panel ─────────
  app.get('/api/hermes/panel', guard('admin', 'supervisor'), async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }), req.query);
    const args = [req.ctx.companyId, String(q.days)];
    const since = `o.company_id = $1 AND o.created_at >= now() - ($2 || ' days')::interval`;
    const agg = `count(*)::int AS total,
      (count(*) FILTER (WHERE o.confirmed_at IS NOT NULL))::int AS confirmed,
      (count(*) FILTER (WHERE o.dispatched_at IS NOT NULL))::int AS dispatched,
      (count(*) FILTER (WHERE o.status = 'entregado'))::int AS delivered,
      (count(*) FILTER (WHERE o.status = 'devuelto'))::int AS returned,
      (count(*) FILTER (WHERE o.status = 'cancelado'))::int AS cancelled,
      coalesce(sum(o.total) FILTER (WHERE o.status = 'entregado'), 0)::bigint AS "deliveredValue"`;
    const [totals, bySeller, byCity, byCarrier, byIncident, messages, timing] = await Promise.all([
      db.query(`SELECT ${agg}, (count(*) FILTER (WHERE o.status = 'por_confirmar'))::int AS pending, (count(*) FILTER (WHERE o.attention))::int AS attention FROM hermes_orders o WHERE ${since}`, args),
      db.query(`SELECT coalesce(u.name, 'Sin atribuir') AS name, ${agg} FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id WHERE ${since} GROUP BY 1 ORDER BY count(*) DESC LIMIT 30`, args),
      db.query(`SELECT o.city AS name, ${agg} FROM hermes_orders o WHERE ${since} GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`, args),
      db.query(`SELECT o.carrier AS name, ${agg} FROM hermes_orders o WHERE ${since} AND o.carrier <> '' GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`, args),
      db.query(
        `SELECT i.type, count(*)::int AS total, (count(*) FILTER (WHERE i.status = 'resuelta'))::int AS resolved, (count(*) FILTER (WHERE i.status = 'devolucion'))::int AS returned
           FROM hermes_incidents i JOIN hermes_orders o ON o.id = i.order_id WHERE ${since} GROUP BY i.type ORDER BY count(*) DESC`,
        args,
      ),
      db.query(`SELECT (count(*) FILTER (WHERE m.direction = 'out'))::int AS sent, (count(*) FILTER (WHERE m.direction = 'in'))::int AS received FROM hermes_messages m WHERE m.company_id = $1 AND m.created_at >= now() - ($2 || ' days')::interval`, args),
      db.query(`SELECT round(avg(extract(epoch FROM (o.confirmed_at - o.created_at)) / 60))::int AS "minutesToConfirm" FROM hermes_orders o WHERE ${since} AND o.confirmed_at IS NOT NULL`, args),
    ]);
    const num = (r: Record<string, unknown>) => ({ ...r, deliveredValue: Number(r.deliveredValue ?? 0) });
    return {
      days: q.days,
      totals: num(totals.rows[0]),
      bySeller: bySeller.rows.map(num),
      byCity: byCity.rows.map(num),
      byCarrier: byCarrier.rows.map(num),
      byIncident: byIncident.rows.map((r) => ({ ...r, label: bot.INCIDENT_LABEL[r.type] ?? r.type })),
      messages: messages.rows[0],
      minutesToConfirm: timing.rows[0]?.minutesToConfirm ?? null,
    };
  });

  // ───────── Ajustes ─────────
  app.get('/api/hermes/settings', guard('admin', 'supervisor'), async (req) => ({ settings: await bot.settingsOf(req.ctx.companyId) }));

  app.put('/api/hermes/settings', guard('admin'), async (req) => {
    const b = parse(z.object({ reminderMinutes: z.array(z.number().int().min(5).max(2880)).max(4), escalateMinutes: z.number().int().min(15).max(4320) }), req.body);
    const before = await bot.settingsOf(req.ctx.companyId);
    await db.query(
      `INSERT INTO hermes_settings (company_id, reminder_minutes, escalate_minutes) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (company_id) DO UPDATE SET reminder_minutes = EXCLUDED.reminder_minutes, escalate_minutes = EXCLUDED.escalate_minutes`,
      [req.ctx.companyId, JSON.stringify(b.reminderMinutes), b.escalateMinutes],
    );
    await auditBy(req.ctx, { action: 'hermes.ajustes', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Cambió los ajustes de Hermes', metadata: { antes: before, despues: b } });
    return { ok: true };
  });

  /**
   * Simulador: hace de cliente respondiendo al bot. Solo disponible en modo simulado.
   * Cuando haya un número real conectado, estas respuestas llegarán por el webhook del canal.
   */
  app.post('/api/hermes/orders/:id/simulate-reply', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ text: z.string().trim().max(500).optional(), payload: z.string().max(30).optional() }), req.body);
    if (!b.text && !b.payload) throw badRequest('Escribe un texto o elige un botón.');
    const settings = await bot.settingsOf(req.ctx.companyId);
    if (settings.driver !== 'simulado') throw forbidden('El simulador solo está disponible en modo simulado.');
    const o = await loadOrder(req.ctx, id);
    // Al pulsar un botón, en la conversación se muestra su texto (como lo vería el cliente), no el código interno.
    let text = b.text;
    if (b.payload && !text) {
      const last = await db.query(`SELECT buttons FROM hermes_messages WHERE order_id = $1 AND direction = 'out' AND jsonb_array_length(buttons) > 0 ORDER BY created_at DESC LIMIT 1`, [id]);
      text = (last.rows[0]?.buttons as { label: string; payload: string }[] | undefined)?.find((x) => x.payload === b.payload)?.label;
    }
    await bot.handleInbound(req.ctx.companyId, o.phone, { text, payload: b.payload });
    return { ok: true };
  });

  /** Fuerza la revisión de recordatorios (la tarea corre sola cada minuto). */
  app.post('/api/hermes/run-reminders', guard('admin'), async () => {
    await bot.runReminders();
    return { ok: true };
  });
}
