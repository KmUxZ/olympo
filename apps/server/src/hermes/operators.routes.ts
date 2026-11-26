// Hermes · operadores logísticos: las plataformas por las que sale cada pedido, la asignación
// de pedidos a un operador y la subida de guías en lote desde el archivo que entrega el operador.
// El cruce entre el archivo y los pedidos es solo por teléfono del cliente.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, inIds } from '../db/db.ts';
import { auditBy, badRequest, guard, notFound, parse } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';
import * as bot from './bot.ts';

const idParam = z.object({ id: z.uuid() });
const operatorBody = z.object({
  name: z.string().trim().min(2).max(60),
  carrier: z.string().trim().max(60).default(''),
  active: z.boolean().default(true),
});

interface Operator { id: string; name: string; carrier: string; driver: string; active: boolean }

async function operatorOf(companyId: string, id: string): Promise<Operator> {
  const { rows } = await db.query<Operator>(`SELECT id, name, carrier, driver, active FROM hermes_operators WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!rows[0]) throw notFound('Operador no encontrado.');
  return rows[0];
}

/** Una fila del archivo de guías, tal como llega de la hoja. */
const guideRow = z.object({
  phone: z.string().max(25).default(''),
  trackingNumber: z.string().max(60).default(''),
  operatorRef: z.string().max(120).default(''),
  carrier: z.string().max(60).default(''),
  customerName: z.string().max(120).default(''),
});
const guidesBody = z.object({ operatorId: z.uuid(), rows: z.array(guideRow).min(1).max(500) });

interface GuideResult {
  index: number; ok: boolean; phone: string; trackingNumber: string; customerName: string; code: string | null; detail: string;
  orderId: string | null; carrier: string; operatorRef: string;
}

/** Revisa cada fila contra los pedidos confirmados de la empresa. No cambia nada. */
async function inspectGuides(ctx: Ctx, operator: Operator, rows: z.infer<typeof guideRow>[]): Promise<GuideResult[]> {
  const phones = [...new Set(rows.map((r) => bot.normalizePhone(r.phone)).filter((p) => p.length >= 10))];
  const { rows: open } = await db.query<{ id: string; code: string; phone: string; status: string; customer_name: string; operator_id: string | null; tracking_number: string }>(
    `SELECT id, code, phone, status, customer_name, operator_id, tracking_number FROM hermes_orders
      WHERE company_id = $1 AND status NOT IN ('entregado', 'devuelto', 'cancelado') AND phone IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [ctx.companyId, JSON.stringify(phones)],
  );
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const phone = bot.normalizePhone(row.phone);
    const trackingNumber = row.trackingNumber.trim();
    const base = { index, phone, trackingNumber, customerName: row.customerName.trim(), carrier: row.carrier.trim() || operator.carrier || operator.name, operatorRef: row.operatorRef.trim() };
    const fail = (detail: string, code: string | null = null): GuideResult => ({ ...base, ok: false, code, detail, orderId: null });
    if (phone.length < 10) return fail('El teléfono no es válido.');
    if (trackingNumber.length < 3) return fail('Falta el número de guía.');
    if (seen.has(phone)) return fail(`El teléfono se repite en la fila ${seen.get(phone)! + 1} de este archivo.`);
    seen.set(phone, index);
    const mine = open.filter((o) => o.phone === phone);
    const ready = mine.filter((o) => o.status === 'confirmado');
    if (ready.length > 1) return fail(`Hay ${ready.length} pedidos confirmados con ese teléfono (${ready.map((o) => o.code).join(', ')}): asigna la guía a mano.`);
    if (!ready.length) {
      const same = mine.find((o) => o.tracking_number === trackingNumber);
      if (same) return fail('Ese pedido ya tenía esta guía.', same.code);
      const waiting = mine.find((o) => o.status === 'por_confirmar');
      if (waiting) return fail('El cliente aún no ha confirmado el pedido.', waiting.code);
      if (mine.length) return fail(`El pedido ya fue despachado con otra guía (${mine[0].tracking_number || 'sin número'}).`, mine[0].code);
      return fail('No hay un pedido confirmado con ese teléfono.');
    }
    const o = ready[0];
    if (o.operator_id && o.operator_id !== operator.id) return fail('El pedido está asignado a otro operador.', o.code);
    return { ...base, ok: true, code: o.code, customerName: o.customer_name, detail: '', orderId: o.id };
  });
}

