// Hermes · motor del bot. Lleva cada pedido desde la confirmación hasta la entrega o la devolución.
// Toda la conversación pasa por aquí: lo que envía el bot, lo que responde el cliente y cuándo debe intervenir una persona.
import { db } from '../db/db.ts';
import { decryptSecret } from '../core/secrets.ts';
import { checkAddress } from './address.ts';
import * as pancake from './pancake.ts';

export const FINAL_STATUSES = ['entregado', 'devuelto', 'cancelado'];
export const INCIDENT_LABEL: Record<string, string> = {
  direccion: 'Dirección errada o incompleta',
  ausente: 'Cliente ausente',
  rehusado: 'Pedido rehusado',
  telefono: 'Teléfono no contesta o errado',
  zona: 'Zona de difícil acceso',
  otro: 'Otra novedad',
};

export interface Order {
  id: string;
  company_id: string;
  code: string;
  customer_name: string;
  phone: string;
  address: string;
  city: string;
  notes: string;
  items: { name: string; qty: number; price: number; free?: boolean }[];
  total: number;
  payment: string;
  status: string;
  awaiting: string | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  reminders_sent: number;
  last_outbound_at: Date | null;
  created_at: Date;
  last_inbound_at?: Date | null;
  address_check?: { missing?: string[] } | null;
}

interface Outgoing {
  template: string;
  body: string;
  buttons?: { label: string; payload: string }[];
  /** Variables de la plantilla de WhatsApp. Solo las tienen los avisos que pueden salir sin que el cliente haya escrito antes. */
  params?: Record<string, string>;
}

