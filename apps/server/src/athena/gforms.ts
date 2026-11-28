// Athena · formularios de Google: leer sus preguntas y enviar una respuesta, como lo haría una persona con el enlace.
// Solo sirve para formularios abiertos (sin inicio de sesión). Antes de enviar se vuelve a leer el formulario:
// si alguien cambió una pregunta o una opción, el envío se detiene en vez de mandar datos a la casilla equivocada.

const TIMEOUT = 20_000;
/** Para probar contra un formulario de mentira se puede cambiar el servidor con ATHENA_FORMS_URL. */
const docsBase = () => (process.env.ATHENA_FORMS_URL ?? 'https://docs.google.com').replace(/\/+$/, '');

export class FormError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface FormQuestion { entry: string; title: string; kind: 'texto' | 'lista' | 'otro'; required: boolean; options: string[] }
export interface FormInfo { id: string; title: string; questions: FormQuestion[] }

/** Lo que significa cada pregunta para Athena. */
export type Role =
  | 'vendedor' | 'tipoVenta' | 'pagina' | 'nombre' | 'viaTipo' | 'viaNumero' | 'numeral' | 'placa1' | 'guion' | 'placa2'
  | 'barrio' | 'direccionOficina' | 'ciudad' | 'celular1' | 'celular2' | 'valor' | 'pedido' | 'producto';

export const plainText = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9#-]+/g, ' ').trim();

/** Identificador público del formulario a partir de su enlace largo (…/forms/d/e/<id>/viewform). */
export function formIdOf(url: string): string | null {
  return /\/forms\/d\/e\/([A-Za-z0-9_-]{20,})\//.exec(url)?.[1] ?? null;
}

/** Solo se aceptan enlaces de formularios de Google: el corto (forms.gle) o el largo (docs.google.com/forms). */
export function isFormUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ((u.hostname === 'forms.gle' && /^\/[A-Za-z0-9]{8,}$/.test(u.pathname)) || (u.hostname === 'docs.google.com' && formIdOf(u.pathname) !== null));
  } catch {
    return false;
  }
}

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'es' } });
  } catch {
    throw new FormError('sin_conexion', 'No se pudo abrir el formulario de Google. Intenta de nuevo en unos minutos.');
  }
}

/** Convierte el enlace que se comparte (corto o largo) en el identificador del formulario. */
export async function resolveFormId(url: string): Promise<string> {
  if (!isFormUrl(url)) throw new FormError('enlace_no_valido', 'El enlace no es de un formulario de Google.');
  const direct = formIdOf(url);
  if (direct) return direct;
  // El enlace corto redirige al largo. Solo se sigue si lleva a un formulario de Google.
  const res = await get(url);
  const next = res.headers.get('location') ?? '';
  const id = (() => { try { return new URL(next).hostname === 'docs.google.com' ? formIdOf(next) : null; } catch { return null; } })();
  if (!id) throw new FormError('enlace_no_valido', 'El enlace corto no llevó a un formulario de Google.');
  return id;
}

/** Lee el formulario tal como está publicado ahora. */
export async function readForm(id: string): Promise<FormInfo> {
  const res = await get(`${docsBase()}/forms/d/e/${id}/viewform`);
  if (res.status >= 300 && res.status < 400) throw new FormError('pide_sesion', 'El formulario pide iniciar sesión en Google: debe aceptar respuestas de cualquiera con el enlace.');
  if (res.status !== 200) throw new FormError('no_disponible', `Google respondió ${res.status} al abrir el formulario. Puede estar cerrado o eliminado.`);
  return parseFormHtml(id, await res.text());
}

/** Extrae las preguntas de la página del formulario. */
export function parseFormHtml(id: string, html: string): FormInfo {
  const raw = /FB_PUBLIC_LOAD_DATA_ = (.*?);\s*<\/script>/s.exec(html)?.[1];
  let data: any;
  try {
    data = JSON.parse(raw ?? '');
  } catch {
    throw new FormError('no_se_entiende', 'No se pudieron leer las preguntas del formulario.');
  }
  const items: any[] = Array.isArray(data?.[1]?.[1]) ? data[1][1] : [];
  const questions: FormQuestion[] = [];
  for (const it of items) {
    const type = Number(it?.[3]);
    for (const q of Array.isArray(it?.[4]) ? it[4] : []) {
      if (q?.[0] == null) continue;
      questions.push({
        entry: String(q[0]),
        title: String(it?.[1] ?? '').replace(/\s+/g, ' ').trim(),
        kind: type === 0 || type === 1 ? 'texto' : type === 2 || type === 3 ? 'lista' : 'otro',
        required: Boolean(q[2]),
        options: (Array.isArray(q[1]) ? q[1] : []).map((o: any) => String(o?.[0] ?? '')).filter(Boolean),
      });
    }
  }
  if (!questions.length) throw new FormError('no_se_entiende', 'El formulario no tiene preguntas que se puedan leer.');
  return { id, title: String(data?.[1]?.[8] ?? data?.[3] ?? '').trim(), questions };
}