export function operatorRoutes(app: FastifyInstance): void {
  app.get('/api/hermes/operators', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(
      `SELECT op.id, op.name, op.carrier, op.driver, op.active,
              (SELECT count(*)::int FROM hermes_orders o WHERE o.operator_id = op.id AND o.status = 'confirmado') AS "toDispatch",
              (SELECT count(*)::int FROM hermes_orders o WHERE o.operator_id = op.id AND o.status IN ('despachado', 'en_reparto', 'novedad')) AS "onTheWay"
         FROM hermes_operators op WHERE op.company_id = $1 ORDER BY op.active DESC, op.name`,
      [req.ctx.companyId],
    );
    const none = await db.query(`SELECT count(*)::int AS n FROM hermes_orders WHERE company_id = $1 AND operator_id IS NULL AND status = 'confirmado'`, [req.ctx.companyId]);
    return { operators: rows, unassignedToDispatch: none.rows[0].n };
  });

  app.post('/api/hermes/operators', guard('admin'), async (req) => {
    const b = parse(operatorBody, req.body);
    const dup = await db.query(`SELECT 1 FROM hermes_operators WHERE company_id = $1 AND lower(name) = lower($2)`, [req.ctx.companyId, b.name]);
    if (dup.rows.length) throw badRequest('Ya hay un operador con ese nombre.', 'operador_repetido');
    const { rows } = await db.query(`INSERT INTO hermes_operators (company_id, name, carrier, active) VALUES ($1, $2, $3, $4) RETURNING id`, [req.ctx.companyId, b.name, b.carrier, b.active]);
    await auditBy(req.ctx, { action: 'hermes.operador_creado', entityType: 'operador', entityId: rows[0].id, summary: `Creó el operador logístico ${b.name}` });
    return { id: rows[0].id };
  });

  app.patch('/api/hermes/operators/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(operatorBody, req.body);
    const prev = await operatorOf(req.ctx.companyId, id);
    const dup = await db.query(`SELECT 1 FROM hermes_operators WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3`, [req.ctx.companyId, b.name, id]);
    if (dup.rows.length) throw badRequest('Ya hay un operador con ese nombre.', 'operador_repetido');
    await db.query(`UPDATE hermes_operators SET name = $2, carrier = $3, active = $4 WHERE id = $1`, [id, b.name, b.carrier, b.active]);
    await auditBy(req.ctx, { action: 'hermes.operador_editado', entityType: 'operador', entityId: id, summary: `Editó el operador logístico ${prev.name}${prev.active !== b.active ? (b.active ? ' (activado)' : ' (desactivado)') : ''}` });
    return { ok: true };
  });

  /** La persona encargada decide por qué operador sale cada pedido. Solo pedidos que aún no se despachan. */
  app.post('/api/hermes/orders/assign-operator', guard('admin', 'supervisor'), async (req) => {
    const b = parse(z.object({ orderIds: z.array(z.uuid()).min(1).max(300), operatorId: z.uuid().nullable() }), req.body);
    const operator = b.operatorId ? await operatorOf(req.ctx.companyId, b.operatorId) : null;
    if (operator && !operator.active) throw badRequest('Ese operador está desactivado.', 'operador_inactivo');
    const { rows } = await db.query<bot.Order & { operator_id: string | null }>(
      `SELECT * FROM hermes_orders WHERE company_id = $1 AND status IN ('por_confirmar', 'confirmado') AND id ${inIds(2)}`,
      [req.ctx.companyId, JSON.stringify(b.orderIds)],
    );
    let assigned = 0;
    for (const o of rows) {
      if ((o.operator_id ?? null) === (operator?.id ?? null)) continue;
      await db.query(`UPDATE hermes_orders SET operator_id = $2, updated_at = now() WHERE id = $1`, [o.id, operator?.id ?? null]);
      await bot.logEvent(o, 'operador_asignado', operator ? `Sale por ${operator.name}` : 'Sin operador', req.ctx.name);
      assigned++;
    }
    return { assigned, skipped: b.orderIds.length - rows.length };
  });

  // ───────── Guías en lote ─────────
  app.post('/api/hermes/guides/preview', guard('admin', 'supervisor'), async (req) => {
    const b = parse(guidesBody, req.body);
    const operator = await operatorOf(req.ctx.companyId, b.operatorId);
    const rows = await inspectGuides(req.ctx, operator, b.rows);
    return { total: rows.length, valid: rows.filter((r) => r.ok).length, rows: rows.map(({ orderId: _o, ...r }) => r) };
  });

  /** Despacha los pedidos de las filas válidas: guarda operador y guía, y el bot le avisa al cliente. */
  app.post('/api/hermes/guides', guard('admin', 'supervisor'), async (req) => {
    const b = parse(guidesBody, req.body);
    const operator = await operatorOf(req.ctx.companyId, b.operatorId);
    const rows = await inspectGuides(req.ctx, operator, b.rows);
    const dispatched: { index: number; code: string }[] = [];
    const skipped: { index: number; phone: string; code: string | null; detail: string }[] = [];
    for (const r of rows) {
      // Se vuelve a leer el pedido: pudo cambiar entre la vista previa y este momento.
      const o = r.ok && r.orderId ? await bot.getOrder(req.ctx.companyId, r.orderId) : null;
      if (!o || o.status !== 'confirmado') {
        skipped.push({ index: r.index, phone: r.phone, code: r.code, detail: r.detail || 'El pedido cambió de estado mientras se revisaba.' });
        continue;
      }
      await db.query(`UPDATE hermes_orders SET operator_id = $2, operator_ref = $3 WHERE id = $1`, [o.id, operator.id, r.operatorRef]);
      await bot.dispatch(o, { carrier: r.carrier, trackingNumber: r.trackingNumber, trackingUrl: '' }, req.ctx.name);
      dispatched.push({ index: r.index, code: o.code });
    }
    await auditBy(req.ctx, {
      action: 'hermes.guias_subidas', entityType: 'operador', entityId: operator.id,
      summary: `Subió ${dispatched.length} guías de ${operator.name} (${skipped.length} omitidas)`, metadata: { despachados: dispatched.length, omitidos: skipped.length },
    });
    return { dispatched, skipped };
  });
}