const money = (n: number) => `$${n.toLocaleString('es-CO')}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
// Un producto escrito como texto libre (p. ej. «2 fajas talla M y 1 crema») se muestra tal cual, sin cantidad delante.
const itemsText = (o: Order) => o.items.map((i) => (i.free ? i.name : `${i.qty} × ${i.name}`)).join(', ');
/** Si al validador le falta algo de la dirección, el bot se lo pide al cliente en el mismo mensaje. */
const missingLine = (o: Order) => {
  const m = o.address_check?.missing ?? [];
  return m.length ? `\nPara que llegue sin problemas nos falta ${m.join(' y ')}. Pulsa «Corregir datos» y envíanos la dirección completa.` : '';
};
const payLine = (o: Order) => (o.payment === 'pagado' ? 'Tu pedido ya está pago.' : `Total a pagar al recibir: ${money(o.total)}.`);

/** Una variable de plantilla no admite saltos de línea ni espacios repetidos. */
const v = (text: string, max = 300) => text.replace(/\s+/g, ' ').trim().slice(0, max) || '-';
const payVar = (o: Order) => (o.payment === 'pagado' ? 'Tu pedido ya está pago' : `Total a pagar al recibir: ${money(o.total)}`);
const deliveryVar = (o: Order) => (o.payment === 'pagado' ? 'Ya está pago, solo debes recibirlo' : `Ten listos ${money(o.total)} para recibirlo`);
const INCIDENT_REASON: Record<string, string> = {
  direccion: 'la transportadora no pudo ubicar la dirección',
  ausente: 'la transportadora pasó a entregarlo y no encontró a nadie',
  rehusado: 'la transportadora informa que el pedido no fue recibido',
  telefono: 'la transportadora no logró comunicarse contigo',
  zona: 'la transportadora tiene dificultades para llegar a la dirección',
  otro: 'la transportadora reportó un inconveniente',
};

/**
 * Plantillas que deben existir aprobadas en WhatsApp para poder escribirle a un cliente que no ha escrito en las últimas 24 horas.
 * El texto de aquí es el que se registra en Meta, con las variables por nombre. Las obligatorias son las que hacen avanzar el pedido.
 */
export const TEMPLATES: { key: string; title: string; required: boolean; when: string; text: string; buttons: string[]; sample: Record<string, string> }[] = [
  {
    key: 'hermes_confirmacion', title: 'Confirmación del pedido', required: true, when: 'Al crear el pedido.',
    text: 'Hola {{customer_name}} 👋 Soy {{agent_name}} de {{company}}.\n\n¡Gracias por tu compra! Estos son los datos de tu pedido {{order_code}}:\n\n🛍️ Productos: {{items}}\n📍 Dirección: {{address}}\n💵 {{payment}}\n\n¿Me confirmas que todo está bien para despacharlo?',
    buttons: ['Confirmar pedido', 'Corregir datos', 'Cancelar'],
    sample: { customer_name: 'Laura', agent_name: 'Valentina', order_code: 'H-000123', company: 'Mi Tienda', items: '2 fajas talla M', payment: 'Total a pagar al recibir: $120.000', address: 'Calle 10 # 5-20, barrio Centro, Cali' },
  },
  {
    key: 'hermes_recordatorio', title: 'Recordatorio de confirmación', required: true, when: 'Si el cliente no responde la confirmación.',
    text: 'Hola {{customer_name}}, soy {{agent_name}} otra vez 😊 Quiero asegurarme de que tu pedido {{order_code}} te llegue sin problema. Lo enviamos a: {{address}}. ¿Está todo bien para despacharlo?',
    buttons: ['Confirmar pedido', 'Corregir datos', 'Cancelar'],
    sample: { customer_name: 'Laura', agent_name: 'Valentina', order_code: 'H-000123', address: 'Calle 10 # 5-20, barrio Centro, Cali' },
  },
  {
    key: 'hermes_guia', title: 'Pedido despachado', required: true, when: 'Al despachar, con la guía.',
    text: '¡Buenas noticias! 📦 Tu pedido {{order_code}} ya va en camino.\n\n🚚 Transportadora: {{carrier}}\n🔢 Guía: {{tracking_number}}\n\nTe aviso apenas salga a reparto.',
    buttons: [],
    sample: { order_code: 'H-000123', carrier: 'Interrapidísimo', tracking_number: '240012345678' },
  },
  {
    key: 'hermes_novedad', title: 'Novedad de entrega', required: true, when: 'Cuando la transportadora reporta un problema.',
    text: 'Hola {{customer_name}}, te escribo por tu pedido {{order_code}}: {{reason}}. No te preocupes, lo resolvemos juntos. ¿Cómo prefieres que sigamos?',
    buttons: ['Reprogramar entrega', 'Corregir dirección', 'Ya no lo quiero'],
    sample: { customer_name: 'Laura', order_code: 'H-000123', reason: 'la transportadora pasó a entregarlo y no encontró a nadie' },
  },
  {
    key: 'hermes_oficina', title: 'Reclamar en oficina', required: false, when: 'Cuando el paquete queda en una oficina de la transportadora para que el cliente lo recoja.',
    text: 'Hola {{customer_name}} 📦 Tu pedido {{order_code}} ya está listo para que lo recojas en la oficina de {{carrier}} en {{city}}.\n\n🔢 Guía: {{tracking_number}}\n🪪 Lleva tu documento de identidad\n💵 {{payment}}\n\n¡Te esperamos!',
    buttons: [],
    sample: { customer_name: 'Laura', order_code: 'H-000123', carrier: 'Interrapidísimo', city: 'Cali', tracking_number: '240012345678', payment: 'Ten listos $120.000 para recibirlo' },
  },
  {
    key: 'hermes_oficina_recordatorio', title: 'Sigue en oficina', required: false, when: 'Si pasan los días y el cliente no ha reclamado el paquete en la oficina.',
    text: 'Hola {{customer_name}}, tu pedido {{order_code}} te espera hace {{days}} días en la oficina de {{carrier}} en {{city}} 📦 Si no se reclama a tiempo, la transportadora lo devuelve. ¿Vas a pasar por él?',
    buttons: ['Sí, voy a pasar', 'Ya lo recogí', 'No puedo ir'],
    sample: { customer_name: 'Laura', order_code: 'H-000123', days: '2', carrier: 'Interrapidísimo', city: 'Cali' },
  },
  {
    key: 'hermes_en_reparto', title: 'Sale a reparto', required: false, when: 'El día que el pedido sale a reparto.',
    text: '¡Hoy llega! 🚚 {{customer_name}}, tu pedido {{order_code}} sale a reparto hoy. {{payment}}. Gracias por estar pendiente.',
    buttons: [],
    sample: { customer_name: 'Laura', order_code: 'H-000123', payment: 'Ten listos $120.000 para recibirlo' },
  },
  {
    key: 'hermes_entregado', title: 'Pedido entregado', required: false, when: 'Al marcar el pedido como entregado.',
    text: '¡Entregado! 🎉 {{customer_name}}, tu pedido {{order_code}} ya está en tus manos. Gracias por confiar en nosotros.',
    buttons: [],
    sample: { customer_name: 'Laura', order_code: 'H-000123' },
  },
  {
    key: 'hermes_confirmado', title: 'Pedido confirmado', required: false, when: 'Cuando una persona del equipo confirma el pedido a mano.',
    text: '¡Listo, {{customer_name}}! ✅ Tu pedido {{order_code}} quedó confirmado. Te escribo por aquí apenas lo despachemos.',
    buttons: [],
    sample: { customer_name: 'Laura', order_code: 'H-000123' },
  },
  {
    key: 'hermes_cancelado', title: 'Pedido cancelado', required: false, when: 'Cuando una persona del equipo cancela el pedido.',
    text: 'Hola {{customer_name}}, tu pedido {{order_code}} quedó cancelado. Si fue un error, respóndeme por aquí y lo revisamos.',
    buttons: [],
    sample: { customer_name: 'Laura', order_code: 'H-000123' },
  },
];

/** El texto que el cliente recibe cuando el aviso sale como plantilla. */
export function renderTemplate(key: string, params: Record<string, string>): string {
  const t = TEMPLATES.find((x) => x.key === key);
  return t ? t.text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => params[name] ?? '') : '';
}

// Textos de los mensajes. Para envío real por WhatsApp, cada uno debe existir como plantilla aprobada por Meta
// con este mismo contenido (la clave `template` es el nombre de la plantilla).
const CONFIRM_BUTTONS = [
  { label: 'Confirmar pedido', payload: 'CONFIRMAR' },
  { label: 'Corregir datos', payload: 'CORREGIR' },
  { label: 'Cancelar', payload: 'CANCELAR' },
];
const OFFICE_BUTTONS = [
  { label: 'Sí, voy a pasar', payload: 'OFICINA_VOY' },
  { label: 'Ya lo recogí', payload: 'OFICINA_RECOGIDO' },
  { label: 'No puedo ir', payload: 'OFICINA_NO' },
];
export const MESSAGES = {
  confirmacion: (o: Order, company: string, agent: string): Outgoing => ({
    template: 'hermes_confirmacion',
    body: `Hola ${firstName(o.customer_name)} 👋 Soy ${agent} de ${company}.\n\n¡Gracias por tu compra! Estos son los datos de tu pedido ${o.code}:\n\n🛍️ Productos: ${itemsText(o)}\n📍 Dirección: ${o.address}, ${o.city}${o.notes ? ` (${o.notes})` : ''}\n💵 ${payVar(o)}${missingLine(o)}\n\n¿Me confirmas que todo está bien para despacharlo?`,
    buttons: CONFIRM_BUTTONS,
    params: { customer_name: v(firstName(o.customer_name), 60), agent_name: v(agent, 40), order_code: o.code, company: v(company, 80), items: v(itemsText(o)), payment: payVar(o), address: v(`${o.address}, ${o.city}`) },
  }),
  recordatorio: (o: Order, agent: string): Outgoing => ({
    template: 'hermes_recordatorio',
    body: `Hola ${firstName(o.customer_name)}, soy ${agent} otra vez 😊 Quiero asegurarme de que tu pedido ${o.code} te llegue sin problema. Lo enviamos a: ${o.address}, ${o.city}. ¿Está todo bien para despacharlo?`,
    buttons: CONFIRM_BUTTONS,
    params: { customer_name: v(firstName(o.customer_name), 60), agent_name: v(agent, 40), order_code: o.code, address: v(`${o.address}, ${o.city}`) },
  }),
  datos_actualizados: (o: Order): Outgoing => ({
    template: 'hermes_datos_actualizados',
    body: `¡Perfecto! Ya actualicé la dirección de tu pedido ${o.code}: ${o.address}, ${o.city}. ${payLine(o)}${missingLine(o)} ¿Así sí lo despachamos?`,
    buttons: CONFIRM_BUTTONS,
  }),
  pedir_direccion: (): Outgoing => ({ template: 'hermes_pedir_direccion', body: 'Claro que sí. Escríbeme la dirección completa en un solo mensaje, así: Calle 10 # 5-20, barrio Centro, apto 201.' }),
  direccion_incompleta: (missing: string[]): Outgoing => ({
    template: 'hermes_direccion_incompleta',
    body: `¡Gracias! Para que tu pedido llegue sin problema todavía me falta ${missing.join(' y ') || 'completar la dirección'}. Escríbemela completa así: Calle 10 # 5-20, barrio Centro, apto 201.`,
  }),
  confirmado: (o: Order): Outgoing => ({ template: 'hermes_confirmado', body: `¡Listo, ${firstName(o.customer_name)}! ✅ Tu pedido ${o.code} quedó confirmado. Te escribo por aquí apenas lo despachemos.`, params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code } }),
  cancelado: (o: Order): Outgoing => ({ template: 'hermes_cancelado', body: `Entendido, ${firstName(o.customer_name)}. Tu pedido ${o.code} quedó cancelado. Si fue un error, respóndeme por aquí y lo revisamos.`, params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code } }),
  guia: (o: Order): Outgoing => ({
    template: 'hermes_guia',
    body: `¡Buenas noticias! 📦 Tu pedido ${o.code} ya va en camino.\n\n🚚 Transportadora: ${o.carrier || 'la transportadora'}\n🔢 Guía: ${o.tracking_number}${o.tracking_url ? `\n🔗 Rastreo: ${o.tracking_url}` : ''}\n\nTe aviso apenas salga a reparto.`,
    params: { order_code: o.code, carrier: v(o.carrier || 'la transportadora', 60), tracking_number: v(o.tracking_number, 60) },
  }),
  en_reparto: (o: Order): Outgoing => ({
    template: 'hermes_en_reparto',
    body: `¡Hoy llega! 🚚 ${firstName(o.customer_name)}, tu pedido ${o.code} sale a reparto hoy. ${o.payment === 'pagado' ? 'Ten a alguien pendiente para recibirlo.' : `Ten listos ${money(o.total)} para recibirlo.`}`,
    params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code, payment: deliveryVar(o) },
  }),
  oficina: (o: Order): Outgoing => ({
    template: 'hermes_oficina',
    body: `Hola ${firstName(o.customer_name)} 📦 Tu pedido ${o.code} ya está listo para que lo recojas en la oficina de ${o.carrier || 'la transportadora'} en ${o.city}.\n\n🔢 Guía: ${o.tracking_number}\n🪪 Lleva tu documento de identidad\n💵 ${deliveryVar(o)}\n\n¡Te esperamos!`,
    params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code, carrier: v(o.carrier || 'la transportadora', 60), city: v(o.city, 80), tracking_number: v(o.tracking_number, 60), payment: deliveryVar(o) },
  }),
  oficina_recordatorio: (o: Order, days: number): Outgoing => ({
    template: 'hermes_oficina_recordatorio',
    body: `Hola ${firstName(o.customer_name)}, tu pedido ${o.code} te espera hace ${days} días en la oficina de ${o.carrier || 'la transportadora'} en ${o.city} 📦 Si no se reclama a tiempo, la transportadora lo devuelve. ¿Vas a pasar por él?`,
    buttons: OFFICE_BUTTONS,
    params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code, days: String(days), carrier: v(o.carrier || 'la transportadora', 60), city: v(o.city, 80) },
  }),
  oficina_voy: (o: Order): Outgoing => ({ template: 'hermes_oficina_voy', body: `¡Perfecto! 😊 Te esperan en la oficina de ${o.carrier || 'la transportadora'} en ${o.city}. Lleva tu documento de identidad y el número de guía: ${o.tracking_number}.` }),
  oficina_recogido: (): Outgoing => ({ template: 'hermes_oficina_recogido', body: '¡Qué bueno! 🎉 Gracias por avisarme. Que lo disfrutes.' }),
  oficina_no: (): Outgoing => ({ template: 'hermes_oficina_no', body: 'Entendido, gracias por avisarme. Ya le paso tu caso al equipo para buscar una solución.' }),
  novedad: (o: Order, type: string): Outgoing => ({
    template: 'hermes_novedad',
    params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code, reason: INCIDENT_REASON[type] ?? INCIDENT_REASON.otro },
    body:
      {
        direccion: `La transportadora no pudo ubicar la dirección de tu pedido ${o.code} (${o.address}, ${o.city}).`,
        ausente: `La transportadora pasó a entregar tu pedido ${o.code} y no encontró a nadie.`,
        rehusado: `La transportadora nos informa que tu pedido ${o.code} no fue recibido.`,
        telefono: `La transportadora no logró comunicarse contigo para entregar tu pedido ${o.code}.`,
        zona: `La transportadora tiene dificultades para llegar a la dirección de tu pedido ${o.code}.`,
        otro: `Hubo una novedad con la entrega de tu pedido ${o.code}.`,
      }[type] + ' No te preocupes, lo resolvemos juntos. ¿Cómo prefieres que sigamos?',
    buttons: [
      { label: 'Reprogramar entrega', payload: 'REPROGRAMAR' },
      { label: 'Corregir dirección', payload: 'CORREGIR_DIR' },
      { label: 'Ya no lo quiero', payload: 'RECHAZAR' },
    ],
  }),
  novedad_recibida: (): Outgoing => ({ template: 'hermes_novedad_recibida', body: '¡Gracias! Ya le avisé a la transportadora y te escribo apenas salga de nuevo a reparto.' }),
  novedad_rechazo: (): Outgoing => ({ template: 'hermes_novedad_rechazo', body: 'Entendido, gracias por avisarme. Alguien de nuestro equipo te escribirá en breve.' }),
  entregado: (o: Order): Outgoing => ({ template: 'hermes_entregado', body: `¡Entregado! 🎉 ${firstName(o.customer_name)}, tu pedido ${o.code} ya está en tus manos. Gracias por confiar en nosotros.`, params: { customer_name: v(firstName(o.customer_name), 60), order_code: o.code } }),
  humano: (): Outgoing => ({ template: 'hermes_humano', body: 'Gracias por escribirme. Ya le paso tu mensaje al equipo para que te respondan en breve.' }),
};

