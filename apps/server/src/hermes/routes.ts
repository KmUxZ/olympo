// Hermes · rutas: pedidos, acciones, conversación, novedades, panel y ajustes.
// Quién ve qué: administrador y supervisor gestionan todos los pedidos de la empresa;
// una vendedora puede crear pedidos y ver únicamente los que se le atribuyen.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, forbidden, guard, HttpError, notFound, parse } from '../core/http.ts';
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
  o.source, o.external_ref AS "externalRef", o.operator_id AS "operatorId", o.operator_ref AS "operatorRef",
  (SELECT op.name FROM hermes_operators op WHERE op.id = o.operator_id) AS "operatorName", o.carrier, o.tracking_number AS "trackingNumber", o.tracking_url AS "trackingUrl",
  o.address_check AS "addressCheck", o.customer_risk AS "customerRisk",
  o.bot_paused AS "botPaused", o.taken_by AS "takenBy", o.attention_at AS "attentionAt",
  o.reminders_sent AS "remindersSent", o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt", o.dispatched_at AS "dispatchedAt",
  o.out_for_delivery_at AS "outForDeliveryAt", o.delivered_at AS "deliveredAt", o.returned_at AS "returnedAt", o.cancelled_at AS "cancelledAt", o.cancel_reason AS "cancelReason",
  o.correction_note AS "correctionNote", o.correction_requested_at AS "correctionRequestedAt", o.correction_by AS "correctionBy", o.corrected_at AS "correctedAt"`;

/**
 * Lo que ve una vendedora de sus pedidos: los datos que ella misma subió y si le pidieron corregir algo.
 * Sin estado logístico, guía, entregas, devoluciones, conversación ni historial del cliente.
 */
const SELLER_COLUMNS = `o.id, o.code, o.customer_name AS "customerName", o.phone, o.address, o.city, o.notes, o.items, o.total, o.payment,
  o.created_at AS "createdAt", (o.correction_requested_at IS NOT NULL) AS "needsCorrection", o.correction_note AS "correctionNote",
  o.correction_requested_at AS "correctionRequestedAt", o.corrected_at AS "correctedAt"`;

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


export type OrderInput = z.input<typeof orderBody>;
type OrderData = z.infer<typeof orderBody>;
/** Quién crea el pedido: una persona con sesión o un sistema (Athena), que no tiene usuario. */
export interface OrderActor { companyId: string; role: string; userId: string | null; name: string }
/** Valida los datos de un pedido que llega de otro módulo. */
export const parseOrder = (raw: unknown) => orderBody.safeParse(raw);

async function blockedInfo(companyId: string, phone: string): Promise<{ reason: string } | null> {
  const { rows } = await db.query(`SELECT reason FROM hermes_blocked WHERE company_id = $1 AND phone = $2`, [companyId, phone]);
  return rows[0] ?? null;
}

/**
 * Revisa un pedido antes de crearlo: teléfono, dirección, cliente bloqueado, historial y duplicados.
 * `errors` impiden crearlo; `warnings` solo informan. Lo usan el formulario y la importación en lote.
 */
export async function inspectOrder(ctx: OrderActor, b: OrderData) {
  const phone = bot.normalizePhone(b.phone);
  const errors: string[] = [];
  const warnings: string[] = [];
  let errorCode = 'solicitud_invalida';
  const fail = (code: string, message: string) => {
    if (!errors.length) errorCode = code;
    errors.push(message);
  };
  const phoneOk = phone.length >= 10;
  if (!phoneOk) fail('telefono_invalido', 'El teléfono no parece válido. Escríbelo con indicativo o como celular de 10 dígitos.');

  const fullAddress = composeAddress(b.address, b.neighborhood);
  const addressCheck = checkAddress(fullAddress, b.city);
  // Una dirección incompleta es la primera causa de devolución: sin los datos obligatorios el pedido no se crea.
  const addressErrors = addressCheck.issues.filter((i) => i.severity === 'error');
  if (addressErrors.length) fail('direccion_incompleta', `La dirección está incompleta. ${addressErrors.map((i) => i.message).join(' ')}`);
  for (const i of addressCheck.issues.filter((x) => x.severity === 'aviso')) warnings.push(i.message);

  const blocked = phoneOk ? await blockedInfo(ctx.companyId, phone) : null;
  if (blocked) fail('cliente_bloqueado', `Este cliente está bloqueado: ${blocked.reason}`);

  const history = phoneOk ? await customerHistory(ctx.companyId, phone) : summarizeHistory({ delivered: 0, returned: 0, cancelled: 0, refused: 0, open: 0 });
  if (history.risk === 'alto' || history.risk === 'medio') warnings.push(history.message);
  for (const i of checkContact(phone, b.customerName).filter((x) => x.severity === 'aviso')) warnings.push(i.message);

  // Mismo teléfono con un pedido abierto: suele ser un duplicado.
  const dup = phoneOk ? (await db.query(`SELECT code FROM hermes_orders WHERE company_id = $1 AND phone = $2 AND status NOT IN ('entregado', 'devuelto', 'cancelado') LIMIT 1`, [ctx.companyId, phone])).rows[0] : null;
  if (dup) warnings.push(`Posible duplicado: este teléfono ya tiene abierto el pedido ${dup.code}.`);

  return { phone, fullAddress, addressCheck, history, duplicateOf: (dup?.code as string | undefined) ?? null, errors, warnings, errorCode };
}

export async function createOrder(ctx: OrderActor, b: OrderData, pre: Awaited<ReturnType<typeof inspectOrder>>, source: string) {
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
  const { rows } = await db.query(
    `INSERT INTO hermes_orders (company_id, code, customer_name, phone, address, city, department, notes, items, total, payment, seller_user_id, external_ref, created_by, address_check, customer_risk, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17) RETURNING *`,
    [
      ctx.companyId, code, b.customerName, pre.phone, pre.fullAddress, pre.addressCheck.city?.name ?? b.city, b.department || pre.addressCheck.city?.department || '', b.notes,
      JSON.stringify(b.items), total, b.payment, sellerId, b.externalRef, ctx.userId, JSON.stringify(pre.addressCheck), pre.history.risk, source,
    ],
  );
  const order: bot.Order = rows[0];
  await bot.logEvent(order, 'creado', source === 'importacion' ? `Pedido importado por ${ctx.name}` : `Pedido creado por ${ctx.name}`, ctx.name);
  if (pre.duplicateOf) await bot.setAttention(order, `Posible duplicado: este teléfono ya tiene abierto el pedido ${pre.duplicateOf}`);
  else if (pre.history.risk === 'alto') await bot.setAttention(order, `Cliente de riesgo: ${pre.history.message}`);
  if (pre.addressCheck.level !== 'completa') await bot.logEvent(order, 'direccion_por_revisar', pre.addressCheck.issues.map((i) => i.message).join(' '));
  await bot.startConfirmation(order);
  return { id: order.id, code, possibleDuplicateOf: pre.duplicateOf, addressLevel: pre.addressCheck.level, customerRisk: pre.history.risk };
}

/** Una fila de la importación en lote, tal como llega de la hoja de cálculo. */
const importRow = z.object({
  customerName: z.string().max(120).default(''),
  phone: z.string().max(25).default(''),
  address: z.string().max(300).default(''),
  neighborhood: z.string().max(80).default(''),
  city: z.string().max(80).default(''),
  products: z.string().max(400).default(''),
  total: z.union([z.number(), z.string()]).default(0),
  payment: z.string().max(30).default(''),
  notes: z.string().max(300).default(''),
  seller: z.string().max(200).default(''),
  externalRef: z.string().max(120).default(''),
});
const importBody = z.object({ rows: z.array(importRow).min(1).max(300) });

/** Convierte una fila de la hoja en un pedido, resolviendo la vendedora por nombre o correo. */
async function rowToOrder(ctx: Ctx, row: z.infer<typeof importRow>, sellers: { id: string; name: string; email: string }[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const total = Math.round(Number(String(row.total).replace(/[^\d]/g, '')) || 0);
  const paid = /pag/i.test(row.payment) && !/contra/i.test(row.payment);
  if (!row.customerName.trim()) errors.push('Falta el nombre del cliente.');
  if (!row.products.trim()) errors.push('Faltan los productos.');
  if (!total && !paid) errors.push('Falta el valor a cobrar.');
  let sellerUserId: string | null = null;
  if (row.seller.trim()) {
    const key = row.seller.trim().toLowerCase();
    const found = sellers.find((s) => s.email.toLowerCase() === key || s.name.toLowerCase() === key) ?? sellers.find((s) => s.name.toLowerCase().includes(key));
    if (found) sellerUserId = found.id;
    else warnings.push(`No se encontró la vendedora «${row.seller.trim()}»: el pedido quedará sin atribuir.`);
  }
  const parsed = orderBody.safeParse({
    customerName: row.customerName, phone: row.phone, address: row.address, neighborhood: row.neighborhood, city: row.city, notes: row.notes,
    payment: paid ? 'pagado' : 'contraentrega', sellerUserId, externalRef: row.externalRef,
    items: [{ free: true, name: row.products.trim() || 'x', qty: 1, price: total }],
  });
  if (!parsed.success) {
    const field: Record<string, string> = { customerName: 'el nombre', phone: 'el teléfono', address: 'la dirección', city: 'la ciudad' };
    for (const issue of parsed.error.issues) {
      const f = field[String(issue.path[0])];
      if (f && !errors.some((e) => e.includes(f.split(' ')[1]))) errors.push(`Revisa ${f}.`);
    }
    return { order: null, pre: null, errors: errors.length ? errors : ['Datos no válidos.'], warnings };
  }
  const pre = await inspectOrder(ctx, parsed.data);
  return { order: parsed.data, pre, errors: [...errors, ...pre.errors], warnings: [...warnings, ...pre.warnings] };
}

export function hermesRoutes(app: FastifyInstance): void {
  // ───────── Pedidos ─────────
  app.get('/api/hermes/orders', guard(), async (req) => {
    const q = parse(
      z.object({ status: z.enum(STATUSES).optional(), attention: z.enum(['1']).optional(), operator: z.uuid().or(z.literal('ninguno')).optional(), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(300).default(150) }),
      req.query,
    );
    if (req.ctx.role === 'seller') {
      const p: unknown[] = [req.ctx.companyId, req.ctx.userId];
      let w = '';
      if (q.attention) w += ' AND o.correction_requested_at IS NOT NULL';
      if (q.q) {
        p.push(`%${q.q.toLowerCase()}%`);
        w += ` AND (lower(o.customer_name) LIKE $3 OR o.phone LIKE $3 OR lower(o.code) LIKE $3)`;
      }
      p.push(q.limit);
      const [list, totals] = await Promise.all([
        db.query(`SELECT ${SELLER_COLUMNS} FROM hermes_orders o WHERE o.company_id = $1 AND o.seller_user_id = $2 ${w} ORDER BY (o.correction_requested_at IS NOT NULL) DESC, o.created_at DESC LIMIT $${p.length}`, p),
        db.query(`SELECT count(*)::int AS total, (count(*) FILTER (WHERE correction_requested_at IS NOT NULL))::int AS "toFix" FROM hermes_orders WHERE company_id = $1 AND seller_user_id = $2`, [req.ctx.companyId, req.ctx.userId]),
      ]);
      return { orders: list.rows, mine: totals.rows[0] };
    }
    const params: unknown[] = [req.ctx.companyId];
    let where = sellerScope(req.ctx, params);
    if (q.status) {
      params.push(q.status);
      where += ` AND o.status = $${params.length}`;
    }
    if (q.attention) where += ` AND o.attention`;
    if (q.operator === 'ninguno') where += ` AND o.operator_id IS NULL`;
    else if (q.operator) {
      params.push(q.operator);
      where += ` AND o.operator_id = $${params.length}`;
    }
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
    // El historial de entregas y devoluciones del cliente es información de la empresa: la vendedora no lo ve.
    const history = phone.length >= 10 && req.ctx.role !== 'seller' ? await customerHistory(req.ctx.companyId, phone) : null;
    const blocked = phone.length >= 10 ? await blockedInfo(req.ctx.companyId, phone) : null;
    return { address, contact, history, blocked };
  });

  app.post('/api/hermes/orders', guard(), async (req) => {
    const b = parse(orderBody, req.body);
    const pre = await inspectOrder(req.ctx, b);
    if (pre.errors.length) throw new HttpError(pre.errorCode === 'cliente_bloqueado' ? 409 : 400, pre.errorCode, pre.errors.join(' '));
    const res = await createOrder(req.ctx, b, pre, 'manual');
    return req.ctx.role === 'seller' ? { id: res.id, code: res.code } : res;
  });

  app.get('/api/hermes/orders/:id', guard(), async (req) => {
    const { id } = parse(idParam, req.params);
    await loadOrder(req.ctx, id);
    if (req.ctx.role === 'seller') {
      const { rows } = await db.query(`SELECT ${SELLER_COLUMNS} FROM hermes_orders o WHERE o.id = $1`, [id]);
      return { order: rows[0] };
    }
    const [order, events, messages, incidents, settings] = await Promise.all([
      db.query(`SELECT ${ORDER_COLUMNS} FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id WHERE o.id = $1`, [id]),
      db.query(`SELECT id, at, type, detail, actor FROM hermes_events WHERE order_id = $1 ORDER BY at`, [id]),
      db.query(`SELECT id, direction, kind, template, body, buttons, status, sender, error, created_at AS "createdAt" FROM hermes_messages WHERE order_id = $1 ORDER BY created_at`, [id]),
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
        z.object({ action: z.literal('despachar'), carrier: z.string().trim().min(2).max(60), trackingNumber: z.string().trim().min(3).max(60), trackingUrl: z.url().max(300).regex(/^https?:\/\//i, 'el enlace debe empezar por http:// o https://').or(z.literal('')).default(''), operatorId: z.uuid().nullable().optional(), operatorRef: z.string().trim().max(120).default('') }),
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
      case 'despachar':
        need(['confirmado']);
        if (b.operatorId) {
          const op = await db.query(`SELECT 1 FROM hermes_operators WHERE id = $1 AND company_id = $2`, [b.operatorId, ctx.companyId]);
          if (!op.rows.length) throw badRequest('El operador indicado no existe.', 'operador_no_valido');
        }
        // Si no se indica operador, se conserva el que ya tenía asignado el pedido.
        if (b.operatorId !== undefined || b.operatorRef) {
          await db.query(`UPDATE hermes_orders SET operator_id = COALESCE($2, operator_id), operator_ref = $3 WHERE id = $1`, [id, b.operatorId ?? null, b.operatorRef]);
        }
        await bot.dispatch(o, b, ctx.name);
        break;
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

  /** Logística le pide a la vendedora que corrija un dato del pedido. */
  app.post('/api/hermes/orders/:id/request-correction', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note: z.string().trim().min(3).max(300) }), req.body);
    const o = await loadOrder(req.ctx, id);
    if (['entregado', 'devuelto', 'cancelado'].includes(o.status)) throw badRequest('El pedido ya está cerrado.', 'estado_no_valido');
    if (!(o as unknown as { seller_user_id: string | null }).seller_user_id) throw badRequest('El pedido no tiene vendedora asignada: no hay a quién pedirle la corrección.', 'sin_vendedora');
    await db.query(`UPDATE hermes_orders SET correction_note = $2, correction_requested_at = now(), correction_by = $3, corrected_at = NULL, updated_at = now() WHERE id = $1`, [id, b.note, req.ctx.name]);
    await bot.logEvent(o, 'correccion_pedida', b.note, req.ctx.name);
    return { ok: true };
  });

  /** Retira una corrección pedida (ya no hace falta). */
  app.post('/api/hermes/orders/:id/cancel-correction', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const o = await loadOrder(req.ctx, id);
    await db.query(`UPDATE hermes_orders SET correction_note = '', correction_requested_at = NULL, correction_by = '', updated_at = now() WHERE id = $1`, [id]);
    await bot.logEvent(o, 'correccion_retirada', '', req.ctx.name);
    return { ok: true };
  });

  /** La vendedora corrige los datos de un pedido suyo cuando se lo pidieron. Pasa por el mismo validador que al crearlo. */
  app.put('/api/hermes/orders/:id/correction', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({ customerName: z.string().trim().min(2).max(120), phone: z.string().trim().min(7).max(25), address: z.string().trim().min(5).max(300), city: z.string().trim().min(2).max(80), notes: z.string().trim().max(300).default('') }),
      req.body,
    );
    const o = await loadOrder(ctx, id);
    const pending = (await db.query(`SELECT correction_requested_at FROM hermes_orders WHERE id = $1`, [id])).rows[0]?.correction_requested_at;
    if (!pending) throw badRequest('Este pedido no tiene una corrección pendiente.', 'sin_correccion');
    if (['entregado', 'devuelto', 'cancelado'].includes(o.status)) throw badRequest('El pedido ya está cerrado.', 'estado_no_valido');

    const phone = bot.normalizePhone(b.phone);
    if (phone.length < 10) throw badRequest('El teléfono no parece válido. Escríbelo con indicativo o como celular de 10 dígitos.', 'telefono_invalido');
    const check = checkAddress(composeAddress(b.address, ''), b.city);
    const addressErrors = check.issues.filter((i) => i.severity === 'error');
    if (addressErrors.length) throw badRequest(`La dirección está incompleta. ${addressErrors.map((i) => i.message).join(' ')}`, 'direccion_incompleta');
    if (phone !== o.phone) {
      const blocked = await blockedInfo(ctx.companyId, phone);
      if (blocked) throw new HttpError(409, 'cliente_bloqueado', `Este cliente está bloqueado: ${blocked.reason}`);
    }

    const newAddress = composeAddress(b.address, '');
    const newCity = check.city?.name ?? b.city;
    const changes: string[] = [];
    if (b.customerName !== o.customer_name) changes.push('nombre');
    if (phone !== o.phone) changes.push('teléfono');
    if (newAddress !== o.address || newCity !== o.city) changes.push('dirección');
    if (b.notes !== o.notes) changes.push('indicaciones');
    await db.query(
      `UPDATE hermes_orders SET customer_name = $2, phone = $3, address = $4, city = $5, notes = $6, address_check = $7::jsonb,
              correction_requested_at = NULL, corrected_at = now(), updated_at = now() WHERE id = $1`,
      [id, b.customerName, phone, newAddress, newCity, b.notes, JSON.stringify(check)],
    );
    if (check.city?.department) await db.query(`UPDATE hermes_orders SET department = $2 WHERE id = $1`, [id, check.city.department]);
    const fresh = (await bot.getOrder(ctx.companyId, id))!;
    await bot.logEvent(fresh, 'corregido', changes.length ? `Cambió: ${changes.join(', ')}` : 'Revisó los datos sin cambios', ctx.name);
    // La pelota vuelve a logística: que revise la corrección antes de seguir.
    await bot.setAttention(fresh, `${ctx.name} corrigió los datos del pedido: revisar`);
    // Si el cliente aún no había confirmado, se le vuelve a pedir con los datos corregidos.
    if (fresh.status === 'por_confirmar' && changes.length) await bot.startConfirmation(fresh);
    return { ok: true };
  });

  /** Respuesta escrita por una persona, dentro de la conversación del pedido. */
  app.post('/api/hermes/orders/:id/message', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(1000) }), req.body);
    const o = await loadOrder(req.ctx, id);
    const sent = await bot.send(o, { template: '', body: b.body }, req.ctx.name);
    if (!sent.ok) throw badRequest(`No se pudo enviar: ${sent.error}. Puedes llamarlo o esperar a que escriba.`, 'no_enviado');
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

  // ───────── Importación en lote ─────────
  /**
   * Vista previa: revisa cada fila con las mismas reglas que el formulario (dirección, teléfono, bloqueados,
   * historial, duplicados) y dice cuáles se pueden crear. No crea nada.
   */
  async function inspectRows(ctx: Ctx, rows: z.infer<typeof importRow>[]) {
    const sellers = (await db.query(`SELECT id, name, email FROM core_users WHERE company_id = $1 AND status = 'active'`, [ctx.companyId])).rows;
    const seen = new Map<string, number>();
    const out = [];
    for (const [index, row] of rows.entries()) {
      const r = await rowToOrder(ctx, row, sellers);
      const phone = r.pre?.phone ?? bot.normalizePhone(row.phone);
      // El mismo teléfono dos veces en el archivo.
      if (phone.length >= 10) {
        if (seen.has(phone)) r.warnings.push(`El teléfono se repite en la fila ${seen.get(phone)! + 1} de este archivo.`);
        else seen.set(phone, index);
      }
      out.push({ index, ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, order: r.order, pre: r.pre, customerName: row.customerName, phone, city: r.pre?.addressCheck.city?.name ?? row.city, address: r.pre?.fullAddress ?? row.address });
    }
    return out;
  }

  app.post('/api/hermes/import/preview', guard('admin', 'supervisor'), async (req) => {
    const b = parse(importBody, req.body);
    const rows = await inspectRows(req.ctx, b.rows);
    return { total: rows.length, valid: rows.filter((r) => r.ok).length, rows: rows.map(({ order: _o, pre: _p, ...r }) => r) };
  });

  /** Crea los pedidos válidos del lote. Las filas con errores se omiten y se devuelven para corregirlas. */
  app.post('/api/hermes/import', guard('admin', 'supervisor'), async (req) => {
    const b = parse(importBody, req.body);
    const rows = await inspectRows(req.ctx, b.rows);
    const created: { index: number; code: string }[] = [];
    const skipped: { index: number; customerName: string; errors: string[] }[] = [];
    for (const r of rows) {
      if (!r.ok || !r.order) {
        skipped.push({ index: r.index, customerName: r.customerName, errors: r.errors });
        continue;
      }
      // Se vuelve a revisar justo antes de crear: una fila anterior del mismo lote puede haber abierto un pedido para ese teléfono.
      const pre = await inspectOrder(req.ctx, r.order);
      if (pre.errors.length) {
        skipped.push({ index: r.index, customerName: r.customerName, errors: pre.errors });
        continue;
      }
      const res = await createOrder(req.ctx, r.order, pre, 'importacion');
      created.push({ index: r.index, code: res.code });
    }
    await auditBy(req.ctx, { action: 'hermes.importacion', entityType: 'empresa', entityId: req.ctx.companyId, summary: `Importó ${created.length} pedidos (${skipped.length} omitidos)`, metadata: { creados: created.length, omitidos: skipped.length } });
    return { created, skipped };
  });

  // ───────── Clientes bloqueados ─────────
  app.get('/api/hermes/blocked', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(
      `SELECT b.phone, b.name, b.reason, b.created_at AS "createdAt", u.name AS "createdByName",
              (SELECT count(*)::int FROM hermes_orders o WHERE o.company_id = b.company_id AND o.phone = b.phone) AS orders,
              (SELECT count(*)::int FROM hermes_orders o WHERE o.company_id = b.company_id AND o.phone = b.phone AND o.status = 'entregado') AS delivered,
              (SELECT count(*)::int FROM hermes_orders o WHERE o.company_id = b.company_id AND o.phone = b.phone AND o.status = 'devuelto') AS returned
         FROM hermes_blocked b LEFT JOIN core_users u ON u.id = b.created_by
        WHERE b.company_id = $1 ORDER BY b.created_at DESC`,
      [req.ctx.companyId],
    );
    return { blocked: rows };
  });

  app.post('/api/hermes/blocked', guard('admin', 'supervisor'), async (req) => {
    const b = parse(z.object({ phone: z.string().trim().min(7).max(25), reason: z.string().trim().min(3).max(200), name: z.string().trim().max(120).default('') }), req.body);
    const phone = bot.normalizePhone(b.phone);
    if (phone.length < 10) throw badRequest('El teléfono no parece válido.');
    // Si no se indicó nombre, se toma del último pedido de ese número.
    const known = b.name || (await db.query(`SELECT customer_name FROM hermes_orders WHERE company_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT 1`, [req.ctx.companyId, phone])).rows[0]?.customer_name || '';
    await db.query(
      `INSERT INTO hermes_blocked (company_id, phone, name, reason, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, phone) DO UPDATE SET reason = EXCLUDED.reason, name = EXCLUDED.name`,
      [req.ctx.companyId, phone, known, b.reason, req.ctx.userId],
    );
    await auditBy(req.ctx, { action: 'hermes.cliente_bloqueado', entityType: 'cliente', entityId: phone, summary: `Bloqueó al cliente ${known || phone}: ${b.reason}` });
    return { ok: true, phone };
  });

  app.delete('/api/hermes/blocked/:phone', guard('admin', 'supervisor'), async (req) => {
    const { phone } = parse(z.object({ phone: z.string().regex(/^\d{10,15}$/) }), req.params);
    const { count } = await db.query(`DELETE FROM hermes_blocked WHERE company_id = $1 AND phone = $2`, [req.ctx.companyId, phone]);
    if (!count) throw notFound('Ese número no está bloqueado.');
    await auditBy(req.ctx, { action: 'hermes.cliente_desbloqueado', entityType: 'cliente', entityId: phone, summary: `Desbloqueó al cliente ${phone}` });
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
    const [totals, bySeller, byCity, byCarrier, byIncident, messages, timing, byOperator] = await Promise.all([
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
      db.query(`SELECT op.name AS name, ${agg} FROM hermes_orders o JOIN hermes_operators op ON op.id = o.operator_id WHERE ${since} GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`, args),
    ]);
    const num = (r: Record<string, unknown>) => ({ ...r, deliveredValue: Number(r.deliveredValue ?? 0) });
    return {
      days: q.days,
      totals: num(totals.rows[0]),
      bySeller: bySeller.rows.map(num),
      byCity: byCity.rows.map(num),
      byCarrier: byCarrier.rows.map(num),
      byOperator: byOperator.rows.map(num),
      byIncident: byIncident.rows.map((r) => ({ ...r, label: bot.INCIDENT_LABEL[r.type] ?? r.type })),
      messages: messages.rows[0],
      minutesToConfirm: timing.rows[0]?.minutesToConfirm ?? null,
    };
  });

  // ───────── Ajustes ─────────
  app.get('/api/hermes/settings', guard('admin', 'supervisor'), async (req) => ({ settings: await bot.settingsOf(req.ctx.companyId) }));

  app.put('/api/hermes/settings', guard('admin'), async (req) => {
    const b = parse(z.object({ reminderMinutes: z.array(z.number().int().min(5).max(2880)).max(4), escalateMinutes: z.number().int().min(15).max(4320), noReplyAction: z.enum(['persona', 'confirmar']).default('persona'), botName: z.string().trim().max(30).regex(/^[\p{L} .'-]*$/u, 'el nombre solo puede llevar letras').default('') }), req.body);
    const before = await bot.settingsOf(req.ctx.companyId);
    await db.query(
      `INSERT INTO hermes_settings (company_id, reminder_minutes, escalate_minutes, bot_name, no_reply_action) VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (company_id) DO UPDATE SET reminder_minutes = EXCLUDED.reminder_minutes, escalate_minutes = EXCLUDED.escalate_minutes, bot_name = EXCLUDED.bot_name, no_reply_action = EXCLUDED.no_reply_action`,
      [req.ctx.companyId, JSON.stringify(b.reminderMinutes), b.escalateMinutes, b.botName, b.noReplyAction],
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
