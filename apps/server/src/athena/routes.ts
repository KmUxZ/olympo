// Athena · rutas: ajustes, catálogo, preguntas frecuentes, conversaciones y simulador.
// Administrador y supervisor gestionan Athena; los ajustes de fondo los cambia solo el administrador.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, guard, notFound, parse } from '../core/http.ts';
import { aiReady } from './brain.ts';
import * as engine from './engine.ts';

const idParam = z.object({ id: z.uuid() });
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

const productBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  price: z.number().int().min(0).max(100_000_000),
  offers: z.string().trim().max(600).default(''),
  active: z.boolean().default(true),
});
const faqBody = z.object({ question: z.string().trim().min(3).max(300), answer: z.string().trim().min(2).max(1500), active: z.boolean().default(true) });

export function athenaRoutes(app: FastifyInstance): void {
  // ───────── Ajustes ─────────
  app.get('/api/athena/settings', guard('admin', 'supervisor'), async (req) => {
    const hermes = req.ctx.company.products.includes('hermes');
    return { settings: await engine.settingsOf(req.ctx.companyId), aiReady: aiReady(), hermesActive: hermes, models: MODELS };
  });

  app.put('/api/athena/settings', guard('admin'), async (req) => {
    const b = parse(
      z.object({
        enabled: z.boolean(),
        assistantName: z.string().trim().min(2).max(40),
        businessAbout: z.string().trim().max(2000),
        tone: z.string().trim().max(300),
        shippingPolicy: z.string().trim().max(2000),
        paymentPolicy: z.string().trim().max(1500),
        extraRules: z.string().trim().max(3000),
        model: z.enum(MODELS),
        createOrders: z.boolean(),
      }),
      req.body,
    );
    await db.query(
      `INSERT INTO athena_settings (company_id, enabled, assistant_name, business_about, tone, shipping_policy, payment_policy, extra_rules, model, create_orders)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id) DO UPDATE SET enabled = $2, assistant_name = $3, business_about = $4, tone = $5, shipping_policy = $6, payment_policy = $7, extra_rules = $8, model = $9, create_orders = $10`,
      [req.ctx.companyId, b.enabled, b.assistantName, b.businessAbout, b.tone, b.shippingPolicy, b.paymentPolicy, b.extraRules, b.model, b.createOrders],
    );
    await auditBy(req.ctx, { action: 'athena.ajustes', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Cambió los ajustes de Athena' });
    return { ok: true };
  });

  // ───────── Catálogo ─────────
  app.get('/api/athena/products', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(`SELECT id, name, description, price, offers, active FROM athena_products WHERE company_id = $1 ORDER BY active DESC, created_at`, [req.ctx.companyId]);
    return { products: rows };
  });
  app.post('/api/athena/products', guard('admin', 'supervisor'), async (req) => {
    const b = parse(productBody, req.body);
    const { rows } = await db.query(`INSERT INTO athena_products (company_id, name, description, price, offers, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [req.ctx.companyId, b.name, b.description, b.price, b.offers, b.active]);
    await auditBy(req.ctx, { action: 'athena.producto_creado', entityType: 'producto', entityId: rows[0].id, summary: `Añadió «${b.name}» al catálogo de Athena` });
    return { id: rows[0].id };
  });
  app.put('/api/athena/products/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(productBody, req.body);
    const r = await db.query(`UPDATE athena_products SET name = $3, description = $4, price = $5, offers = $6, active = $7 WHERE id = $1 AND company_id = $2 RETURNING id`, [id, req.ctx.companyId, b.name, b.description, b.price, b.offers, b.active]);
    if (!r.rows.length) throw notFound('Producto no encontrado.');
    await auditBy(req.ctx, { action: 'athena.producto_editado', entityType: 'producto', entityId: id, summary: `Editó «${b.name}» en el catálogo de Athena (precio ${b.price})` });
    return { ok: true };
  });
  app.delete('/api/athena/products/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`DELETE FROM athena_products WHERE id = $1 AND company_id = $2 RETURNING name`, [id, req.ctx.companyId]);
    if (!r.rows.length) throw notFound('Producto no encontrado.');
    await auditBy(req.ctx, { action: 'athena.producto_eliminado', entityType: 'producto', entityId: id, summary: `Quitó «${r.rows[0].name}» del catálogo de Athena` });
    return { ok: true };
  });

  // ───────── Preguntas frecuentes ─────────
  app.get('/api/athena/knowledge', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(`SELECT id, question, answer, active FROM athena_knowledge WHERE company_id = $1 ORDER BY active DESC, created_at`, [req.ctx.companyId]);
    return { items: rows };
  });
  app.post('/api/athena/knowledge', guard('admin', 'supervisor'), async (req) => {
    const b = parse(faqBody, req.body);
    const { rows } = await db.query(`INSERT INTO athena_knowledge (company_id, question, answer, active) VALUES ($1, $2, $3, $4) RETURNING id`, [req.ctx.companyId, b.question, b.answer, b.active]);
    return { id: rows[0].id };
  });
  app.put('/api/athena/knowledge/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(faqBody, req.body);
    const r = await db.query(`UPDATE athena_knowledge SET question = $3, answer = $4, active = $5 WHERE id = $1 AND company_id = $2 RETURNING id`, [id, req.ctx.companyId, b.question, b.answer, b.active]);
    if (!r.rows.length) throw notFound('Pregunta no encontrada.');
    return { ok: true };
  });
  app.delete('/api/athena/knowledge/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`DELETE FROM athena_knowledge WHERE id = $1 AND company_id = $2 RETURNING id`, [id, req.ctx.companyId]);
    if (!r.rows.length) throw notFound('Pregunta no encontrada.');
    return { ok: true };
  });

  // ───────── Conversaciones ─────────
  app.get('/api/athena/conversations', guard('admin', 'supervisor'), async (req) => {
    const q = parse(z.object({ view: z.enum(['persona', 'bot', 'cerrada', 'prueba']).optional(), q: z.string().trim().max(80).optional() }), req.query);
    const params: unknown[] = [req.ctx.companyId];
    let where = '';
    if (q.view === 'prueba') where += ' AND c.is_test';
    else {
      where += ' AND NOT c.is_test';
      if (q.view === 'persona') where += ` AND c.status = 'humano'`;
      if (q.view === 'bot') where += ` AND c.status = 'bot'`;
      if (q.view === 'cerrada') where += ` AND c.status = 'cerrada'`;
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (lower(c.customer_name) LIKE $2 OR c.phone LIKE $2)`;
    }
    const [list, counts] = await Promise.all([
      db.query(
        `SELECT c.id, c.phone, c.customer_name AS "customerName", c.is_test AS "isTest", c.status, c.attention, c.handoff_reason AS "handoffReason", c.taken_by AS "takenBy",
                c.order_code AS "orderCode", c.last_message_at AS "lastMessageAt",
                m.body AS "lastBody", m.role AS "lastRole"
           FROM athena_conversations c
           LEFT JOIN LATERAL (SELECT body, role FROM athena_messages x WHERE x.conversation_id = c.id AND x.role <> 'sistema' ORDER BY x.created_at DESC, x.id DESC LIMIT 1) m ON true
          WHERE c.company_id = $1 ${where}
          ORDER BY c.attention DESC, c.last_message_at DESC LIMIT 200`,
        params,
      ),
      db.query(
        `SELECT (count(*) FILTER (WHERE NOT is_test AND status = 'humano'))::int AS persona,
                (count(*) FILTER (WHERE NOT is_test AND attention))::int AS attention,
                (count(*) FILTER (WHERE NOT is_test AND status = 'bot'))::int AS bot,
                (count(*) FILTER (WHERE NOT is_test AND order_code <> ''))::int AS orders,
                (count(*) FILTER (WHERE NOT is_test))::int AS total,
                (count(*) FILTER (WHERE is_test))::int AS tests
           FROM athena_conversations WHERE company_id = $1`,
        [req.ctx.companyId],
      ),
    ]);
    return { conversations: list.rows, counts: counts.rows[0], aiReady: aiReady() };
  });

  app.get('/api/athena/conversations/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const c = await engine.getConversation(req.ctx.companyId, id);
    if (!c) throw notFound('Conversación no encontrada.');
    const messages = await db.query(`SELECT id, role, body, sender, meta, created_at AS "createdAt" FROM athena_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [id]);
    await db.query(`UPDATE athena_conversations SET seen_at = now() WHERE id = $1`, [id]);
    const raw = c as unknown as Record<string, unknown>;
    return {
      conversation: {
        id: c.id, phone: c.phone, customerName: c.customer_name, isTest: c.is_test, status: c.status, attention: c.attention, handoffReason: raw.handoff_reason, takenBy: raw.taken_by,
        draft: c.draft, orderId: c.order_id, orderCode: c.order_code,
      },
      messages: messages.rows,
    };
  });

  /** Una persona escribe en la conversación. Al hacerlo la toma: Athena deja de responder ahí. */
  app.post('/api/athena/conversations/:id/message', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(1500) }), req.body);
    const c = await engine.getConversation(req.ctx.companyId, id);
    if (!c) throw notFound('Conversación no encontrada.');
    const { driver } = await engine.settingsOf(req.ctx.companyId);
    // El envío real se conecta cuando se configure el número; hasta entonces queda registrado como simulado.
    await engine.addMessage(c, 'persona', b.body, req.ctx.name, { status: c.is_test || driver === 'simulado' ? 'simulado' : 'pendiente_de_canal' });
    await db.query(`UPDATE athena_conversations SET status = 'humano', attention = false, taken_by = $2 WHERE id = $1`, [id, req.ctx.name]);
    return { ok: true };
  });

  /** Tomar la conversación (Athena se calla) o devolvérsela a Athena. */
  app.post('/api/athena/conversations/:id/takeover', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ human: z.boolean() }), req.body);
    const c = await engine.getConversation(req.ctx.companyId, id);
    if (!c) throw notFound('Conversación no encontrada.');
    if (b.human) {
      await db.query(`UPDATE athena_conversations SET status = 'humano', taken_by = $2 WHERE id = $1`, [id, req.ctx.name]);
      await engine.addMessage(c, 'sistema', `${req.ctx.name} tomó la conversación.`);
    } else {
      await db.query(`UPDATE athena_conversations SET status = 'bot', attention = false, handoff_reason = '', taken_by = '' WHERE id = $1`, [id]);
      await engine.addMessage(c, 'sistema', `${req.ctx.name} le devolvió la conversación a Athena.`);
    }
    return { ok: true };
  });

  app.post('/api/athena/conversations/:id/close', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(idParam, req.params);
    const c = await engine.getConversation(req.ctx.companyId, id);
    if (!c) throw notFound('Conversación no encontrada.');
    await db.query(`UPDATE athena_conversations SET status = 'cerrada', attention = false WHERE id = $1`, [id]);
    await engine.addMessage(c, 'sistema', `${req.ctx.name} cerró la conversación.`);
    return { ok: true };
  });

  /**
   * Entrada de un mensaje real de cliente. Es el punto que usará el canal de WhatsApp cuando se conecte;
   * mientras el canal sea simulado, el administrador puede usarla para ensayar el recorrido completo
   * (aquí sí se crea el pedido en Hermes).
   */
  app.post('/api/athena/inbound', guard('admin'), async (req) => {
    const b = parse(z.object({ phone: z.string().trim().min(7).max(25), name: z.string().trim().max(120).default(''), text: z.string().trim().min(1).max(1000) }), req.body);
    const { driver } = await engine.settingsOf(req.ctx.companyId);
    if (driver !== 'simulado') throw badRequest('Con el canal conectado, los mensajes entran por WhatsApp.', 'canal_conectado');
    const c = await engine.openConversation(req.ctx.companyId, b.phone, b.name, false);
    const result = await engine.handleInbound(req.ctx.companyId, c.id, b.text);
    return { conversationId: c.id, ...result };
  });

  /**
   * Probar Athena: escribe como si fueras el cliente. Las conversaciones de prueba van aparte,
   * no crean pedidos reales en Hermes y no le escriben a nadie.
   */
  app.post('/api/athena/simulate', guard('admin', 'supervisor'), async (req) => {
    const b = parse(z.object({ conversationId: z.uuid().optional(), text: z.string().trim().min(1).max(1000) }), req.body);
    let c: engine.Conversation | null;
    if (b.conversationId) {
      c = await engine.getConversation(req.ctx.companyId, b.conversationId);
      if (!c) throw notFound('Conversación no encontrada.');
      if (!c.is_test) throw badRequest('Solo se puede simular al cliente en conversaciones de prueba.', 'no_es_prueba');
    } else {
      // Un número ficticio distinto por prueba, para que cada una empiece de cero.
      const n = (await db.query(`SELECT count(*)::int AS n FROM athena_conversations WHERE company_id = $1 AND is_test`, [req.ctx.companyId])).rows[0].n;
      c = await engine.openConversation(req.ctx.companyId, `57300000${String(1000 + n).slice(-4)}`, `Cliente de prueba ${n + 1}`, true);
    }
    const result = await engine.handleInbound(req.ctx.companyId, c.id, b.text);
    return { conversationId: c.id, ...result };
  });
}