// ───────── Utilidades ─────────
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits; // celular colombiano sin indicativo
}

export async function settingsOf(companyId: string): Promise<{ driver: string; reminderMinutes: number[]; escalateMinutes: number; botName: string; noReplyAction: 'persona' | 'confirmar' }> {
  const { rows } = await db.query(`SELECT driver, reminder_minutes, escalate_minutes, bot_name, no_reply_action FROM hermes_settings WHERE company_id = $1`, [companyId]);
  const r = rows[0];
  return { driver: r?.driver ?? 'simulado', reminderMinutes: r?.reminder_minutes ?? [30, 180], escalateMinutes: r?.escalate_minutes ?? 360, botName: r?.bot_name ?? '', noReplyAction: r?.no_reply_action === 'confirmar' ? 'confirmar' : 'persona' };
}

export async function getOrder(companyId: string, id: string): Promise<Order | null> {
  const { rows } = await db.query(`SELECT * FROM hermes_orders WHERE id = $1 AND company_id = $2`, [id, companyId]);
  return rows[0] ?? null;
}

export async function logEvent(o: { id: string; company_id: string }, type: string, detail = '', actor = 'Hermes'): Promise<void> {
  await db.query(`INSERT INTO hermes_events (company_id, order_id, type, detail, actor) VALUES ($1, $2, $3, $4, $5)`, [o.company_id, o.id, type, detail, actor]);
}

