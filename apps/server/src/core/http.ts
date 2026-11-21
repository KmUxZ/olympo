import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { config, resolveSettings } from '../config.ts';
import type { CompanySettings } from '../config.ts';
import { db } from '../db/db.ts';
import type { Queryable } from '../db/db.ts';
import { hashToken } from './security.ts';

export type Role = 'admin' | 'supervisor' | 'seller';

export interface Ctx {
  sessionId: string;
  client: 'web' | 'extension';
  userId: string;
  companyId: string;
  role: Role;
  name: string;
  email: string;
  teamId: string | null;
  mustChangePassword: boolean;
  ip: string;
  company: { id: string; name: string; timezone: string; isDemo: boolean; settings: CompanySettings };
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'solicitud_invalida') => new HttpError(400, code, message);
export const forbidden = (message = 'No tienes permiso para esta acción.') => new HttpError(403, 'sin_permiso', message);
export const notFound = (message = 'No encontrado.') => new HttpError(404, 'no_encontrado', message);

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new HttpError(400, 'validacion', `Datos no válidos (${where}${first?.message ?? 'revisa los campos'}).`);
  }
  return result.data;
}

export const SESSION_COOKIE = 'olympo_session';

async function authenticate(req: FastifyRequest): Promise<Ctx> {
  const header = req.headers.authorization;
  let token: string | undefined;
  let viaCookie = false;
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
  else if (req.cookies?.[SESSION_COOKIE]) {
    token = req.cookies[SESSION_COOKIE];
    viaCookie = true;
  }
  if (!token) throw new HttpError(401, 'no_autenticado', 'Inicia sesión para continuar.');

  // Defensa CSRF para sesiones con cookie: las escrituras deben venir de un origen conocido.
  if (viaCookie && req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    const self = `${req.protocol}://${req.headers.host}`;
    if (origin && origin !== self && !config.webOrigins.includes(origin)) throw forbidden('Origen no permitido.');
  }

  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.client, u.id, u.company_id, u.role, u.name, u.email, u.team_id, u.must_change_password,
            c.name AS company_name, c.timezone, c.is_demo, c.settings
       FROM core_sessions s
       JOIN core_users u ON u.id = s.user_id
       JOIN core_companies c ON c.id = u.company_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) throw new HttpError(401, 'sesion_expirada', 'Tu sesión expiró. Inicia sesión de nuevo.');
  await db.query(`UPDATE core_sessions SET last_used_at = now() WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, [r.session_id]);

  return {
    sessionId: r.session_id,
    client: r.client,
    userId: r.id,
    companyId: r.company_id,
    role: r.role,
    name: r.name,
    email: r.email,
    teamId: r.team_id,
    mustChangePassword: r.must_change_password,
    ip: req.ip,
    company: { id: r.company_id, name: r.company_name, timezone: r.timezone, isDemo: r.is_demo, settings: resolveSettings(r.settings) },
  };
}

/** Opciones de ruta: exige sesión válida y, si se indican, uno de los roles dados. */
export function guard(...roles: Role[]) {
  return {
    preHandler: async (req: FastifyRequest) => {
      req.ctx = await authenticate(req);
      if (roles.length && !roles.includes(req.ctx.role)) throw forbidden();
      if (req.ctx.mustChangePassword && !req.url.startsWith('/api/auth/')) {
        throw new HttpError(403, 'cambio_contrasena_requerido', 'Debes cambiar tu contraseña temporal antes de continuar.');
      }
    },
  };
}

/**
 * Usuarios cuya información puede ver quien hace la petición.
 * null = toda la empresa (administrador). Supervisor: su equipo y él mismo. Vendedora: solo ella.
 */
export async function visibleUserIds(ctx: Ctx): Promise<string[] | null> {
  if (ctx.role === 'admin') return null;
  if (ctx.role === 'seller') return [ctx.userId];
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM core_users u JOIN core_teams t ON t.id = u.team_id
      WHERE t.company_id = $1 AND t.supervisor_id = $2`,
    [ctx.companyId, ctx.userId],
  );
  return [...new Set([ctx.userId, ...rows.map((r) => r.id)])];
}

export async function assertCanSeeUser(ctx: Ctx, userId: string): Promise<void> {
  const ids = await visibleUserIds(ctx);
  if (ids && !ids.includes(userId)) throw forbidden();
}

export interface AuditEntry {
  companyId: string;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function audit(q: Queryable, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO core_audit_log (company_id, actor_id, actor_name, action, entity_type, entity_id, summary, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      entry.companyId,
      entry.actorId ?? null,
      entry.actorName ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.summary,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
    ],
  );
}

export function auditBy(ctx: Ctx, entry: Omit<AuditEntry, 'companyId' | 'actorId' | 'actorName' | 'ip'>): Promise<void> {
  return audit(db, { ...entry, companyId: ctx.companyId, actorId: ctx.userId, actorName: ctx.name, ip: ctx.ip });
}