/**
 * Qué dato va en cada pregunta, por su título. Las dos casillas sin título son los números de la placa:
 * la que sigue al numeral y la que sigue al guion.
 */
export function mapRoles(form: FormInfo): Partial<Record<Role, FormQuestion>> {
  const out: Partial<Record<Role, FormQuestion>> = {};
  const set = (role: Role, q: FormQuestion) => { out[role] ??= q; };
  let afterMark: 'numeral' | 'guion' | null = null;
  for (const q of form.questions) {
    const t = plainText(q.title);
    if (!t) {
      if (afterMark === 'numeral') set('placa1', q);
      else if (afterMark === 'guion') set('placa2', q);
      afterMark = null;
      continue;
    }
    afterMark = null;
    if (t.startsWith('vendedor')) set('vendedor', q);
    else if (t.startsWith('tipos de venta') || t.startsWith('tipo de venta')) set('tipoVenta', q);
    else if (t.startsWith('pagina')) set('pagina', q);
    else if (t.startsWith('nombre')) set('nombre', q);
    else if (t.startsWith('tipo de via')) set('viaTipo', q);
    else if (t.startsWith('numero de via')) set('viaNumero', q);
    else if (t.startsWith('numeral')) { set('numeral', q); afterMark = 'numeral'; }
    else if (t.startsWith('guion')) { set('guion', q); afterMark = 'guion'; }
    else if (t.startsWith('barrio')) set('barrio', q);
    else if (t.startsWith('oficina')) set('direccionOficina', q);
    else if (t.startsWith('ciudad')) set('ciudad', q);
    else if (t.startsWith('celular 1')) set('celular1', q);
    else if (t.startsWith('celular 2')) set('celular2', q);
    else if (t.startsWith('valor')) set('valor', q);
    else if (t.startsWith('pedido')) set('pedido', q);
    else if (t.startsWith('producto')) set('producto', q);
  }
  return out;
}

/** La opción de una lista que corresponde a un texto, sin importar mayúsculas ni tildes. `null` si no existe. */
export function pickOption(q: FormQuestion, wanted: string): string | null {
  const w = plainText(wanted);
  return w ? (q.options.find((o) => plainText(o) === w) ?? null) : null;
}

/**
 * Arma la respuesta y comprueba que el formulario la va a aceptar: que estén todas las obligatorias
 * y que cada lista reciba una de sus opciones. Lanza con un motivo claro si algo no cuadra.
 */
export function buildAnswers(form: FormInfo, values: Partial<Record<Role, string>>): Record<string, string> {
  const roles = mapRoles(form);
  const byEntry = new Map<string, Role>();
  for (const [role, q] of Object.entries(roles) as [Role, FormQuestion][]) byEntry.set(q.entry, role);
  const answers: Record<string, string> = {};
  for (const q of form.questions) {
    const role = byEntry.get(q.entry);
    const label = q.title || (role === 'placa1' ? 'el número después del #' : role === 'placa2' ? 'el número después del guion' : 'una pregunta sin título');
    if (!role) {
      if (q.required) throw new FormError('formulario_cambio', `El formulario tiene una pregunta obligatoria que Athena no conoce: «${label}».`);
      continue;
    }
    let value = (values[role] ?? '').trim();
    // Listas de una sola opción (el numeral y el guion): siempre va esa.
    if (q.kind === 'lista' && q.options.length === 1 && (role === 'numeral' || role === 'guion')) value = q.options[0];
    if (!value) {
      if (q.required) throw new FormError('falta_dato', `Falta el dato para «${label}».`);
      continue;
    }
    if (q.kind === 'lista') {
      const option = pickOption(q, value);
      if (!option) throw new FormError('opcion_no_existe', `«${value}» no está entre las opciones de «${label}» en el formulario «${form.title}».`);
      value = option;
    }
    answers[`entry.${q.entry}`] = value.slice(0, 1000);
  }
  return answers;
}

/** Envía la respuesta. Google contesta 200 con la página de confirmación; cualquier otra cosa es un rechazo. */
export async function submitForm(id: string, answers: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${docsBase()}/forms/d/e/${id}/formResponse`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0' },
      body: new URLSearchParams(answers).toString(),
    });
  } catch {
    throw new FormError('sin_conexion', 'No se pudo enviar la respuesta al formulario de Google.');
  }
  if (res.status !== 200) throw new FormError('rechazado', `Google no aceptó la respuesta (respondió ${res.status}). Revisa que el formulario siga abierto y con las mismas preguntas.`);
}