async function patch(o: Order, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE hermes_orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [o.id, ...keys.map((k) => fields[k])]);
  Object.assign(o, fields);
}

export async function setAttention(o: Order, reason: string): Promise<void> {
  // Se conserva el momento en que empezó a esperar: así la bandeja ordena por quién lleva más tiempo.
  await db.query(`UPDATE hermes_orders SET attention_at = now() WHERE id = $1 AND NOT attention`, [o.id]);
  await patch(o, { attention: true, attention_reason: reason });
  await logEvent(o, 'atencion', reason);
}

/** Una persona toma la conversación (el bot deja de responder en ese pedido) o se la devuelve al bot. */
export async function setBotPaused(o: Order, paused: boolean, actor: string): Promise<void> {
  await patch(o, { bot_paused: paused, taken_by: paused ? actor : '' });
  await logEvent(o, paused ? 'bot_pausado' : 'bot_reanudado', paused ? `${actor} tomó la conversación` : 'La conversación volvió al bot', actor);
}

/** Canal de WhatsApp de la empresa: modo, página de Pancake con su token y las plantillas aprobadas. */
export async function channelOf(companyId: string): Promise<{ driver: string; channel: pancake.Channel | null; templates: Record<string, string> }> {
  const { rows } = await db.query(`SELECT driver, pancake_page_id, pancake_token, templates FROM hermes_settings WHERE company_id = $1`, [companyId]);
  const r = rows[0];
  let token = '';
  try {
    token = r?.pancake_token ? decryptSecret(r.pancake_token) : '';
  } catch {
    token = ''; // la clave de cifrado cambió: hay que volver a pegar el token
  }
  return { driver: r?.driver ?? 'simulado', channel: r?.pancake_page_id && token ? { pageId: r.pancake_page_id, token } : null, templates: r?.templates ?? {} };
}

/** Botones que el bot ofrece. En WhatsApp, pulsar uno llega como un mensaje con su texto. */
const BUTTON_PAYLOADS: Record<string, string> = {};
const plainLabel = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
/** Si el texto recibido es exactamente el de un botón, devuelve su código. */
for (const b of [...CONFIRM_BUTTONS, ...OFFICE_BUTTONS, ...(MESSAGES.novedad({ code: '', customer_name: '' } as Order, 'otro').buttons ?? [])]) BUTTON_PAYLOADS[plainLabel(b.label)] = b.payload;
export const payloadOfLabel = (text: string): string | undefined => BUTTON_PAYLOADS[plainLabel(text)];

// WhatsApp deja escribir texto libre solo durante 24 horas desde el último mensaje del cliente. Se deja una hora de margen.
const WINDOW_MS = 23 * 3600_000;
const withOptions = (msg: Outgoing) => (msg.buttons?.length ? `${msg.body}\n\nResponde con una de estas opciones: ${msg.buttons.map((b) => b.label).join(' · ')}` : msg.body);

/**
 * Envía un mensaje al cliente con el canal configurado.
 * En modo simulado solo queda registrado: sirve para probar todo el recorrido sin costo ni mensajes reales.
 * Por WhatsApp: dentro de las 24 horas desde el último mensaje del cliente va como texto; fuera de ellas, como plantilla aprobada.
 */
