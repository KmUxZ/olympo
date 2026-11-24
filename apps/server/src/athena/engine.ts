// Athena · motor de conversación: recibe el mensaje del cliente, consulta al cerebro y ejecuta lo que pida
// (guardar datos, crear el pedido en Hermes, pasar a una persona). Todo queda escrito en la conversación.
import { db } from '../db/db.ts';
import { normalizePhone } from '../hermes/bot.ts';
import { checkAddress, composeAddress } from '../hermes/address.ts';
import { createOrder, inspectOrder, parseOrder } from '../hermes/routes.ts';
import { aiReady, replyWithAI, replyWithScript } from './brain.ts';
import type { Knowledge, Tools, Turn } from './brain.ts';

export interface Conversation {
  id: string;
  company_id: string;
  phone: string;
  customer_name: string;
  is_test: boolean;
  status: 'bot' | 'humano' | 'cerrada';
  attention: boolean;
  draft: Draft;
  order_id: string | null;
  order_code: string;
}
interface Draft { nombre?: string; direccion?: string; barrio?: string; ciudad?: string; productos?: string; total?: number; indicaciones?: string }

export async function settingsOf(companyId: string) {
  const { rows } = await db.query(`SELECT * FROM athena_settings WHERE company_id = $1`, [companyId]);
  const r = rows[0] ?? {};
  return {
    enabled: (r.enabled as boolean) ?? false,
    driver: (r.driver as string) ?? 'simulado',
    assistantName: (r.assistant_name as string) ?? 'Athena',
    businessAbout: (r.business_about as string) ?? '',
    tone: (r.tone as string) ?? '',
    shippingPolicy: (r.shipping_policy as string) ?? '',
    paymentPolicy: (r.payment_policy as string) ?? '',
    extraRules: (r.extra_rules as string) ?? '',
    model: (r.model as string) ?? 'claude-opus-5-5',
    createOrders: (r.create_orders as boolean) ?? true,
  };
}

async function companyInfo(companyId: string): Promise<{ name: string; products: string[] }> {
  const { rows } = await db.query(`SELECT name, products FROM core_companies WHERE id = $1`, [companyId]);
  return { name: rows[0]?.name ?? '', products: rows[0]?.products ?? [] };
}

async function knowledgeOf(companyId: string): Promise<{ k: Knowledge; model: string; hermes: boolean }> {
  const [s, company, products, faqs] = await Promise.all([
    settingsOf(companyId),
    companyInfo(companyId),
    db.query(`SELECT name, description, price, offers FROM athena_products WHERE company_id = $1 AND active ORDER BY created_at`, [companyId]),
    db.query(`SELECT question, answer FROM athena_knowledge WHERE company_id = $1 AND active ORDER BY created_at`, [companyId]),
  ]);
  const hermes = company.products.includes('hermes');
  return {
    model: s.model,
    hermes,
    k: {
      assistantName: s.assistantName, companyName: company.name, about: s.businessAbout, tone: s.tone, shipping: s.shippingPolicy, payment: s.paymentPolicy, rules: s.extraRules,
      canCreateOrders: s.createOrders && hermes, products: products.rows, faqs: faqs.rows,
    },
  };
}

