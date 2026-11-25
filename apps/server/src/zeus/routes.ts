// Zeus · CRM de clientes y recompra.
// Un cliente es un teléfono. Su historial sale de los pedidos de Hermes; Zeus añade etiquetas, notas y seguimientos.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, forbidden, guard, notFound, parse } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';
import { localParts } from '../core/time.ts';

export const SEGMENTS = ['vip', 'recurrente', 'una_vez', 'en_proceso', 'sin_entrega', 'riesgoso', 'bloqueado'] as const;
const OUTCOMES = ['compro', 'interesado', 'no_interesado', 'no_contesta'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const todayOf = (ctx: Ctx) => {
  const p = localParts(ctx.company.timezone, new Date());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};
const phoneParam = z.object({ phone: z.string().regex(/^\d{8,15}$/) });
const idParam = z.object({ id: z.uuid() });
const dayRe = /^\d{4}-\d{2}-\d{2}$/;
const cleanTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

/**
 * Clientes de una empresa ($1) con sus cifras, calculados de los pedidos.
 * Segmento, del más urgente de mirar al menos:
 *  bloqueado → está en la lista de bloqueados · riesgoso → 2 o más pedidos fallidos (devueltos o cancelados) y no menos que los entregados ·
 *  vip → 3 o más entregas · recurrente → 2 · una_vez → 1 · en_proceso → aún no recibe pero tiene un pedido en curso · sin_entrega → nunca recibió.
 */
const CUSTOMERS = `(
  SELECT c.*, (b.phone IS NOT NULL) AS blocked, coalesce(b.reason, '') AS blocked_reason, coalesce(p.tags, '[]'::jsonb) AS tags, u.name AS seller_name,
         (SELECT count(*)::int FROM zeus_followups f WHERE f.company_id = $1 AND f.phone = c.phone AND f.status = 'pendiente') AS pending_followups,
         CASE WHEN b.phone IS NOT NULL THEN 'bloqueado'
              WHEN c.returned + c.cancelled >= 2 AND c.returned + c.cancelled >= c.delivered THEN 'riesgoso'
              WHEN c.delivered >= 3 THEN 'vip'
              WHEN c.delivered = 2 THEN 'recurrente'
              WHEN c.delivered = 1 THEN 'una_vez'
              WHEN c.open > 0 THEN 'en_proceso'
              ELSE 'sin_entrega' END AS segment
    FROM (
      SELECT o.phone,
             (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS name,
             (array_agg(o.city ORDER BY o.created_at DESC))[1] AS city,
             (array_agg(o.seller_user_id ORDER BY o.created_at DESC) FILTER (WHERE o.seller_user_id IS NOT NULL))[1] AS seller_id,
             count(*)::int AS orders,
             (count(*) FILTER (WHERE o.status = 'entregado'))::int AS delivered,
             (count(*) FILTER (WHERE o.status = 'devuelto'))::int AS returned,
             (count(*) FILTER (WHERE o.status = 'cancelado'))::int AS cancelled,
             (count(*) FILTER (WHERE o.status NOT IN ('entregado', 'devuelto', 'cancelado')))::int AS open,
             coalesce(sum(o.total) FILTER (WHERE o.status = 'entregado'), 0)::bigint AS value,
             min(o.created_at) AS first_at, max(o.created_at) AS last_at, max(o.delivered_at) AS last_delivered_at
        FROM hermes_orders o WHERE o.company_id = $1 GROUP BY o.phone
    ) c
    LEFT JOIN hermes_blocked b ON b.company_id = $1 AND b.phone = c.phone
    LEFT JOIN zeus_profiles p ON p.company_id = $1 AND p.phone = c.phone
    LEFT JOIN core_users u ON u.id = c.seller_id
)`;
const COLUMNS = `x.phone, x.name, x.city, x.orders, x.delivered, x.returned, x.cancelled, x.open, x.value, x.first_at AS "firstAt", x.last_at AS "lastAt",
  x.last_delivered_at AS "lastDeliveredAt", x.segment, x.blocked, x.tags, x.seller_id AS "sellerId", x.seller_name AS "sellerName", x.pending_followups AS "pendingFollowups"`;
const num = <T extends { value?: unknown }>(r: T) => ({ ...r, value: Number(r.value ?? 0) });

async function repurchaseDays(companyId: string): Promise<number> {
  return (await db.query(`SELECT repurchase_days FROM zeus_settings WHERE company_id = $1`, [companyId])).rows[0]?.repurchase_days ?? 30;
}
/** Clientes a los que conviene volver a ofrecerles: ya recibieron, no tienen nada en curso, no son riesgosos y nadie los tiene pendientes. */
const OPPORTUNITY = `x.delivered >= 1 AND x.open = 0 AND x.segment NOT IN ('bloqueado', 'riesgoso') AND x.pending_followups = 0
  AND x.last_delivered_at <= now() - ($2 || ' days')::interval`;

async function assertSeller(ctx: Ctx, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const { rows } = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2 AND status = 'active'`, [userId, ctx.companyId]);
  if (!rows.length) throw badRequest('La persona asignada no es una cuenta activa de tu empresa.', 'persona_no_valida');
}
async function customerName(companyId: string, phone: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT customer_name FROM hermes_orders WHERE company_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT 1`, [companyId, phone]);
  return rows[0]?.customer_name ?? null;
}