export async function send(o: Order, msg: Outgoing, sender = 'Hermes'): Promise<{ ok: boolean; error: string }> {
  const ch = await channelOf(o.company_id);
  let status = 'simulado';
  let kind = msg.template ? 'plantilla' : 'texto';
  let body = msg.body;
  let delivery: { mode: 'texto' | 'plantilla'; templateId?: string; params?: Record<string, string> } | null = null;
  let error = '';
  if (ch.driver !== 'simulado') {
    const windowOpen = Boolean(o.last_inbound_at) && Date.now() - new Date(o.last_inbound_at!).getTime() < WINDOW_MS;
    const templateId = msg.params ? ch.templates[msg.template] : undefined;
    if (!ch.channel) {
      status = 'fallido';
      error = 'El canal de WhatsApp no está conectado';
    } else if (windowOpen) {
      kind = 'texto';
      body = withOptions(msg);
      status = 'en_cola';
      delivery = { mode: 'texto' };
    } else if (templateId && msg.params) {
      kind = 'plantilla';
      body = renderTemplate(msg.template, msg.params);
      status = 'en_cola';
      delivery = { mode: 'plantilla', templateId, params: msg.params };
    } else if (msg.params && !TEMPLATES.find((t) => t.key === msg.template)?.required) {
      // Aviso de cortesía sin plantilla: no se envía y no es motivo para molestar a nadie.
      status = 'omitido';
      error = 'No se envió: el cliente no ha escrito en las últimas 24 horas y este aviso no tiene plantilla configurada';
    } else {
      status = 'fallido';
      error = 'el cliente no ha escrito en las últimas 24 horas y no hay una plantilla aprobada para este mensaje';
    }
  }
  await db.query(
    `INSERT INTO hermes_messages (company_id, order_id, phone, direction, kind, template, body, buttons, status, sender, error, delivery)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)`,
    [o.company_id, o.id, o.phone, kind, msg.template, body, JSON.stringify(msg.buttons ?? []), status, sender, error, delivery ? JSON.stringify(delivery) : null],
  );
  await patch(o, { last_outbound_at: new Date().toISOString() });
  if (status === 'fallido') await setAttention(o, `No se pudo enviar un mensaje por WhatsApp: ${error}`);
  // El envío real lo hace la cola, a un ritmo que Pancake acepta. Se la despierta enseguida para no esperar a la tarea periódica.
  if (status === 'en_cola') setImmediate(() => void deliverQueued().catch(() => {}));
  return { ok: status !== 'fallido', error };
}

// ───────── Cola de envíos ─────────
const MAX_ATTEMPTS = 5;
let delivering = false;

/**
 * Entrega los mensajes en cola, uno tras otro y en el orden en que se crearon.
 * Un fallo pasajero (límite de uso, red) se reintenta más tarde con esperas cada vez mayores; uno definitivo queda como fallido y pide atención.
 */
export async function deliverQueued(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    for (;;) {
      const { rows } = await db.query(
        `SELECT id, company_id, order_id, phone, body, delivery, attempts FROM hermes_messages
          WHERE status = 'en_cola' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY created_at, id LIMIT 25`,
      );
      if (!rows.length) return;
      for (const m of rows) await deliverOne(m);
    }
  } finally {
    delivering = false;
  }
}

async function deliverOne(m: { id: string; company_id: string; order_id: string | null; phone: string; body: string; delivery: { mode: string; templateId?: string; params?: Record<string, string> } | null; attempts: number }): Promise<void> {
  const ch = await channelOf(m.company_id);
  let res: pancake.SendResult;
  if (ch.driver !== 'pancake' || !ch.channel) res = { ok: false, error: 'El canal de WhatsApp se desactivó antes de enviar este mensaje' };
  else if (m.delivery?.mode === 'plantilla' && m.delivery.templateId) res = await pancake.sendTemplate(ch.channel, m.phone, m.delivery.templateId, m.delivery.params ?? {});
  else res = await pancake.sendText(ch.channel, m.phone, m.body);

  if (res.ok) {
    // Si Pancake repite un identificador, el mensaje igual salió: se guarda sin él.
    await db.query(`UPDATE hermes_messages SET status = 'enviado', external_id = $2, error = '' WHERE id = $1`, [m.id, res.id ?? null]).catch(() =>
      db.query(`UPDATE hermes_messages SET status = 'enviado', error = '' WHERE id = $1`, [m.id]),
    );
    return;
  }
  if (res.retry && m.attempts + 1 < MAX_ATTEMPTS) {
    const waitSeconds = 30 * 2 ** m.attempts; // 30 s, 1 min, 2 min, 4 min
    await db.query(`UPDATE hermes_messages SET attempts = attempts + 1, next_attempt_at = now() + ($2 || ' seconds')::interval, error = $3 WHERE id = $1`, [m.id, String(waitSeconds), `Reintentando: ${res.error ?? ''}`]);
    return;
  }
  await db.query(`UPDATE hermes_messages SET status = 'fallido', attempts = attempts + 1, error = $2 WHERE id = $1`, [m.id, res.error ?? 'No se pudo enviar']);
  const o = m.order_id ? await getOrder(m.company_id, m.order_id) : null;
  if (o) await setAttention(o, `No se pudo enviar un mensaje por WhatsApp: ${res.error ?? 'error desconocido'}`);
}

