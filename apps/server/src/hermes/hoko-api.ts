// Cliente de la API de Hoko (https://hoko.com.co/api-documentation). Las rutas /member piden un token que se
// obtiene con POST /login. La dirección se puede cambiar con HOKO_API_URL para probar contra un Hoko de mentira.
import { db } from '../db/db.ts';
import { decryptSecret, encryptSecret } from '../core/secrets.ts';

const base = () => (process.env.HOKO_API_URL ?? 'https://hoko.com.co/api').replace(/\/+$/, '');
const TIMEOUT = 20_000;

export class HokoError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method: 'GET' | 'POST', path: string, token: string | null, fields?: Record<string, string>): Promise<any> {
  let body: FormData | undefined;
  if (fields) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
  }
  let res: Response;
  try {
    res = await fetch(base() + path, { method, body, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(TIMEOUT), redirect: 'manual' });
  } catch {
    throw new HokoError(0, 'sin_conexion', 'No se pudo conectar con Hoko. Intenta de nuevo en unos minutos.');
  }
  const data: any = await res.json().catch(() => null);
  // Con el token vencido Hoko responde 401 o redirige a /login/expire.
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new HokoError(401, 'token', 'La sesión de Hoko venció.');
  if (res.status === 429) throw new HokoError(429, 'limite', 'Hoko está limitando las consultas. Intenta de nuevo en un minuto.');
  if (!res.ok || data?.status === 'error') throw new HokoError(res.status, String(data?.code ?? 'error'), String(data?.message ?? data?.msg ?? data?.error ?? `Hoko respondió ${res.status}`).slice(0, 300));
  return data;
}

/** Comprueba usuario y contraseña. Devuelve el token de sesión. */
export async function login(email: string, password: string): Promise<string> {
  try {
    const data = await request('POST', '/login', null, { email, password });
    if (typeof data?.token !== 'string' || !data.token) throw new HokoError(422, 'credenciales', 'Hoko no devolvió una sesión.');
    return data.token;
  } catch (err) {
    if (err instanceof HokoError && (err.status === 422 || err.status === 401)) throw new HokoError(422, 'credenciales', 'Hoko rechazó el correo o la contraseña.');
    throw err;
  }
}

/** Ejecuta una llamada con el token guardado del operador; si venció, inicia sesión de nuevo una sola vez. */
async function withToken<T>(operatorId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const { rows } = await db.query<{ api_email: string | null; api_password: string | null; api_token: string | null }>(`SELECT api_email, api_password, api_token FROM hermes_operators WHERE id = $1`, [operatorId]);
  const op = rows[0];
  if (!op?.api_email || !op.api_password) throw new HokoError(0, 'sin_cuenta', 'Falta conectar la cuenta de Hoko en este operador.');
  const fresh = async () => {
    const token = await login(op.api_email!, decryptSecret(op.api_password!));
    await db.query(`UPDATE hermes_operators SET api_token = $2 WHERE id = $1`, [operatorId, encryptSecret(token)]);
    return token;
  };
  const token = op.api_token ? decryptSecret(op.api_token) : await fresh();
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof HokoError) || err.status !== 401) throw err;
    return fn(await fresh());
  }
}

/** Enlace público del PDF de la guía de una orden, o null si la guía aún no existe. Caduca a los 7 días. */
export async function guidePdf(operatorId: string, orderRef: string): Promise<string | null> {
  const data = await withToken(operatorId, (t) => request('GET', `/member/order/${encodeURIComponent(orderRef)}`, t));
  const url = typeof data?.guide_pdf === 'string' ? data.guide_pdf : '';
  return /^https:\/\//i.test(url) ? url : null;
}
