// Hermes · cliente de la API pública de Pancake (https://developer.pancake.biz). Solo habla con Pancake: no sabe nada de pedidos.
// La dirección se puede cambiar con PANCAKE_API_URL para probar contra un Pancake de mentira.
const base = () => (process.env.PANCAKE_API_URL ?? 'https://pages.fm/api/public_api/v1').replace(/\/+$/, '');
const baseV2 = () => base().replace(/\/v1$/, '/v2');

export interface Channel { pageId: string; token: string }
/** `retry`: el fallo es pasajero (límite de uso, red, caída de Pancake) y vale la pena intentarlo de nuevo más tarde. */
export interface SendResult { ok: boolean; id?: string; error?: string; retry?: boolean }

/** Conversación de WhatsApp de un teléfono. Pancake la identifica con la página y el número, exista ya o no. */
export const conversationId = (pageId: string, phone: string) => `${pageId}_${phone.replace(/\D/g, '')}`;
/** Teléfono a partir del identificador de conversación (waba_<página>_<teléfono>). */
export const phoneOf = (conversation: string) => /_(\d{8,15})$/.exec(conversation)?.[1] ?? '';
/** Las fechas de Pancake vienen en UTC y sin zona. */
export const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Pancake admite 5 llamadas por segundo por página. Todas las llamadas de una página pasan por una fila con una pausa entre ellas.
const SPACING_MS = 260;
const lanes = new Map<string, Promise<unknown>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function inLane<T>(pageId: string, task: () => Promise<T>): Promise<T> {
  const run = (lanes.get(pageId) ?? Promise.resolve()).then(task, task);
  const tail = run.then(() => sleep(SPACING_MS), () => sleep(SPACING_MS));
  lanes.set(pageId, tail);
  void tail.then(() => lanes.get(pageId) === tail && lanes.delete(pageId));
  return run;
}

async function request(ch: Channel, method: 'GET' | 'POST', path: string, body?: unknown, root = base()): Promise<{ status: number; json: any }> {
  const url = `${root}/pages/${encodeURIComponent(ch.pageId)}${path}${path.includes('?') ? '&' : '?'}page_access_token=${encodeURIComponent(ch.token)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await inLane(ch.pageId, () =>
      fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) }),
    );
    // Si Pancake pide esperar, se espera un poco y se repite (un par de veces; después decide quien llamó).
    if (res.status === 429 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
}

/** Un 200 de Pancake no garantiza el envío: hay que mirar `success`. */
async function post(ch: Channel, conversation: string, body: unknown): Promise<SendResult> {
  try {
    const { status, json } = await request(ch, 'POST', `/conversations/${encodeURIComponent(conversation)}/messages`, body);
    if (status === 200 && json?.success === true) return { ok: true, id: typeof json.id === 'string' ? json.id : undefined };
    const reason = json?.message_code ?? json?.message ?? json?.error ?? '';
    if (status === 401 || status === 403) return { ok: false, error: 'Pancake rechazó el token de la página' };
    if (status === 429 || status >= 500) return { ok: false, retry: true, error: status === 429 ? 'Pancake limitó los envíos por un momento' : `Pancake tuvo un error (respuesta ${status})` };
    return { ok: false, error: `Pancake no envió el mensaje${reason ? ` (${String(reason).slice(0, 120)})` : ` (respuesta ${status})`}` };
  } catch (err) {
    return { ok: false, retry: true, error: `No se pudo conectar con Pancake (${(err as Error).name === 'TimeoutError' ? 'tardó demasiado' : 'error de red'})` };
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

export interface RemoteMessage { id: string; text: string; at: Date | null; sender: 'cliente' | 'equipo'; staffName?: string; hasAttachment: boolean }

/** Últimos mensajes de una conversación (hasta 30), del más antiguo al más reciente. `null` si no se pudo consultar. */
export async function listMessages(ch: Channel, conversation: string): Promise<RemoteMessage[] | null> {
  try {
    const { status, json } = await request(ch, 'GET', `/conversations/${encodeURIComponent(conversation)}/messages`);
    if (status !== 200 || !Array.isArray(json?.messages)) return null;
    const out: RemoteMessage[] = [];
    for (const m of json.messages) {
      if (!m?.id) continue;
      const from = m.from ?? {};
      // Lo escribió alguien del equipo, una automatización o la propia página (por ejemplo, los envíos de Hermes).
      const staff = Boolean(from.admin_id || from.uid || from.admin_name || from.is_automated || from.ai_generated) || String(from.id ?? '') === ch.pageId;
      const raw = typeof m.original_message === 'string' && m.original_message ? m.original_message : typeof m.message === 'string' ? m.message : '';
      out.push({
        id: String(m.id).slice(0, 200),
        text: raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
        at: parseDate(m.inserted_at),
        sender: staff ? 'equipo' : 'cliente',
        staffName: from.admin_name ? String(from.admin_name).slice(0, 80) : undefined,
        hasAttachment: Array.isArray(m.attachments) && m.attachments.length > 0,
      });
    }
    return out.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  } catch {
    return null;
  }
}

/**
 * Conversaciones de la bandeja con actividad desde `since`. `null` si Pancake no respondió como se espera
 * (entonces quien llama consulta pedido a pedido).
 */
export async function listUpdatedConversations(ch: Channel, since: Date, until: Date): Promise<{ id: string; updatedAt: Date | null }[] | null> {
  try {
    const out: { id: string; updatedAt: Date | null }[] = [];
    let last = '';
    for (let page = 0; page < 6; page++) {
      const query = `/conversations?type=INBOX&order_by=updated_at&since=${Math.floor(since.getTime() / 1000)}&until=${Math.ceil(until.getTime() / 1000)}${last ? `&last_conversation_id=${encodeURIComponent(last)}` : ''}`;
      const { status, json } = await request(ch, 'GET', query, undefined, baseV2());
      if (status !== 200 || !Array.isArray(json?.conversations)) return null;
      for (const c of json.conversations) if (c?.id) out.push({ id: String(c.id), updatedAt: parseDate(c.updated_at) });
      if (json.conversations.length < 60) break;
      last = String(json.conversations.at(-1)?.id ?? '');
      if (!last) break;
    }
    return out;
  } catch {
    return null;
  }
}