/** Alguien del equipo le escribió al cliente desde Pancake: queda en la conversación del pedido. */
export async function recordStaffMessage(companyId: string, rawPhone: string, body: string, name: string, externalId: string): Promise<void> {
  const phone = normalizePhone(rawPhone);
  const { rows } = await db.query(`SELECT id FROM hermes_orders WHERE company_id = $1 AND phone = $2 ORDER BY (status IN ('entregado', 'devuelto', 'cancelado')), created_at DESC LIMIT 1`, [companyId, phone]);
  if (!rows[0]) return;
  await db.query(
    `INSERT INTO hermes_messages (company_id, order_id, phone, direction, kind, body, status, sender, external_id) VALUES ($1, $2, $3, 'out', 'texto', $4, 'enviado', $5, $6)
     ON CONFLICT (company_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
    [companyId, rows[0].id, phone, body, `${name} (desde Pancake)`, externalId],
  );
}

async function companyName(companyId: string): Promise<string> {
  return (await db.query(`SELECT name FROM core_companies WHERE id = $1`, [companyId])).rows[0]?.name ?? '';
}
/** Nombre con el que el bot se presenta. Si la empresa no eligió uno, usa uno neutro. */
const DEFAULT_AGENT = 'Hermes';
async function agentName(companyId: string): Promise<string> {
  return (await settingsOf(companyId)).botName || DEFAULT_AGENT;
}

// ───────── Acciones sobre un pedido ─────────
export async function startConfirmation(o: Order): Promise<void> {
  await patch(o, { awaiting: 'confirmacion' });
  await send(o, MESSAGES.confirmacion(o, await companyName(o.company_id), await agentName(o.company_id)));
  await logEvent(o, 'confirmacion_enviada', 'Se pidió confirmación al cliente');
}

export async function confirm(o: Order, actor = 'Cliente'): Promise<void> {
  if (o.status !== 'por_confirmar') return;
  await patch(o, { status: 'confirmado', awaiting: null, attention: false, attention_reason: '', confirmed_at: new Date().toISOString() });
  await logEvent(o, 'confirmado', actor === 'Cliente' ? 'El cliente confirmó por WhatsApp' : 'Confirmado manualmente', actor);
  await send(o, MESSAGES.confirmado(o));
}

/** El cliente no respondió y la empresa eligió seguir: se confirma sin escribirle (no confirmó nada, no hay qué agradecerle). */
async function confirmBySilence(o: Order): Promise<void> {
  await patch(o, { status: 'confirmado', awaiting: null, confirmed_at: new Date().toISOString() });
  await logEvent(o, 'confirmado', 'Confirmado automáticamente: el cliente no respondió a los avisos');
}

export async function cancel(o: Order, reason: string, actor = 'Cliente'): Promise<void> {
  if (FINAL_STATUSES.includes(o.status)) return;
  await patch(o, { status: 'cancelado', awaiting: null, attention: false, attention_reason: '', cancelled_at: new Date().toISOString(), cancel_reason: reason });
  await logEvent(o, 'cancelado', reason, actor);
  await send(o, MESSAGES.cancelado(o));
}

export async function dispatch(o: Order, data: { carrier: string; trackingNumber: string; trackingUrl: string }, actor: string): Promise<void> {
  await patch(o, { status: 'despachado', awaiting: null, carrier: data.carrier, tracking_number: data.trackingNumber, tracking_url: data.trackingUrl, dispatched_at: new Date().toISOString() });
  await logEvent(o, 'despachado', `${data.carrier} · guía ${data.trackingNumber}`, actor);
  await send(o, MESSAGES.guia(o));
}

export async function outForDelivery(o: Order, actor: string): Promise<void> {
  await patch(o, { status: 'en_reparto', awaiting: null, out_for_delivery_at: new Date().toISOString() });
  await logEvent(o, 'en_reparto', 'Sale a reparto', actor);
  await send(o, MESSAGES.en_reparto(o));
}

/** El paquete quedó en una oficina de la transportadora: se le avisa al cliente para que pase por él. Devuelve si el aviso salió. */
export async function readyForPickup(o: Order, actor: string): Promise<boolean> {
  await patch(o, { office_at: new Date().toISOString(), office_reminders: 0 });
  await logEvent(o, 'en_oficina', `Disponible para reclamar en la oficina de ${o.carrier || 'la transportadora'}`, actor);
  return (await send(o, MESSAGES.oficina(o))).ok;
}

export async function reportIncident(o: Order, type: string, description: string, actor: string): Promise<string> {
  const { rows } = await db.query(`INSERT INTO hermes_incidents (company_id, order_id, type, description) VALUES ($1, $2, $3, $4) RETURNING id`, [o.company_id, o.id, type, description]);
  await patch(o, { status: 'novedad', awaiting: 'novedad' });
  await logEvent(o, 'novedad', `${INCIDENT_LABEL[type]}${description ? `: ${description}` : ''}`, actor);
  await send(o, MESSAGES.novedad(o, type));
  return rows[0].id;
}

export async function delivered(o: Order, actor: string): Promise<void> {
  await db.query(`UPDATE hermes_incidents SET status = 'resuelta', resolved_at = now(), resolution = 'Entregado' WHERE order_id = $1 AND status IN ('esperando_cliente', 'por_gestionar')`, [o.id]);
  await patch(o, { status: 'entregado', awaiting: null, attention: false, attention_reason: '', delivered_at: new Date().toISOString() });
  await logEvent(o, 'entregado', 'Pedido entregado', actor);
  await send(o, MESSAGES.entregado(o));
}

export async function returned(o: Order, actor: string): Promise<void> {
  await db.query(`UPDATE hermes_incidents SET status = 'devolucion', resolved_at = now() WHERE order_id = $1 AND status IN ('esperando_cliente', 'por_gestionar')`, [o.id]);
  await patch(o, { status: 'devuelto', awaiting: null, attention: false, attention_reason: '', returned_at: new Date().toISOString() });
  await logEvent(o, 'devuelto', 'El pedido volvió a origen', actor);
}

async function openIncident(o: Order): Promise<{ id: string } | null> {
  const { rows } = await db.query(`SELECT id FROM hermes_incidents WHERE order_id = $1 AND status IN ('esperando_cliente', 'por_gestionar') ORDER BY created_at DESC LIMIT 1`, [o.id]);
  return rows[0] ?? null;
}

// ───────── Respuestas del cliente ─────────
// El límite de palabra de JavaScript (\b) no reconoce las tildes: «Sí» no terminaba en límite y el bot no lo entendía.
const END = '(?![a-záéíóúüñ0-9])';
const YES = new RegExp(`^(s[ií]|si confirmo|confirmo|confirmar|confirmado|ok|okay|dale|listo|de una|correcto|claro)${END}`, 'i');
const NO = new RegExp(`^(no|cancelar|cancela|cancelo|ya no|no lo quiero)${END}`, 'i');

/**
 * Procesa un mensaje entrante. `payload` es el botón pulsado (si lo hubo); `text`, lo que escribió.
 * Regla general: el bot solo resuelve lo que entiende sin ambigüedad; lo demás pasa a una persona.
 */
export async function handleInbound(
  companyId: string,
  rawPhone: string,
  input: { text?: string; payload?: string },
  /** `observeOnly`: el mensaje no se pudo comprobar con el canal; se guarda y se avisa a una persona, pero el bot no actúa. */
  opts: { externalId?: string; observeOnly?: boolean } = {},
): Promise<{ orderId: string | null }> {
  const phone = normalizePhone(rawPhone);
  const text = (input.text ?? '').trim();
  // Lo que el cliente escribió a mano. Si pulsó un botón, `text` es solo la etiqueta del botón y no cuenta como texto libre.
  const typed = input.payload ? '' : text;
  const { rows } = await db.query(
    `SELECT * FROM hermes_orders WHERE company_id = $1 AND phone = $2 ORDER BY (status IN ('entregado', 'devuelto', 'cancelado')), created_at DESC LIMIT 1`,
    [companyId, phone],
  );
  const o: Order | undefined = rows[0];
  await db.query(
    `INSERT INTO hermes_messages (company_id, order_id, phone, direction, kind, body, status, sender, external_id) VALUES ($1, $2, $3, 'in', $4, $5, 'recibido', 'Cliente', $6)`,
    [companyId, o?.id ?? null, phone, input.payload ? 'boton' : 'texto', text || input.payload || '', opts.externalId ?? null],
  );
  if (!o) return { orderId: null };
  if (opts.observeOnly) {
    await setAttention(o, 'Llegó un mensaje del cliente que no se pudo comprobar con Pancake: revísalo y respóndele');
    return { orderId: o.id };
  }
  await db.query(`UPDATE hermes_orders SET last_inbound_at = now() WHERE id = $1`, [o.id]);
  o.last_inbound_at = new Date();
  // Si una persona tomó la conversación, el bot no interviene: solo avisa de que hay un mensaje nuevo.
  if ((o as Order & { bot_paused?: boolean }).bot_paused) {
    await setAttention(o, 'El cliente escribió (conversación a cargo de una persona)');
    return { orderId: o.id };
  }

  let intent = input.payload ?? '';
  if (!intent && (o.awaiting === 'confirmacion')) intent = YES.test(typed) ? 'CONFIRMAR' : NO.test(typed) ? 'CANCELAR' : '';

  if (o.awaiting === 'confirmacion' && o.status === 'por_confirmar') {
    if (intent === 'CONFIRMAR') await confirm(o);
    else if (intent === 'CANCELAR') await cancel(o, 'Cancelado por el cliente');
    else if (intent === 'CORREGIR') {
      await patch(o, { awaiting: 'direccion' });
      await send(o, MESSAGES.pedir_direccion());
    } else await toHuman(o, 'El cliente respondió algo que el bot no entiende');
  } else if (o.awaiting === 'direccion' && typed) {
    const check = checkAddress(typed, o.city);
    if (await stillIncomplete(o, typed, check)) return { orderId: o.id };
    await logEvent(o, 'direccion_corregida', `Antes: ${o.address}, ${o.city}`, 'Cliente');
    await db.query(`UPDATE hermes_orders SET address_check = $2::jsonb WHERE id = $1`, [o.id, JSON.stringify(check)]);
    o.address_check = check;
    await patch(o, { address: typed, awaiting: 'confirmacion' });
    await send(o, MESSAGES.datos_actualizados(o));
  } else if (o.awaiting === 'novedad') {
    const incident = await openIncident(o);
    if (intent === 'REPROGRAMAR') {
      if (incident) await db.query(`UPDATE hermes_incidents SET customer_choice = 'reprogramar', status = 'por_gestionar' WHERE id = $1`, [incident.id]);
      await patch(o, { awaiting: null });
      await setAttention(o, 'El cliente pide reprogramar la entrega: avisar a la transportadora');
      await send(o, MESSAGES.novedad_recibida());
    } else if (intent === 'CORREGIR_DIR') {
      await patch(o, { awaiting: 'direccion_novedad' });
      await send(o, MESSAGES.pedir_direccion());
    } else if (intent === 'RECHAZAR') {
      if (incident) await db.query(`UPDATE hermes_incidents SET customer_choice = 'rechaza', status = 'por_gestionar' WHERE id = $1`, [incident.id]);
      await patch(o, { awaiting: null });
      await setAttention(o, 'El cliente dice que ya no quiere el pedido');
      await send(o, MESSAGES.novedad_rechazo());
    } else await toHuman(o, 'El cliente respondió a la novedad con un mensaje libre');
  } else if (o.awaiting === 'oficina' && ['OFICINA_VOY', 'OFICINA_RECOGIDO', 'OFICINA_NO'].includes(intent)) {
    await patch(o, { awaiting: null });
    if (intent === 'OFICINA_VOY') {
      await logEvent(o, 'oficina_respuesta', 'El cliente dice que va a pasar por el paquete', 'Cliente');
      await send(o, MESSAGES.oficina_voy(o));
    } else if (intent === 'OFICINA_RECOGIDO') {
      // No se marca entregado: eso lo confirma la transportadora. Se dejan de enviar recordatorios.
      await patch(o, { office_at: null });
      await logEvent(o, 'oficina_respuesta', 'El cliente dice que ya recogió el paquete', 'Cliente');
      await send(o, MESSAGES.oficina_recogido());
    } else {
      await patch(o, { office_at: null });
      await logEvent(o, 'oficina_respuesta', 'El cliente dice que no puede ir a la oficina', 'Cliente');
      await setAttention(o, 'El cliente no puede ir a la oficina por el paquete: coordinar otra entrega o la devolución');
      await send(o, MESSAGES.oficina_no());
    }
  } else if (o.awaiting === 'direccion_novedad' && typed) {
    const check = checkAddress(typed, o.city);
    if (await stillIncomplete(o, typed, check)) return { orderId: o.id };
    const incident = await openIncident(o);
    await logEvent(o, 'direccion_corregida', `Antes: ${o.address}, ${o.city}`, 'Cliente');
    await db.query(`UPDATE hermes_orders SET address_check = $2::jsonb WHERE id = $1`, [o.id, JSON.stringify(check)]);
    await patch(o, { address: typed, awaiting: null });
    if (incident) await db.query(`UPDATE hermes_incidents SET customer_choice = 'corrige_direccion', status = 'por_gestionar' WHERE id = $1`, [incident.id]);
    await setAttention(o, 'El cliente corrigió la dirección: avisar a la transportadora');
    await send(o, MESSAGES.novedad_recibida());
  } else if (o.status === 'confirmado' && (intent === 'CONFIRMAR' || (!intent && YES.test(typed)))) {
    // Respondió tarde a un pedido que ya se había confirmado (a mano o por falta de respuesta).
    await logEvent(o, 'confirmado', 'El cliente confirmó por WhatsApp un pedido que ya estaba confirmado', 'Cliente');
    await send(o, MESSAGES.confirmado(o));
  } else if (o.status === 'confirmado' && (intent === 'CANCELAR' || intent === 'CORREGIR')) {
    // El pedido ya pudo salir hacia el operador: lo decide una persona, que puede ver si ya tiene guía.
    await toHuman(o, intent === 'CANCELAR' ? 'El cliente pide cancelar un pedido ya confirmado: revisar si ya tiene guía antes de cancelarlo' : 'El cliente quiere corregir los datos de un pedido ya confirmado: revisar si ya tiene guía');
  } else if (!FINAL_STATUSES.includes(o.status)) {
    await toHuman(o, 'El cliente escribió y espera respuesta');
  } else {
    await setAttention(o, 'El cliente escribió sobre un pedido ya cerrado');
  }
  return { orderId: o.id };
}

/**
 * El cliente envió una dirección a la que aún le faltan datos obligatorios.
 * No se acepta: la primera vez el bot le dice qué falta y cómo escribirla; si vuelve a llegar incompleta, pasa a una persona.
 * Devuelve true si la dirección NO se aceptó.
 */
async function stillIncomplete(o: Order, typed: string, check: ReturnType<typeof checkAddress>): Promise<boolean> {
  if (!check.issues.some((i) => i.severity === 'error')) return false;
  const before = await db.query(`SELECT count(*)::int AS n FROM hermes_events WHERE order_id = $1 AND type = 'direccion_incompleta'`, [o.id]);
  await logEvent(o, 'direccion_incompleta', `El cliente escribió: ${typed}`, 'Cliente');
  if (before.rows[0].n >= 1) await toHuman(o, 'El cliente no logra dar la dirección completa: llamarlo para completarla');
  else await send(o, MESSAGES.direccion_incompleta(check.missing));
  return true;
}

/** Pasa la conversación a una persona. Solo avisa al cliente la primera vez, para no repetirle el mismo mensaje. */
async function toHuman(o: Order, reason: string): Promise<void> {
  const first = !(await db.query(`SELECT attention FROM hermes_orders WHERE id = $1`, [o.id])).rows[0]?.attention;
  await setAttention(o, reason);
  if (first) await send(o, MESSAGES.humano());
}

/** Días en oficina a los que se le recuerda al cliente, y cuántos días después del último se pasa a una persona. */
const OFFICE_REMINDER_DAYS = [2, 4];
const OFFICE_ESCALATE_DAYS = 2;

/** Paquetes que siguen esperando en una oficina: se le insiste al cliente y, si no reacciona, lo ve una persona. */
async function officeReminders(): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM hermes_orders WHERE status IN ('despachado', 'en_reparto') AND office_at IS NOT NULL AND NOT attention AND NOT bot_paused`);
  for (const o of rows as (Order & { office_at: Date; office_reminders: number })[]) {
    const days = (Date.now() - new Date(o.office_at).getTime()) / 86_400_000;
    const sent = o.office_reminders;
    if (sent < OFFICE_REMINDER_DAYS.length) {
      if (days < OFFICE_REMINDER_DAYS[sent]) continue;
      await patch(o, { office_reminders: sent + 1, awaiting: 'oficina' });
      await logEvent(o, 'oficina_recordatorio', `Lleva ${Math.floor(days)} días en la oficina: recordatorio ${sent + 1} de ${OFFICE_REMINDER_DAYS.length}`);
      const res = await send(o, MESSAGES.oficina_recordatorio(o, Math.floor(days)));
      // Sin plantilla aprobada el recordatorio no sale: que lo llame una persona.
      if (!res.ok) await setAttention(o, `El paquete lleva ${Math.floor(days)} días en la oficina de la transportadora y no se le pudo recordar al cliente`);
    } else if (sent === OFFICE_REMINDER_DAYS.length && days >= OFFICE_REMINDER_DAYS[sent - 1] + OFFICE_ESCALATE_DAYS) {
      await patch(o, { office_reminders: sent + 1 });
      await setAttention(o, `El paquete lleva ${Math.floor(days)} días en la oficina de la transportadora y el cliente no responde: llamarlo antes de que lo devuelvan`);
    }
  }
}

