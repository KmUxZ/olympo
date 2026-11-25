// Hermes · conexión del canal de WhatsApp (Pancake) y entrada de los mensajes de los clientes.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, guard, parse } from '../core/http.ts';
import { encryptSecret } from '../core/secrets.ts';
import { newToken } from '../core/security.ts';
import { publicUrl } from '../argos/extension.routes.ts';
import * as bot from './bot.ts';
import * as pancake from './pancake.ts';

const KNOWN = new Set(bot.TEMPLATES.map((t) => t.key));
const REQUIRED = bot.TEMPLATES.filter((t) => t.required);

async function view(companyId: string) {
  const { rows } = await db.query(`SELECT driver, pancake_page_id, pancake_token IS NOT NULL AS has_token, webhook_key, templates FROM hermes_settings WHERE company_id = $1`, [companyId]);
  const r = rows[0];
  const templates: Record<string, string> = r?.templates ?? {};
  const missing = [
    ...(r?.pancake_page_id && r?.has_token ? [] : ['Conectar la página de Pancake']),
    ...REQUIRED.filter((t) => !templates[t.key]).map((t) => `Plantilla «${t.title}»`),
  ];
  return {
    driver: (r?.driver as string) ?? 'simulado',
    pageId: (r?.pancake_page_id as string) ?? '',
    hasToken: Boolean(r?.has_token),
    webhookUrl: r?.webhook_key ? `${publicUrl()}/api/hermes/webhook/pancake/${r.webhook_key}` : null,
    templates,
    missing,
    catalog: bot.TEMPLATES.map(({ sample: _s, ...t }) => t),
  };
}

// Un cliente que escribe dos mensajes seguidos: el segundo espera a que termine el primero.
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, run);
  void run.finally(() => queues.get(key) === run && queues.delete(key)).catch(() => {});
  return run;
}