export async function addMessage(c: { id: string; company_id: string }, role: 'cliente' | 'athena' | 'persona' | 'sistema', body: string, sender = '', meta: Record<string, unknown> = {}): Promise<void> {
  await db.query(`INSERT INTO athena_messages (company_id, conversation_id, role, body, sender, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [c.company_id, c.id, role, body, sender, JSON.stringify(meta)]);
  await db.query(`UPDATE athena_conversations SET last_message_at = now() WHERE id = $1`, [c.id]);
}

export async function getConversation(companyId: string, id: string): Promise<Conversation | null> {
  const { rows } = await db.query(`SELECT * FROM athena_conversations WHERE id = $1 AND company_id = $2`, [id, companyId]);
  return rows[0] ?? null;
}

/** La conversación abierta de un teléfono, o una nueva. */
export async function openConversation(companyId: string, rawPhone: string, name: string, isTest: boolean): Promise<Conversation> {
  const phone = normalizePhone(rawPhone);
  const found = await db.query(`SELECT * FROM athena_conversations WHERE company_id = $1 AND phone = $2 AND status <> 'cerrada' AND is_test = $3 ORDER BY created_at DESC LIMIT 1`, [companyId, phone, isTest]);
  if (found.rows[0]) return found.rows[0];
  const { rows } = await db.query(`INSERT INTO athena_conversations (company_id, phone, customer_name, is_test) VALUES ($1, $2, $3, $4) RETURNING *`, [companyId, phone, name, isTest]);
  return rows[0];
}

export async function handoff(c: Conversation, reason: string, by = 'Athena'): Promise<void> {
  if (c.status !== 'bot') return;
  await db.query(`UPDATE athena_conversations SET status = 'humano', attention = true, handoff_reason = $2 WHERE id = $1`, [c.id, reason]);
  c.status = 'humano';
  c.attention = true;
  await addMessage(c, 'sistema', `${by} pasó la conversación a una persona: ${reason}`);
}

/** Qué falta para poder crear el pedido, en palabras que entienda el cerebro. */
function missing(d: Draft): string[] {
  const out: string[] = [];
  if (!d.nombre?.trim()) out.push('nombre completo');
  if (!d.direccion?.trim()) out.push('dirección');
  if (!d.ciudad?.trim()) out.push('ciudad');
  if (!d.productos?.trim()) out.push('productos');
  if (!d.total) out.push('valor total');
  if (d.direccion?.trim() && d.ciudad?.trim()) {
    for (const i of checkAddress(composeAddress(d.direccion, d.barrio), d.ciudad).issues.filter((x) => x.severity === 'error')) out.push(i.message);
  } else if (!d.barrio?.trim()) out.push('barrio');
  return out;
}

/**
 * Valor más bajo que el catálogo permite cobrar: el producto activo más barato o la cifra más baja escrita en una oferta.
 * Protege de que un cliente convenza a la IA de anotar un precio inventado.
 */
function priceFloor(products: { price: number; offers?: string }[]): number {
  const values: number[] = [];
  for (const p of products) {
    if (p.price > 0) values.push(Number(p.price));
    for (const m of (p.offers ?? '').match(/\d{1,3}(?:[.,]\d{3})+|\d{4,}/g) ?? []) {
      const n = Number(m.replace(/[.,]/g, ''));
      if (n >= 1000) values.push(n);
    }
  }
  return values.length ? Math.min(...values) : 0;
}

function toolsFor(c: Conversation, hermes: boolean, canCreate: boolean, floor: number): Tools {
  return {
    async guardar_datos(input) {
      const d: Draft = { ...c.draft };
      for (const key of ['nombre', 'direccion', 'barrio', 'ciudad', 'productos', 'indicaciones'] as const) {
        if (typeof input[key] === 'string') d[key] = (input[key] as string).trim().slice(0, 300);
      }
      if (input.total !== undefined) d.total = Math.max(0, Math.round(Number(input.total) || 0));
      c.draft = d;
      await db.query(`UPDATE athena_conversations SET draft = $2::jsonb, customer_name = CASE WHEN $3 <> '' THEN $3 ELSE customer_name END WHERE id = $1`, [c.id, JSON.stringify(d), d.nombre ?? '']);
      const left = missing(d);
      return left.length ? `Guardado. Falta o hay que corregir: ${left.join('; ')}.` : 'Guardado. Los datos están completos: confirma el resumen con el cliente antes de crear el pedido.';
    },
    async crear_pedido() {
      if (c.order_id) return `Esta conversación ya tiene el pedido ${c.order_code}. No se crea otro.`;
      const d = c.draft;
      const left = missing(d);
      if (left.length) return `No se puede crear todavía. Falta o hay que corregir: ${left.join('; ')}.`;
      if (floor > 0 && (d.total ?? 0) < floor) {
        await handoff(c, `El total anotado ($${(d.total ?? 0).toLocaleString('es-CO')}) está por debajo de los precios del catálogo: revisar antes de crear el pedido`);
        return 'El valor del pedido no coincide con los precios del catálogo, así que no se creó. La conversación se pasó a una persona: dile al cliente que alguien del equipo le confirma el valor y el pedido.';
      }
      if (!hermes || !canCreate) {
        await handoff(c, 'Pedido listo para crear: los datos están en la conversación');
        return 'El pedido lo registra una persona del equipo. La conversación ya se le pasó: dile al cliente que en un momento le confirman.';
      }
      const parsed = parseOrder({
        customerName: d.nombre, phone: c.phone, address: d.direccion, neighborhood: d.barrio ?? '', city: d.ciudad, notes: d.indicaciones ?? '',
        items: [{ free: true, name: d.productos, qty: 1, price: d.total }], externalRef: '',
      });
      if (!parsed.success) return `No se puede crear: revisa ${parsed.error.issues.map((i) => String(i.path[0])).join(', ')}.`;
      const actor = { companyId: c.company_id, role: 'system', userId: null, name: 'Athena' };
      const pre = await inspectOrder(actor, parsed.data);
      if (pre.errorCode === 'cliente_bloqueado' && pre.errors.length) {
        await handoff(c, 'El cliente está en la lista de bloqueados');
        return 'No se puede crear el pedido para este cliente. La conversación se pasó a una persona: dile al cliente que alguien del equipo le escribe, sin dar más detalles.';
      }
      if (pre.errors.length) return `No se puede crear: ${pre.errors.join(' ')}`;
      if (c.is_test) {
        // Las pruebas no crean pedidos reales en Hermes ni le escriben a nadie.
        await addMessage(c, 'sistema', `Prueba: aquí Athena crearía el pedido en Hermes (${d.productos} · $${(d.total ?? 0).toLocaleString('es-CO')} · ${pre.fullAddress}, ${d.ciudad}).`);
        c.order_code = 'PRUEBA';
        await db.query(`UPDATE athena_conversations SET order_code = 'PRUEBA' WHERE id = $1`, [c.id]);
        return 'Pedido creado (número de prueba). Avísale al cliente que recibirá la confirmación de despachos.';
      }
      const res = await createOrder(actor, parsed.data, pre, 'athena');
      c.order_id = res.id;
      c.order_code = res.code;
      await db.query(`UPDATE athena_conversations SET order_id = $2, order_code = $3 WHERE id = $1`, [c.id, res.id, res.code]);
      await addMessage(c, 'sistema', `Athena creó el pedido ${res.code} en Hermes.`);
      return `Pedido ${res.code} creado. Avísale al cliente que recibirá un mensaje de confirmación del área de despachos.`;
    },
    async pasar_a_humano(reason) {
      await handoff(c, reason.trim().slice(0, 200) || 'Athena pasó la conversación');
      return 'Conversación pasada a una persona del equipo.';
    },
  };
}

// Un mensaje a la vez por conversación: si el cliente escribe dos seguidos, el segundo espera al primero.
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

/** Llega un mensaje del cliente. Devuelve cómo quedó atendido. */
export function handleInbound(companyId: string, conversationId: string, text: string): Promise<{ answered: boolean; mode: string }> {
  return inOrder(conversationId, async () => {
    const c = await getConversation(companyId, conversationId);
    if (!c) throw new Error('Conversación no encontrada.');
    const first = (await db.query(`SELECT count(*)::int AS n FROM athena_messages WHERE conversation_id = $1 AND role = 'cliente'`, [c.id])).rows[0].n === 0;
    await addMessage(c, 'cliente', text);
    if (c.status !== 'bot') {
      // La lleva una persona (o está cerrada): Athena no responde, solo avisa que hay algo nuevo.
      if (c.status === 'cerrada') await db.query(`UPDATE athena_conversations SET status = 'humano' WHERE id = $1`, [c.id]);
      await db.query(`UPDATE athena_conversations SET attention = true WHERE id = $1`, [c.id]);
      return { answered: false, mode: 'persona' };
    }
    const { k, model, hermes } = await knowledgeOf(companyId);
    const tools = toolsFor(c, hermes, k.canCreateOrders, priceFloor(k.products));
    try {
      let out;
      if (aiReady()) {
        const history = (await db.query(`SELECT role, body FROM athena_messages WHERE conversation_id = $1 AND role <> 'sistema' ORDER BY created_at, id`, [c.id])).rows as Turn[];
        const state = `Teléfono del cliente: ${c.phone}\nDatos guardados: ${JSON.stringify(c.draft)}\n${c.order_code ? `Pedido ya creado: ${c.order_code}` : 'Aún no hay pedido creado.'}`;
        out = await replyWithAI(k, model, history, state, tools);
      } else {
        out = await replyWithScript(k, text, first, tools);
      }
      if (out.reply) await addMessage(c, 'athena', out.reply, k.assistantName, { mode: out.mode, ...(out.usage ? { usage: out.usage } : {}) });
      return { answered: Boolean(out.reply), mode: out.mode };
    } catch (err) {
      // Si Athena falla no se le inventa nada al cliente: la conversación pasa a una persona.
      await handoff(c, `Athena no pudo responder (${(err as Error).message.slice(0, 120)})`, 'El sistema');
      return { answered: false, mode: 'error' };
    }
  });
}
