// Hermes · motor del bot. Lleva cada pedido desde la confirmación hasta la entrega o la devolución.
// Toda la conversación pasa por aquí: lo que envía el bot, lo que responde el cliente y cuándo debe intervenir una persona.
import { db } from '../db/db.ts';
import { checkAddress } from './address.ts';

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
  items: { name: string; qty: number; price: number }[];
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
  address_check?: { missing?: string[] } | null;
}

interface Outgoing {
  template: string;
  body: string;
  buttons?: { label: string; payload: string }[];
}

const money = (n: number) => `$${n.toLocaleString('es-CO')}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
const itemsText = (o: Order) => o.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
/** Si al validador le falta algo de la dirección, el bot se lo pide al cliente en el mismo mensaje. */
const missingLine = (o: Order) => {
  const m = o.address_check?.missing ?? [];
  return m.length ? `\nPara que llegue sin problemas nos falta ${m.join(' y ')}. Pulsa «Corregir datos» y envíanos la dirección completa.` : '';
};
const payLine = (o: Order) => (o.payment === 'pagado' ? 'Tu pedido ya está pago.' : `Total a pagar al recibir: ${money(o.total)}.`);

// Textos de los mensajes. Para envío real por WhatsApp, cada uno debe existir como plantilla aprobada por Meta
// con este mismo contenido (la clave `template` es el nombre de la plantilla).
const CONFIRM_BUTTONS = [
  { label: 'Confirmar pedido', payload: 'CONFIRMAR' },
  { label: 'Corregir datos', payload: 'CORREGIR' },
  { label: 'Cancelar', payload: 'CANCELAR' },
];
export const MESSAGES = {
  confirmacion: (o: Order, company: string): Outgoing => ({
    template: 'hermes_confirmacion',
    body: `Hola ${firstName(o.customer_name)}, recibimos tu pedido ${o.code} en ${company}: ${itemsText(o)}. ${payLine(o)}\nLo enviaremos a: ${o.address}, ${o.city}${o.notes ? ` (${o.notes})` : ''}.${missingLine(o)}\n¿Confirmas tu pedido?`,
    buttons: CONFIRM_BUTTONS,
  }),
  recordatorio: (o: Order): Outgoing => ({
    template: 'hermes_recordatorio',
    body: `Hola ${firstName(o.customer_name)}, tu pedido ${o.code} sigue pendiente de confirmación. Solo lo despachamos cuando nos confirmas. ¿Lo enviamos a ${o.address}, ${o.city}?`,
    buttons: CONFIRM_BUTTONS,
  }),
  datos_actualizados: (o: Order): Outgoing => ({
    template: 'hermes_datos_actualizados',
    body: `Actualizamos la dirección de tu pedido ${o.code}: ${o.address}, ${o.city}. ${payLine(o)}${missingLine(o)} ¿Confirmas?`,
    buttons: CONFIRM_BUTTONS,
  }),
  pedir_direccion: (): Outgoing => ({ template: 'hermes_pedir_direccion', body: 'Claro. Escríbenos la dirección completa (calle, número, barrio, apartamento o indicaciones) y la ciudad, en un solo mensaje.' }),
  confirmado: (o: Order): Outgoing => ({ template: 'hermes_confirmado', body: `¡Listo, ${firstName(o.customer_name)}! Tu pedido ${o.code} quedó confirmado. Te avisaremos por aquí cuando lo despachemos.` }),
  cancelado: (o: Order): Outgoing => ({ template: 'hermes_cancelado', body: `Tu pedido ${o.code} quedó cancelado. Si fue un error, respóndenos y lo revisamos.` }),
  guia: (o: Order): Outgoing => ({
    template: 'hermes_guia',
    body: `Tu pedido ${o.code} ya fue despachado${o.carrier ? ` con ${o.carrier}` : ''}. Número de guía: ${o.tracking_number}.${o.tracking_url ? ` Puedes rastrearlo aquí: ${o.tracking_url}` : ''}`,
  }),
  en_reparto: (o: Order): Outgoing => ({
    template: 'hermes_en_reparto',
    body: `${firstName(o.customer_name)}, tu pedido ${o.code} sale a reparto hoy. ${o.payment === 'pagado' ? 'Ten a alguien pendiente para recibirlo.' : `Ten listos ${money(o.total)} para recibirlo.`}`,
  }),
  novedad: (o: Order, type: string): Outgoing => ({
    template: `hermes_novedad_${type}`,
    body:
      {
        direccion: `La transportadora no pudo ubicar la dirección de tu pedido ${o.code} (${o.address}, ${o.city}).`,
        ausente: `La transportadora pasó a entregar tu pedido ${o.code} y no encontró a nadie.`,
        rehusado: `La transportadora nos informa que tu pedido ${o.code} no fue recibido.`,
        telefono: `La transportadora no logró comunicarse contigo para entregar tu pedido ${o.code}.`,
        zona: `La transportadora tiene dificultades para llegar a la dirección de tu pedido ${o.code}.`,
        otro: `Hubo una novedad con la entrega de tu pedido ${o.code}.`,
      }[type] + ' ¿Cómo quieres que lo resolvamos?',
    buttons: [
      { label: 'Reprogramar entrega', payload: 'REPROGRAMAR' },
      { label: 'Corregir dirección', payload: 'CORREGIR_DIR' },
      { label: 'Ya no lo quiero', payload: 'RECHAZAR' },
    ],
  }),
  novedad_recibida: (): Outgoing => ({ template: 'hermes_novedad_recibida', body: 'Gracias. Ya le informamos a la transportadora y te avisaremos cuando salga de nuevo a reparto.' }),
  novedad_rechazo: (): Outgoing => ({ template: 'hermes_novedad_rechazo', body: 'Entendido. Una persona de nuestro equipo te escribirá en breve.' }),
  entregado: (o: Order): Outgoing => ({ template: 'hermes_entregado', body: `¡Tu pedido ${o.code} fue entregado! Gracias por tu compra, ${firstName(o.customer_name)}.` }),
  humano: (): Outgoing => ({ template: 'hermes_humano', body: 'Gracias por tu mensaje. Una persona de nuestro equipo te responderá en breve.' }),
};

// ───────── Utilidades ─────────
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits; // celular colombiano sin indicativo
}

export async function settingsOf(companyId: string): Promise<{ driver: string; reminderMinutes: number[]; escalateMinutes: number }> {
  const { rows } = await db.query(`SELECT driver, reminder_minutes, escalate_minutes FROM hermes_settings WHERE company_id = $1`, [companyId]);
  const r = rows[0];
  return { driver: r?.driver ?? 'simulado', reminderMinutes: r?.reminder_minutes ?? [30, 180], escalateMinutes: r?.escalate_minutes ?? 360 };
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
  await patch(o, { attention: true, attention_reason: reason });
  await logEvent(o, 'atencion', reason);
}

/**
 * Envía un mensaje al cliente con el canal configurado.
 * En modo simulado solo queda registrado: sirve para probar todo el recorrido sin costo ni mensajes reales.
 */
export async function send(o: Order, msg: Outgoing, sender = 'Hermes'): Promise<void> {
  const { driver } = await settingsOf(o.company_id);
  // El envío real (driver 'pancake') se conecta aquí cuando se configure el número de logística.
  const status = driver === 'simulado' ? 'simulado' : 'pendiente_de_canal';
  await db.query(
    `INSERT INTO hermes_messages (company_id, order_id, phone, direction, kind, template, body, buttons, status, sender)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7::jsonb, $8, $9)`,
    [o.company_id, o.id, o.phone, msg.template ? 'plantilla' : 'texto', msg.template, msg.body, JSON.stringify(msg.buttons ?? []), status, sender],
  );
  await patch(o, { last_outbound_at: new Date().toISOString() });
}

async function companyName(companyId: string): Promise<string> {
  return (await db.query(`SELECT name FROM core_companies WHERE id = $1`, [companyId])).rows[0]?.name ?? '';
}

// ───────── Acciones sobre un pedido ─────────
export async function startConfirmation(o: Order): Promise<void> {
  await patch(o, { awaiting: 'confirmacion' });
  await send(o, MESSAGES.confirmacion(o, await companyName(o.company_id)));
  await logEvent(o, 'confirmacion_enviada', 'Se pidió confirmación al cliente');
}

export async function confirm(o: Order, actor = 'Cliente'): Promise<void> {
  if (o.status !== 'por_confirmar') return;
  await patch(o, { status: 'confirmado', awaiting: null, attention: false, attention_reason: '', confirmed_at: new Date().toISOString() });
  await logEvent(o, 'confirmado', actor === 'Cliente' ? 'El cliente confirmó por WhatsApp' : 'Confirmado manualmente', actor);
  await send(o, MESSAGES.confirmado(o));
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
const YES = /^(s[ií]|si confirmo|confirmo|confirmar|confirmado|ok|okay|dale|listo|de una|correcto|claro)\b/i;
const NO = /^(no|cancelar|cancela|cancelo|ya no|no lo quiero)\b/i;

/**
 * Procesa un mensaje entrante. `payload` es el botón pulsado (si lo hubo); `text`, lo que escribió.
 * Regla general: el bot solo resuelve lo que entiende sin ambigüedad; lo demás pasa a una persona.
 */
export async function handleInbound(companyId: string, rawPhone: string, input: { text?: string; payload?: string }): Promise<{ orderId: string | null }> {
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
    `INSERT INTO hermes_messages (company_id, order_id, phone, direction, kind, body, status, sender) VALUES ($1, $2, $3, 'in', $4, $5, 'recibido', 'Cliente')`,
    [companyId, o?.id ?? null, phone, input.payload ? 'boton' : 'texto', text || input.payload || ''],
  );
  if (!o) return { orderId: null };

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
    await logEvent(o, 'direccion_corregida', `Antes: ${o.address}, ${o.city}`, 'Cliente');
    const check = checkAddress(typed, o.city);
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
  } else if (o.awaiting === 'direccion_novedad' && typed) {
    const incident = await openIncident(o);
    await logEvent(o, 'direccion_corregida', `Antes: ${o.address}, ${o.city}`, 'Cliente');
    await db.query(`UPDATE hermes_orders SET address_check = $2::jsonb WHERE id = $1`, [o.id, JSON.stringify(checkAddress(typed, o.city))]);
    await patch(o, { address: typed, awaiting: null });
    if (incident) await db.query(`UPDATE hermes_incidents SET customer_choice = 'corrige_direccion', status = 'por_gestionar' WHERE id = $1`, [incident.id]);
    await setAttention(o, 'El cliente corrigió la dirección: avisar a la transportadora');
    await send(o, MESSAGES.novedad_recibida());
  } else if (!FINAL_STATUSES.includes(o.status)) {
    await toHuman(o, 'El cliente escribió y espera respuesta');
  } else {
    await setAttention(o, 'El cliente escribió sobre un pedido ya cerrado');
  }
  return { orderId: o.id };
}

/** Pasa la conversación a una persona. Solo avisa al cliente la primera vez, para no repetirle el mismo mensaje. */
async function toHuman(o: Order, reason: string): Promise<void> {
  const first = !(await db.query(`SELECT attention FROM hermes_orders WHERE id = $1`, [o.id])).rows[0]?.attention;
  await setAttention(o, reason);
  if (first) await send(o, MESSAGES.humano());
}

// ───────── Tarea periódica: recordatorios y casos sin respuesta ─────────
export async function runReminders(): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM hermes_orders WHERE status = 'por_confirmar' AND awaiting = 'confirmacion' AND NOT attention`);
  for (const o of rows as Order[]) {
    const { reminderMinutes, escalateMinutes } = await settingsOf(o.company_id);
    const since = (Date.now() - (o.last_outbound_at ?? o.created_at).getTime()) / 60_000;
    if (o.reminders_sent < reminderMinutes.length) {
      if (since >= reminderMinutes[o.reminders_sent]) {
        await send(o, MESSAGES.recordatorio(o));
        await patch(o, { reminders_sent: o.reminders_sent + 1 });
        await logEvent(o, 'recordatorio', `Recordatorio ${o.reminders_sent} de ${reminderMinutes.length}`);
      }
    } else if (since >= escalateMinutes) {
      await setAttention(o, 'Sin respuesta tras los recordatorios: llamar o cancelar');
    }
  }
}
