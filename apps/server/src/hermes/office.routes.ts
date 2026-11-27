// Hermes · bandeja de pedidos que esperan en una oficina de la transportadora. Es la lista de trabajo de quien
// les hace seguimiento: cuántos días llevan, qué respondió el cliente y qué gestión se hizo.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { badRequest, guard, notFound, parse } from '../core/http.ts';
import * as bot from './bot.ts';

const idParam = z.object({ id: z.uuid() });

export function officeRoutes(app: FastifyInstance): void {
  app.get('/api/hermes/office', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(
      `SELECT o.id, o.code, o.customer_name AS "customerName", o.phone, o.city, o.carrier, o.tracking_number AS "trackingNumber", o.total, o.payment, o.status,
              o.attention, o.attention_reason AS "attentionReason", o.office_reminders AS reminders, u.name AS "sellerName",
              (SELECT op.name FROM hermes_operators op WHERE op.id = o.operator_id) AS "operatorName",
              (SELECT max(e.at) FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'en_oficina') AS since,
              (SELECT e.detail FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'oficina_respuesta' ORDER BY e.at DESC LIMIT 1) AS "lastAnswer",
              (SELECT e.at FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'oficina_gestion' ORDER BY e.at DESC LIMIT 1) AS "noteAt",
              (SELECT e.detail FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'oficina_gestion' ORDER BY e.at DESC LIMIT 1) AS note,
              (SELECT e.actor FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'oficina_gestion' ORDER BY e.at DESC LIMIT 1) AS "noteBy"
         FROM hermes_orders o LEFT JOIN core_users u ON u.id = o.seller_user_id
        WHERE o.company_id = $1 AND o.status IN ('despachado', 'en_reparto', 'novedad')
          -- Sigue en oficina mientras el operador no informe otro estado (o, si se marcó a mano, mientras no se cierre).
          AND o.operator_state IN ('', '10')
          AND EXISTS (SELECT 1 FROM hermes_events e WHERE e.order_id = o.id AND e.type = 'en_oficina')
        ORDER BY since ASC LIMIT 500`,
      [req.ctx.companyId],
    );
    return { orders: rows, now: new Date().toISOString() };
  });

  /** Deja constancia de una gestión hecha con el cliente (llamada, mensaje, acuerdo). */
  app.post('/api/hermes/orders/:id/office-note', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note: z.string().trim().min(2).max(300) }), req.body);
    const o = await bot.getOrder(req.ctx.companyId, id);
    if (!o) throw notFound('Pedido no encontrado.');
    await bot.logEvent(o, 'oficina_gestion', b.note, req.ctx.name);
    // Quedó gestionado: sale de «necesita atención» hasta que pase algo nuevo.
    await db.query(`UPDATE hermes_orders SET attention = false, attention_reason = '', updated_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Marca a mano que el paquete está en oficina (operadores sin avisos automáticos) y le avisa al cliente. */
  app.post('/api/hermes/orders/:id/office', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const o = await bot.getOrder(req.ctx.companyId, id);
    if (!o) throw notFound('Pedido no encontrado.');
    if (!['despachado', 'en_reparto'].includes(o.status)) throw badRequest('Solo aplica a un pedido despachado o en reparto.', 'estado_no_valido');
    const sent = await bot.readyForPickup(o, req.ctx.name);
    return { ok: true, notified: sent };
  });
}
