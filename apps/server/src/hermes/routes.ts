// Hermes · rutas: pedidos, acciones, conversación, novedades, panel y ajustes.
// Quién ve qué: administrador y supervisor gestionan todos los pedidos de la empresa;
// una vendedora puede crear pedidos y ver únicamente los que se le atribuyen.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, forbidden, guard, notFound, parse } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';
import * as bot from './bot.ts';

const idParam = z.object({ id: z.uuid() });
const STATUSES = ['por_confirmar', 'confirmado', 'despachado', 'en_reparto', 'novedad', 'entregado', 'devuelto', 'cancelado'] as const;
const INCIDENT_TYPES = ['direccion', 'ausente', 'rehusado', 'telefono', 'zona', 'otro'] as const;

const orderBody = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(25),
  address: z.string().trim().min(5).max(300),
  city: z.string().trim().min(2).max(80),
  department: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(300).default(''),
  items: z.array(z.object({ name: z.string().trim().min(1).max(120), qty: z.number().int().min(1).max(999), price: z.number().int().min(0).max(100_000_000) })).min(1).max(30),
  payment: z.enum(['contraentrega', 'pagado']).default('contraentrega'),
  sellerUserId: z.uuid().nullable().optional(),
  externalRef: z.string().trim().max(120).default(''),
});

const ORDER_COLUMNS = `o.id, o.code, o.customer_name AS "customerName", o.phone, o.address, o.city, o.department, o.notes, o.items, o.total, o.payment,
  o.status, o.awaiting, o.attention, o.attention_reason AS "attentionReason", o.seller_user_id AS "sellerUserId", u.name AS "sellerName",
  o.source, o.external_ref AS "externalRef", o.carrier, o.tracking_number AS "trackingNumber", o.tracking_url AS "trackingUrl",
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

  app.post('/api/hermes/orders', guard(), async (req) => {
    const ctx = req.ctx;
    const b = parse(orderBody, req.body);
    const phone = bot.normalizePhone(b.phone);
    if (phone.length < 10) throw badRequest('El teléfono no parece válido. Escríbelo con indicativo o como celular de 10 dígitos.');
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
      `INSERT INTO hermes_orders (company_id, code, customer_name, phone, address, city, department, notes, items, total, payment, seller_user_id, external_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14) RETURNING *`,
      [ctx.companyId, code, b.customerName, phone, b.address, b.city, b.department, b.notes, JSON.stringify(b.items), total, b.payment, sellerId, b.externalRef, ctx.userId],
    );
    const order: bot.Order = rows[0];
    await bot.logEvent(order, 'creado', `Pedido creado por ${ctx.name}`, ctx.name);
    if (duplicate.rows.length) await bot.setAttention(order, `Posible duplicado: este teléfono ya tiene abierto el pedido ${duplicate.rows[0].code}`);
    await bot.startConfirmation(order);
    return { id: order.id, code, possibleDuplicateOf: duplicate.rows[0]?.code ?? null };
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
    await bot.handleInbound(req.ctx.companyId, o.phone, b);
    return { ok: true };
  });

  /** Fuerza la revisión de recordatorios (la tarea corre sola cada minuto). */
  app.post('/api/hermes/run-reminders', guard('admin'), async () => {
    await bot.runReminders();
    return { ok: true };
  });
}
