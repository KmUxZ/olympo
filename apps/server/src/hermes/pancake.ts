// Hermes · cliente de la API pública de Pancake (https://developer.pancake.biz). Solo habla con Pancake: no sabe nada de pedidos.
// La dirección se puede cambiar con PANCAKE_API_URL para probar contra un Pancake de mentira.
const base = () => (process.env.PANCAKE_API_URL ?? 'https://pages.fm/api/public_api/v1').replace(/\/+$/, '');

export interface Channel { pageId: string; token: string }
export interface SendResult { ok: boolean; id?: string; error?: string }

/** Conversación de WhatsApp de un teléfono. Pancake la identifica con la página y el número, exista ya o no. */
export const conversationId = (pageId: string, phone: string) => `${pageId}_${phone.replace(/\D/g, '')}`;
/** Teléfono a partir del identificador de conversación (waba_<página>_<teléfono>). */
export const phoneOf = (conversation: string) => /_(\d{8,15})$/.exec(conversation)?.[1] ?? '';

async function request(ch: Channel, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const url = `${base()}/pages/${encodeURIComponent(ch.pageId)}${path}${path.includes('?') ? '&' : '?'}page_access_token=${encodeURIComponent(ch.token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Un 200 de Pancake no garantiza el envío: hay que mirar `success`. */
async function post(ch: Channel, conversation: string, body: unknown): Promise<SendResult> {
  try {
    const { status, json } = await request(ch, 'POST', `/conversations/${encodeURIComponent(conversation)}/messages`, body);
    if (status === 200 && json?.success === true) return { ok: true, id: typeof json.id === 'string' ? json.id : undefined };
    const reason = json?.message_code ?? json?.message ?? json?.error ?? '';
    return { ok: false, error: status === 401 || status === 403 ? 'Pancake rechazó el token de la página' : status === 429 ? 'Pancake limitó los envíos por un momento' : `Pancake no envió el mensaje${reason ? ` (${String(reason).slice(0, 120)})` : ` (respuesta ${status})`}` };
  } catch (err) {
    return { ok: false, error: `No se pudo conectar con Pancake (${(err as Error).name === 'TimeoutError' ? 'tardó demasiado' : 'error de red'})` };
  }
}

export const sendText = (ch: Channel, phone: string, message: string) => post(ch, conversationId(ch.pageId, phone), { action: 'reply_inbox', message });

export const sendTemplate = (ch: Channel, phone: string, templateId: string, params: Record<string, string>) =>
  post(ch, conversationId(ch.pageId, phone), { action: 'reply_inbox', template_id: templateId, template_params: { BODY_PARAMS: params } });

/** Comprueba que la página y el token sirven, sin enviar nada. */
export async function checkConnection(ch: Channel): Promise<{ ok: boolean; error?: string }> {
  try {
    const { status, json } = await request(ch, 'GET', '/users');
    if (status === 200 && json?.success !== false) return { ok: true };
    return { ok: false, error: status === 401 || status === 403 ? 'Pancake no aceptó el token para esa página. Revisa que el token sea de esa misma página.' : `Pancake respondió ${status}. Revisa el identificador de la página.` };
  } catch {
    return { ok: false, error: 'No se pudo conectar con Pancake. Inténtalo de nuevo en un momento.' };
  }
}

export type Sender = 'cliente' | 'equipo' | 'desconocido';
/**
 * Pancake no firma sus avisos. Antes de dejar que el bot actúe, se le pregunta a la propia API si ese mensaje existe
 * en la conversación y quién lo envió. `equipo` = lo escribió alguien del equipo o un sistema, no el cliente.
 */
export async function verifyMessage(ch: Channel, conversation: string, messageId: string): Promise<{ sender: Sender; staffName?: string; text?: string }> {
  try {
    const { status, json } = await request(ch, 'GET', `/conversations/${encodeURIComponent(conversation)}/messages`);
    const found = status === 200 && Array.isArray(json?.messages) ? json.messages.find((m: any) => String(m?.id) === messageId) : null;
    if (!found) return { sender: 'desconocido' };
    const from = found.from ?? {};
    const staff = Boolean(from.admin_id || from.uid || from.admin_name || from.is_automated || from.ai_generated) || String(from.id ?? '') === ch.pageId;
    return { sender: staff ? 'equipo' : 'cliente', staffName: from.admin_name ? String(from.admin_name).slice(0, 80) : undefined, text: typeof found.message === 'string' ? found.message : undefined };
  } catch {
    return { sender: 'desconocido' };
  }
}