export function channelRoutes(app: FastifyInstance): void {
  app.get('/api/hermes/channel', guard('admin'), async (req) => view(req.ctx.companyId));

  /** Guarda la página, el token y las plantillas. No activa el envío: eso es un paso aparte. */
  app.put('/api/hermes/channel', guard('admin'), async (req) => {
    const ctx = req.ctx;
    const b = parse(
      z.object({
        pageId: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,80}$/, 'el identificador de la página no es válido'),
        token: z.string().trim().min(10).max(600).optional(),
        templates: z.record(z.string(), z.string().trim().max(80)).default({}),
      }),
      req.body,
    );
    const current = await bot.channelOf(ctx.companyId);
    const token = b.token ?? (current.channel?.pageId === b.pageId ? current.channel.token : undefined);
    if (!token) throw badRequest('Pega el token de acceso de la página (Pancake → Configuración → Herramientas → Public API).', 'falta_token');
    const check = await pancake.checkConnection({ pageId: b.pageId, token });
    if (!check.ok) throw badRequest(check.error ?? 'No se pudo comprobar la conexión con Pancake.', 'pancake_rechazo');

    const templates = Object.fromEntries(Object.entries(b.templates).filter(([k, id]) => KNOWN.has(k) && id));
    await db.query(
      `INSERT INTO hermes_settings (company_id, pancake_page_id, pancake_token, webhook_key, templates) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (company_id) DO UPDATE SET pancake_page_id = EXCLUDED.pancake_page_id, pancake_token = EXCLUDED.pancake_token,
         webhook_key = COALESCE(hermes_settings.webhook_key, EXCLUDED.webhook_key), templates = EXCLUDED.templates`,
      [ctx.companyId, b.pageId, encryptSecret(token), newToken(), JSON.stringify(templates)],
    );
    await auditBy(ctx, { action: 'hermes.canal_configurado', entityType: 'empresa', entityId: ctx.companyId, summary: `Configuró el canal de WhatsApp de Hermes (página ${b.pageId})`, metadata: { pageId: b.pageId, plantillas: Object.keys(templates), tokenCambiado: Boolean(b.token) } });
    return view(ctx.companyId);
  });

  /** Enciende o apaga el envío real. Encender exige la conexión y las plantillas obligatorias. */
  app.post('/api/hermes/channel/activate', guard('admin'), async (req) => {
    const ctx = req.ctx;
    const b = parse(z.object({ active: z.boolean() }), req.body);
    if (b.active) {
      const v = await view(ctx.companyId);
      if (v.missing.length) throw badRequest(`Antes de activar falta: ${v.missing.join('; ')}.`, 'canal_incompleto');
    }
    await db.query(`INSERT INTO hermes_settings (company_id, driver) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET driver = EXCLUDED.driver`, [ctx.companyId, b.active ? 'pancake' : 'simulado']);
    await auditBy(ctx, { action: b.active ? 'hermes.canal_activado' : 'hermes.canal_desactivado', entityType: 'empresa', entityId: ctx.companyId, summary: b.active ? 'Activó el envío real por WhatsApp en Hermes' : 'Volvió Hermes al modo simulado' });
    return view(ctx.companyId);
  });

  /** Envía una plantilla de ejemplo a un número (normalmente el propio), para comprobar que quedó bien registrada. */
  app.post('/api/hermes/channel/test', guard('admin'), async (req) => {
    const ctx = req.ctx;
    const b = parse(z.object({ phone: z.string().trim().min(7).max(25), template: z.string() }), req.body);
    const t = bot.TEMPLATES.find((x) => x.key === b.template);
    if (!t) throw badRequest('Plantilla desconocida.');
    const ch = await bot.channelOf(ctx.companyId);
    if (!ch.channel) throw badRequest('Primero conecta la página de Pancake.', 'canal_incompleto');
    const id = ch.templates[t.key];
    if (!id) throw badRequest(`Primero guarda el identificador de la plantilla «${t.title}».`, 'sin_plantilla');
    const phone = bot.normalizePhone(b.phone);
    if (!/^\d{10,15}$/.test(phone)) throw badRequest('El número no es válido. Escríbelo con indicativo, por ejemplo 573001234567.');
    const res = await pancake.sendTemplate(ch.channel, phone, id, t.sample);
    await auditBy(ctx, { action: 'hermes.canal_prueba', entityType: 'empresa', entityId: ctx.companyId, summary: `Envió una prueba de la plantilla «${t.title}» (${res.ok ? 'enviada' : 'falló'})`, metadata: { plantilla: t.key, terminaEn: phone.slice(-4) } });
    if (!res.ok) throw badRequest(`${res.error}. Revisa que el identificador sea el de la plantilla aprobada y que sus variables se llamen igual que en el texto.`, 'prueba_fallida');
    return { ok: true, preview: bot.renderTemplate(t.key, t.sample) };
  });

  app.delete('/api/hermes/channel', guard('admin'), async (req) => {
    await db.query(`UPDATE hermes_settings SET driver = 'simulado', pancake_token = NULL, webhook_key = NULL WHERE company_id = $1`, [req.ctx.companyId]);
    await auditBy(req.ctx, { action: 'hermes.canal_desconectado', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Desconectó el canal de WhatsApp de Hermes' });
    return view(req.ctx.companyId);
  });

  // ───────── Avisos de Pancake (mensajes que llegan) ─────────
  // Pancake no firma sus avisos: la dirección lleva una clave secreta por empresa y cada mensaje se comprueba contra la API antes de actuar.
  async function companyOfKey(key: string) {
    if (!/^[A-Za-z0-9_-]{30,80}$/.test(key)) return null;
    const { rows } = await db.query(
      `SELECT s.company_id, s.driver, s.pancake_page_id FROM hermes_settings s JOIN core_companies c ON c.id = s.company_id
        WHERE s.webhook_key = $1 AND c.status = 'active' AND c.products ? 'hermes'`,
      [key],
    );
    return rows[0] ?? null;
  }

  // Pancake comprueba la dirección al configurarla.
  app.get('/api/hermes/webhook/pancake/:key', async (req, reply) => ((await companyOfKey(String((req.params as { key?: string }).key ?? ''))) ? { ok: true } : reply.status(404).send({ error: { code: 'no_encontrado', message: 'No encontrado.' } })));

  app.post('/api/hermes/webhook/pancake/:key', async (req, reply) => {
    const company = await companyOfKey(String((req.params as { key?: string }).key ?? ''));
    if (!company) return reply.status(404).send({ error: { code: 'no_encontrado', message: 'No encontrado.' } });
    const event = req.body as any;
    // Se responde de inmediato (Pancake suspende el aviso si tardamos o fallamos) y se procesa después.
    setImmediate(() => {
      void processEvent(company, event).catch((err) => req.log.error(err, 'aviso de Pancake no procesado'));
    });
    return { ok: true };
  });

  async function processEvent(company: { company_id: string; driver: string; pancake_page_id: string }, event: any): Promise<void> {
    if (company.driver !== 'pancake' || event?.event_type !== 'messaging') return;
    const msg = event?.data?.message;
    const conv = event?.data?.conversation;
    if (!msg?.id || String(event.page_id ?? msg.page_id ?? '') !== company.pancake_page_id) return;
    if ((msg.type ?? conv?.type ?? 'INBOX') !== 'INBOX') return;
    const conversation = String(msg.conversation_id ?? conv?.id ?? '');
    const phone = pancake.phoneOf(conversation);
    if (!phone) return;
    const externalId = String(msg.id).slice(0, 200);

    await inOrder(`${company.company_id}|${phone}`, async () => {
      const seen = await db.query(`SELECT 1 FROM hermes_messages WHERE company_id = $1 AND external_id = $2`, [company.company_id, externalId]);
      if (seen.rows.length) return; // ya procesado (Pancake puede repetir avisos) o es un mensaje que envió Hermes
      const ch = await bot.channelOf(company.company_id);
      if (!ch.channel) return;
      const checked = await pancake.verifyMessage(ch.channel, conversation, externalId);
      const raw = typeof msg.original_message === 'string' && msg.original_message ? msg.original_message : typeof msg.message === 'string' ? msg.message : '';
      const text = (checked.text ?? raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) || (Array.isArray(msg.attachments) && msg.attachments.length ? '[Archivo adjunto]' : '');
      if (!text) return;
      if (checked.sender === 'equipo') {
        if (checked.staffName) await bot.recordStaffMessage(company.company_id, phone, text, checked.staffName, externalId);
        return;
      }
      await bot.handleInbound(company.company_id, phone, { text, payload: bot.payloadOfLabel(text) }, { externalId, observeOnly: checked.sender === 'desconocido' });
    });
  }
}
