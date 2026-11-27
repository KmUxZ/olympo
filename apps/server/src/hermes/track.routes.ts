// Hermes · página pública de rastreo. Quien tenga el enlace (el cliente, por WhatsApp) ve en qué va su pedido.
// No pide sesión: la clave del enlace es al azar e imposible de adivinar. Solo se devuelve lo necesario para
// seguir el envío: nunca el teléfono, la dirección ni el valor.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/db.ts';

export function trackRoutes(app: FastifyInstance): void {
  app.get('/api/hermes/track/:token', async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const missing = () => reply.status(404).send({ error: { code: 'no_encontrado', message: 'No encontramos ese pedido.' } });
    if (!/^[A-Za-z0-9_-]{12,40}$/.test(token)) return missing();
    const { rows } = await db.query(
      `SELECT c.name AS company, o.code, o.customer_name, o.city, o.status, o.carrier, o.tracking_number, o.tracking_url,
              o.created_at, o.confirmed_at, o.dispatched_at, o.out_for_delivery_at, o.delivered_at, o.returned_at, o.office_at
         FROM hermes_orders o JOIN core_companies c ON c.id = o.company_id
        WHERE o.track_token = $1 AND c.status = 'active' AND c.products ? 'hermes'`,
      [token],
    );
    const o = rows[0];
    if (!o) return missing();
    reply.header('cache-control', 'no-store');
    return {
      company: o.company, code: o.code, firstName: String(o.customer_name).trim().split(/\s+/)[0] ?? '', city: o.city, status: o.status,
      carrier: o.carrier, trackingNumber: o.tracking_number, carrierUrl: /^https?:\/\//i.test(o.tracking_url ?? '') ? o.tracking_url : '',
      inOffice: o.office_at !== null && ['despachado', 'en_reparto'].includes(o.status),
      createdAt: o.created_at, confirmedAt: o.confirmed_at, dispatchedAt: o.dispatched_at, outForDeliveryAt: o.out_for_delivery_at, deliveredAt: o.delivered_at, returnedAt: o.returned_at,
    };
  });
}