export function zeusRoutes(app: FastifyInstance): void {
  // ───────── Resumen ─────────
  app.get('/api/zeus/summary', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const days = await repurchaseDays(ctx.companyId);
    const [segments, totals, opportunities, followups] = await Promise.all([
      db.query(`SELECT x.segment, count(*)::int AS customers, coalesce(sum(x.value), 0)::bigint AS value FROM ${CUSTOMERS} x GROUP BY x.segment`, [ctx.companyId]),
      db.query(
        `SELECT count(*)::int AS customers, (count(*) FILTER (WHERE x.delivered >= 1))::int AS buyers, (count(*) FILTER (WHERE x.delivered >= 2))::int AS repeat,
                coalesce(sum(x.value), 0)::bigint AS value, coalesce(sum(x.delivered), 0)::int AS deliveries
           FROM ${CUSTOMERS} x`,
        [ctx.companyId],
      ),
      db.query(`SELECT count(*)::int AS n FROM ${CUSTOMERS} x WHERE ${OPPORTUNITY}`, [ctx.companyId, String(days)]),
      db.query(
        `SELECT (count(*) FILTER (WHERE status = 'pendiente'))::int AS pending, (count(*) FILTER (WHERE status = 'pendiente' AND due_on < $2))::int AS overdue,
                (count(*) FILTER (WHERE status = 'hecho' AND done_at >= now() - interval '30 days'))::int AS done30,
                (count(*) FILTER (WHERE status = 'hecho' AND outcome = 'compro' AND done_at >= now() - interval '30 days'))::int AS bought30
           FROM zeus_followups WHERE company_id = $1`,
        [ctx.companyId, todayOf(ctx)],
      ),
    ]);
    const t = totals.rows[0];
    return {
      repurchaseDays: days,
      totals: { customers: t.customers, buyers: t.buyers, repeat: t.repeat, value: Number(t.value), averageTicket: t.deliveries ? Math.round(Number(t.value) / t.deliveries) : 0, repeatRate: t.buyers ? Math.round((t.repeat / t.buyers) * 100) : 0 },
      segments: SEGMENTS.map((s) => ({ segment: s, customers: segments.rows.find((r) => r.segment === s)?.customers ?? 0, value: Number(segments.rows.find((r) => r.segment === s)?.value ?? 0) })),
      opportunities: opportunities.rows[0].n,
      followups: followups.rows[0],
    };
  });

  // ───────── Clientes ─────────
  app.get('/api/zeus/customers', guard('admin', 'supervisor'), async (req) => {
    const q = parse(
      z.object({
        q: z.string().trim().max(80).default(''),
        segment: z.enum(SEGMENTS).optional(),
        tag: z.string().trim().toLowerCase().max(30).optional(),
        sort: z.enum(['reciente', 'valor', 'pedidos']).default('reciente'),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        size: z.coerce.number().int().min(1).max(5000).default(50),
      }),
      req.query,
    );
    const params: unknown[] = [req.ctx.companyId];
    let where = 'true';
    if (q.segment) {
      params.push(q.segment);
      where += ` AND x.segment = $${params.length}`;
    }
    if (q.tag) {
      params.push(JSON.stringify([q.tag]));
      where += ` AND x.tags @> $${params.length}::jsonb`;
    }
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      where += ` AND (x.name ILIKE $${params.length} OR x.city ILIKE $${params.length}`;
      if (digits.length >= 4) {
        params.push(`%${digits}%`);
        where += ` OR x.phone LIKE $${params.length}`;
      }
      where += ')';
    }
    const order = { reciente: 'x.last_at DESC', valor: 'x.value DESC, x.last_at DESC', pedidos: 'x.orders DESC, x.last_at DESC' }[q.sort];
    params.push(q.size, (q.page - 1) * q.size);
    const { rows } = await db.query(
      `SELECT ${COLUMNS}, count(*) OVER ()::int AS total FROM ${CUSTOMERS} x WHERE ${where} ORDER BY ${order}, x.phone LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: rows[0]?.total ?? 0, page: q.page, size: q.size, customers: rows.map(({ total: _t, ...r }) => num(r)) };
  });

  app.get('/api/zeus/customers/:phone', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const { phone } = parse(phoneParam, req.params);
    const customer = (await db.query(`SELECT ${COLUMNS}, x.blocked_reason AS "blockedReason" FROM ${CUSTOMERS} x WHERE x.phone = $2`, [ctx.companyId, phone])).rows[0];
    if (!customer) throw notFound('Cliente no encontrado.');
    const [orders, notes, followups] = await Promise.all([
      db.query(
        `SELECT o.id, o.code, o.status, o.total, o.items, o.city, o.address, o.payment, o.source, o.created_at AS "createdAt", o.delivered_at AS "deliveredAt", u.name AS "sellerName"
           FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id WHERE o.company_id = $1 AND o.phone = $2 ORDER BY o.created_at DESC LIMIT 100`,
        [ctx.companyId, phone],
      ),
      db.query(`SELECT id, body, author_name AS "authorName", created_at AS "createdAt" FROM zeus_notes WHERE company_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT 100`, [ctx.companyId, phone]),
      db.query(
        `SELECT f.id, f.title, f.due_on AS "dueOn", f.status, f.outcome, f.result, f.assigned_user_id AS "assignedUserId", u.name AS "assignedName", f.created_at AS "createdAt", f.done_at AS "doneAt"
           FROM zeus_followups f LEFT JOIN core_users u ON u.id = f.assigned_user_id WHERE f.company_id = $1 AND f.phone = $2 ORDER BY (f.status = 'pendiente') DESC, f.due_on DESC LIMIT 100`,
        [ctx.companyId, phone],
      ),
    ]);
    return { customer: num(customer), orders: orders.rows, notes: notes.rows, followups: followups.rows, today: todayOf(ctx) };
  });

  app.put('/api/zeus/customers/:phone', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const { phone } = parse(phoneParam, req.params);
    const b = parse(z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(30) }), req.body);
    if (!(await customerName(ctx.companyId, phone))) throw notFound('Cliente no encontrado.');
    const tags = cleanTags(b.tags);
    await db.query(
      `INSERT INTO zeus_profiles (company_id, phone, tags) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, phone) DO UPDATE SET tags = EXCLUDED.tags, updated_at = now()`,
      [ctx.companyId, phone, JSON.stringify(tags)],
    );
    return { tags };
  });

  app.post('/api/zeus/customers/:phone/notes', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const { phone } = parse(phoneParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(2).max(1000) }), req.body);
    if (!(await customerName(ctx.companyId, phone))) throw notFound('Cliente no encontrado.');
    const { rows } = await db.query(`INSERT INTO zeus_notes (company_id, phone, body, author_id, author_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [ctx.companyId, phone, b.body, ctx.userId, ctx.name]);
    return { id: rows[0].id };
  });

  app.get('/api/zeus/tags', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(`SELECT t.tag, count(*)::int AS customers FROM zeus_profiles p, jsonb_array_elements_text(p.tags) AS t(tag) WHERE p.company_id = $1 GROUP BY t.tag ORDER BY count(*) DESC, t.tag LIMIT 100`, [req.ctx.companyId]);
    return { tags: rows };
  });

  // ───────── Recompra ─────────
  app.get('/api/zeus/opportunities', guard('admin', 'supervisor'), async (req) => {
    const days = await repurchaseDays(req.ctx.companyId);
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${CUSTOMERS} x WHERE ${OPPORTUNITY} ORDER BY x.value DESC, x.last_delivered_at LIMIT 300`, [req.ctx.companyId, String(days)]);
    return { repurchaseDays: days, customers: rows.map(num) };
  });

  // ───────── Seguimientos ─────────
  const followupBody = z.object({
    title: z.string().trim().min(3).max(160),
    dueOn: z.string().regex(dayRe).refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)), 'fecha no válida'),
    /** null = sin asignar; ausente = quien le vendió la última vez. */
    assignedUserId: z.uuid().nullable().optional(),
  });

  /** Crea el mismo seguimiento para uno o varios clientes (por ejemplo, todos los elegidos en «Recompra»). */
  app.post('/api/zeus/followups', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const b = parse(followupBody.extend({ phones: z.array(z.string().regex(/^\d{8,15}$/)).min(1).max(300) }), req.body);
    await assertSeller(ctx, b.assignedUserId);
    const phones = [...new Set(b.phones)];
    const known = await db.query(
      `SELECT x.phone, x.name, x.seller_id FROM ${CUSTOMERS} x WHERE x.phone IN (SELECT jsonb_array_elements_text($2::jsonb))`,
      [ctx.companyId, JSON.stringify(phones)],
    );
    if (known.rows.length !== phones.length) throw badRequest('Alguno de los clientes elegidos no existe.', 'cliente_no_valido');
    // Solo se hereda la vendedora de la última venta si su cuenta sigue activa.
    const active = new Set((await db.query(`SELECT id FROM core_users WHERE company_id = $1 AND status = 'active'`, [ctx.companyId])).rows.map((r) => r.id as string));
    await db.tx(async (t) => {
      for (const c of known.rows) {
        const assignee = b.assignedUserId !== undefined ? b.assignedUserId : c.seller_id && active.has(c.seller_id) ? c.seller_id : null;
        await t.query(`INSERT INTO zeus_followups (company_id, phone, customer_name, title, due_on, assigned_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ctx.companyId, c.phone, c.name, b.title, b.dueOn, assignee, ctx.userId]);
      }
    });
    await auditBy(ctx, { action: 'zeus.seguimientos_creados', entityType: 'seguimiento', summary: `Creó ${known.rows.length} seguimiento(s): «${b.title}»`, metadata: { clientes: known.rows.length, para: b.dueOn } });
    return { created: known.rows.length };
  });

  /** Vendedora: solo los suyos y sin el historial del cliente. Administración y supervisión: todos, con filtros. */
  app.get('/api/zeus/followups', guard(), async (req) => {
    const ctx = req.ctx;
    const q = parse(z.object({ status: z.enum(['pendiente', 'hecho', 'descartado']).default('pendiente'), assignedUserId: z.uuid().optional() }), req.query);
    const params: unknown[] = [ctx.companyId, q.status];
    let where = '';
    const mine = ctx.role === 'seller' ? ctx.userId : q.assignedUserId;
    if (mine) {
      params.push(mine);
      where = ` AND f.assigned_user_id = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT f.id, f.phone, f.customer_name AS "customerName", f.title, f.due_on AS "dueOn", f.status, f.outcome, f.result, f.assigned_user_id AS "assignedUserId", u.name AS "assignedName", f.done_at AS "doneAt"
         FROM zeus_followups f LEFT JOIN core_users u ON u.id = f.assigned_user_id
        WHERE f.company_id = $1 AND f.status = $2 ${where}
        ORDER BY ${q.status === 'pendiente' ? 'f.due_on, f.created_at' : 'f.done_at DESC NULLS LAST'} LIMIT 500`,
      params,
    );
    return { today: todayOf(ctx), followups: rows };
  });

  app.patch('/api/zeus/followups/:id', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        status: z.enum(['pendiente', 'hecho', 'descartado']).optional(),
        outcome: z.enum(OUTCOMES).optional(),
        result: z.string().trim().max(500).optional(),
        dueOn: z.string().regex(dayRe).optional(),
        assignedUserId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    const f = (await db.query(`SELECT * FROM zeus_followups WHERE id = $1 AND company_id = $2`, [id, ctx.companyId])).rows[0];
    if (!f) throw notFound('Seguimiento no encontrado.');
    if (ctx.role === 'seller') {
      if (f.assigned_user_id !== ctx.userId) throw forbidden();
      if (b.assignedUserId !== undefined || b.dueOn !== undefined) throw forbidden('Solo tu supervisora puede reasignar o cambiar la fecha.');
    }
    if (b.status === 'hecho' && !(b.outcome ?? f.outcome)) throw badRequest('Indica qué pasó con el cliente.', 'falta_resultado');
    await assertSeller(ctx, b.assignedUserId);
    const status = b.status ?? f.status;
    await db.query(
      `UPDATE zeus_followups SET status = $2, outcome = $3, result = $4, due_on = $5, assigned_user_id = $6, done_at = CASE WHEN $2 = 'pendiente' THEN NULL WHEN status = 'pendiente' THEN now() ELSE done_at END WHERE id = $1`,
      [id, status, status === 'pendiente' ? '' : (b.outcome ?? f.outcome), b.result ?? f.result, b.dueOn ?? f.due_on, b.assignedUserId !== undefined ? b.assignedUserId : f.assigned_user_id],
    );
    return { ok: true };
  });

  // ───────── Ajustes ─────────
  app.get('/api/zeus/settings', guard('admin', 'supervisor'), async (req) => ({ repurchaseDays: await repurchaseDays(req.ctx.companyId) }));
  app.put('/api/zeus/settings', guard('admin'), async (req) => {
    const b = parse(z.object({ repurchaseDays: z.number().int().min(1).max(365) }), req.body);
    await db.query(`INSERT INTO zeus_settings (company_id, repurchase_days) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET repurchase_days = EXCLUDED.repurchase_days`, [req.ctx.companyId, b.repurchaseDays]);
    await auditBy(req.ctx, { action: 'zeus.ajustes', entityType: 'empresa', entityId: req.ctx.companyId, summary: `Zeus propone recompra a los ${b.repurchaseDays} días de la última entrega` });
    return { repurchaseDays: b.repurchaseDays };
  });
}