// ───────── Tarea periódica: recordatorios y casos sin respuesta ─────────
export async function runReminders(): Promise<void> {
  await officeReminders();
  const { rows } = await db.query(`SELECT * FROM hermes_orders WHERE status = 'por_confirmar' AND awaiting = 'confirmacion' AND NOT attention AND NOT bot_paused`);
  for (const o of rows as Order[]) {
    const { reminderMinutes, escalateMinutes, botName, noReplyAction } = await settingsOf(o.company_id);
    const since = (Date.now() - (o.last_outbound_at ?? o.created_at).getTime()) / 60_000;
    if (o.reminders_sent < reminderMinutes.length) {
      if (since >= reminderMinutes[o.reminders_sent]) {
        await send(o, MESSAGES.recordatorio(o, botName || DEFAULT_AGENT));
        await patch(o, { reminders_sent: o.reminders_sent + 1 });
        await logEvent(o, 'recordatorio', `Recordatorio ${o.reminders_sent} de ${reminderMinutes.length}`);
      }
    } else if (since >= escalateMinutes) {
      // Un cliente con historial de devoluciones no se despacha sin que alguien lo revise.
      const risky = (o as unknown as { customer_risk?: string }).customer_risk === 'alto';
      if (noReplyAction === 'confirmar' && !risky) await confirmBySilence(o);
      else await setAttention(o, risky ? 'Sin respuesta y con riesgo alto de devolución: llamar antes de despachar' : 'Sin respuesta tras los recordatorios: llamar o cancelar');
    }
  }
}
