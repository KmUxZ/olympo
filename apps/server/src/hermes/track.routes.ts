// Hermes · enlace público al PDF de la guía. Lo abre el cliente desde WhatsApp, sin sesión: la clave del
// enlace es al azar e imposible de adivinar, y lo único que hace es llevar al PDF que entrega el operador.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/db.ts';
import { guidePdf, HokoError } from './hoko-api.ts';

/** El enlace del PDF que da el operador caduca a los 7 días: se reutiliza hasta 5 y después se pide uno nuevo. */
const PDF_MAX_AGE_MS = 5 * 86_400_000;
const page = (title: string, text: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#141a26}main{max-width:420px;margin:16px;padding:24px;background:#fff;border:1px solid #dfe3ea;border-radius:14px}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;color:#5d6677;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export function trackRoutes(app: FastifyInstance): void {
  /** Abre el PDF de la guía del pedido: consulta el enlace vigente al operador y redirige a él. */
  app.get('/g/:token', async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const html = (status: number, title: string, text: string) => reply.status(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(page(title, text));
    if (!/^[A-Za-z0-9_-]{12,40}$/.test(token)) return html(404, 'No encontramos esa guía', 'Revisa que el enlace esté completo. Ábrelo directamente desde el mensaje de WhatsApp.');
    const { rows } = await db.query(
      `SELECT o.id, o.operator_id, o.operator_ref, o.guide_pdf_url, o.guide_pdf_at, (op.api_password IS NOT NULL) AS connected
         FROM hermes_orders o JOIN core_companies c ON c.id = o.company_id LEFT JOIN hermes_operators op ON op.id = o.operator_id
        WHERE o.track_token = $1 AND c.status = 'active' AND c.products ? 'hermes'`,
      [token],
    );
    const o = rows[0];
    if (!o) return html(404, 'No encontramos esa guía', 'Revisa que el enlace esté completo. Ábrelo directamente desde el mensaje de WhatsApp.');
    const go = (url: string) => reply.header('cache-control', 'no-store').redirect(url, 302);
    const fresh = o.guide_pdf_url && o.guide_pdf_at && Date.now() - new Date(o.guide_pdf_at).getTime() < PDF_MAX_AGE_MS;
    if (fresh && /^https:\/\//i.test(o.guide_pdf_url)) return go(o.guide_pdf_url);
    if (!o.connected || !o.operator_ref) return html(404, 'La guía no está disponible', 'Si la necesitas, respóndenos en el mismo chat de WhatsApp y te la enviamos.');
    try {
      const url = await guidePdf(o.operator_id, o.operator_ref);
      if (!url) return html(503, 'Tu guía se está generando', 'Vuelve a abrir este enlace en unos minutos.');
      await db.query(`UPDATE hermes_orders SET guide_pdf_url = $2, guide_pdf_at = now() WHERE id = $1`, [o.id, url]);
      return go(url);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, code: err instanceof HokoError ? err.code : undefined }, 'no se pudo obtener el PDF de la guía');
      // Si el operador falla pero hay un enlace anterior, se intenta con ese.
      if (o.guide_pdf_url && /^https:\/\//i.test(o.guide_pdf_url)) return go(o.guide_pdf_url);
      return html(503, 'No pudimos abrir la guía en este momento', 'Intenta de nuevo en unos minutos. Si sigue igual, respóndenos en el chat de WhatsApp.');
    }
  });
}
