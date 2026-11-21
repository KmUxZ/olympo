// Cliente y sincronización de Pancake (https://developer.pancake.biz).
// Trae estadísticas de atención por usuario y hora: son datos de la plataforma, no inferencias del teclado.
import { db } from '../db/db.ts';
import { decryptSecret } from '../core/secrets.ts';
import { localParts, localToUtc } from '../core/time.ts';

const BASE = (process.env.PANCAKE_API_BASE ?? 'https://pages.fm/api/public_api/v1').replace(/\/+$/, '');
export const PROVIDER = 'pancake';

export class PancakeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call(pageId: string, token: string, path: string, params: Record<string, string> = {}): Promise<any> {
  // La API de Pancake exige el token como parámetro de la URL: esta URL nunca se registra ni se devuelve.
  const url = new URL(`${BASE}/pages/${encodeURIComponent(pageId)}${path}`);
  url.searchParams.set('page_access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new PancakeError('No se pudo conectar con Pancake.', 0);
  }
  if (res.status === 401 || res.status === 403) throw new PancakeError('Pancake rechazó el token de la página. Revisa que sea el correcto y siga vigente.', res.status);
  if (res.status === 429) throw new PancakeError('Pancake limitó las solicitudes. Se reintentará en la próxima sincronización.', 429);
  if (!res.ok) throw new PancakeError(`Pancake respondió con un error (${res.status}).`, res.status);
  const json = await res.json().catch(() => null);
  if (!json || json.success === false) throw new PancakeError('Pancake no aceptó la solicitud. Revisa el identificador de la página y el token.', 400);
  return json;
}

export async function fetchUsers(pageId: string, token: string): Promise<{ id: string; name: string }[]> {
  const json = await call(pageId, token, '/users');
  return (json.users ?? []).filter((u: any) => u?.id).map((u: any) => ({ id: String(u.id), name: String(u.name ?? 'Sin nombre') }));
}

const pad = (n: number) => String(n).padStart(2, '0');

interface Connection {
  line_id: string;
  company_id: string;
  external_page_id: string;
  secret_enc: string;
  timezone: string;
}

/** Sincroniza una línea: usuarios de la página y estadísticas por hora de hoy (y de ayer durante la madrugada). */
export async function syncConnection(conn: Connection): Promise<{ hours: number }> {
  try {
    const token = decryptSecret(conn.secret_enc);
    const now = new Date();
    const today = localParts(conn.timezone, now);
    // Las primeras horas del día se vuelve a pedir el día anterior para cerrar sus últimas horas.
    const fromDate = today.hour < 2 ? localParts(conn.timezone, new Date(now.getTime() - 24 * 3600_000)) : today;
    const dateRange = `${pad(fromDate.day)}/${pad(fromDate.month)}/${fromDate.year} 00:00:00 - ${pad(today.day)}/${pad(today.month)}/${today.year} 23:59:59`;

    const names = new Map((await fetchUsers(conn.external_page_id, token)).map((u) => [u.id, u.name]));
    const stats = await call(conn.external_page_id, token, '/statistics/users', { date_range: dateRange });
    for (const [id, u] of Object.entries<any>(stats.data?.users ?? {})) if (!names.has(id) && u?.user_name) names.set(id, String(u.user_name));

    const rows: Record<string, unknown>[] = [];
    for (const [externalId, buckets] of Object.entries<any>(stats.data?.statistics ?? {})) {
      if (!Array.isArray(buckets)) continue;
      for (const b of buckets) {
        // "hour" viene en la hora local de la página, sin zona: p. ej. 2026-11-21T10:00:00
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(String(b?.hour ?? ''));
        if (!m) continue;
        const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
        rows.push({
          ext: externalId,
          hour: localToUtc(conn.timezone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])).toISOString(),
          inbox: int(b.inbox_count),
          uniq: int(b.unique_inbox_count),
          comments: int(b.comment_count),
          phones: int(b.phone_number_count),
          resp: Math.min(int(b.average_response_time), 2_000_000_000),
        });
      }
    }

    if (names.size) {
      await db.query(
        `INSERT INTO argos_external_staff (company_id, provider, external_id, name)
         SELECT $1::uuid, $2, x.id, x.name FROM jsonb_to_recordset($3::jsonb) AS x(id text, name text)
         ON CONFLICT (company_id, provider, external_id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()`,
        [conn.company_id, PROVIDER, JSON.stringify([...names].map(([id, name]) => ({ id, name })))],
      );
    }
    if (rows.length) {
      // La plataforma es la fuente de verdad: cada hora se reemplaza con el valor más reciente.
      await db.query(
        `INSERT INTO argos_channel_hours (line_id, external_id, hour_start, company_id, provider, inbox_count, unique_inbox_count, comment_count, phone_number_count, avg_response_ms, fetched_at)
         SELECT $1::uuid, x.ext, x.hour, $2::uuid, $3, x.inbox, x.uniq, x.comments, x.phones, x.resp, now()
           FROM jsonb_to_recordset($4::jsonb) AS x(ext text, hour timestamptz, inbox int, uniq int, comments int, phones int, resp int)
         ON CONFLICT (line_id, external_id, hour_start) DO UPDATE SET
           inbox_count = EXCLUDED.inbox_count, unique_inbox_count = EXCLUDED.unique_inbox_count, comment_count = EXCLUDED.comment_count,
           phone_number_count = EXCLUDED.phone_number_count, avg_response_ms = EXCLUDED.avg_response_ms, fetched_at = now()`,
        [conn.line_id, conn.company_id, PROVIDER, JSON.stringify(rows)],
      );
    }
    await db.query(`UPDATE argos_line_connections SET status = 'ok', last_error = NULL, last_sync_at = now() WHERE line_id = $1`, [conn.line_id]);
    return { hours: rows.length };
  } catch (err) {
    const message = err instanceof PancakeError ? err.message : 'Error inesperado al sincronizar con Pancake.';
    await db.query(`UPDATE argos_line_connections SET status = 'error', last_error = $2 WHERE line_id = $1`, [conn.line_id, message]);
    throw err instanceof PancakeError ? err : new PancakeError(message, 500);
  }
}

/** Sincroniza todas las líneas conectadas (de una empresa, o de todas). Los errores de una línea no detienen las demás. */
export async function syncAll(companyId?: string): Promise<{ ok: number; failed: number }> {
  const { rows } = await db.query<Connection>(
    `SELECT c.line_id, c.company_id, c.external_page_id, c.secret_enc, co.timezone
       FROM argos_line_connections c JOIN core_companies co ON co.id = c.company_id
      WHERE c.provider = $1 ${companyId ? 'AND c.company_id = $2' : ''}`,
    companyId ? [PROVIDER, companyId] : [PROVIDER],
  );
  let ok = 0, failed = 0;
  for (const conn of rows) {
    try {
      await syncConnection(conn);
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}
