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
  company: { id: string; name: string; timezone: string; isDemo: boolean; settings: CompanySettings; supportAccessUntil: Date | null; products: string[] };
  /** Opera la plataforma OLYMPO (gestiona empresas cliente). */
  isPlatformAdmin: boolean;
  /** true cuando una persona de plataforma está dentro de una empresa cliente con acceso de soporte concedido. */
  support: boolean;
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
/** Productos del ecosistema. El prefijo de sus rutas (/api/<producto>/) coincide con este nombre. */
export const PRODUCTS = ['argos', 'hermes', 'zeus', 'athena'] as const;

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

  const load = async () =>
    (
      await db.query(
        `SELECT s.id AS session_id, s.client, s.support_company_id, u.id, u.role, u.name, u.email, u.team_id, u.must_change_password, u.is_platform_admin,
                c.id AS company_id, c.name AS company_name, c.timezone, c.is_demo, c.settings, c.status AS company_status, c.support_access_until, c.products
           FROM core_sessions s
           JOIN core_users u ON u.id = s.user_id
           JOIN core_companies c ON c.id = COALESCE(s.support_company_id, u.company_id)
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
        [hashToken(token)],
      )
    ).rows[0];
  let r = await load();
  if (!r) throw new HttpError(401, 'sesion_expirada', 'Tu sesión expiró. Inicia sesión de nuevo.');

  // Modo soporte: solo vale mientras el permiso concedido por la empresa siga vigente.
  let support = false;
  if (r.support_company_id) {
    const granted = r.is_platform_admin && r.support_access_until && r.support_access_until.getTime() > Date.now();
    if (granted) support = true;
    else {
      await db.query(`UPDATE core_sessions SET support_company_id = NULL WHERE id = $1`, [r.session_id]);
      r = await load();
    }
  }
  if (r.company_status === 'suspended' && !r.is_platform_admin) {
    throw new HttpError(403, 'empresa_suspendida', 'La cuenta de tu empresa está suspendida. Contacta con tu administrador.');
  }
  await db.query(`UPDATE core_sessions SET last_used_at = now() WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, [r.session_id]);

  return {
    sessionId: r.session_id,
    client: r.client,
    userId: r.id,
    companyId: r.company_id,
    role: support ? 'admin' : r.role,
    name: support ? `${r.name} (soporte OLYMPO)` : r.name,
    email: r.email,
    teamId: support ? null : r.team_id,
    mustChangePassword: r.must_change_password,
    ip: req.ip,
    company: { id: r.company_id, name: r.company_name, timezone: r.timezone, isDemo: r.is_demo, settings: resolveSettings(r.settings), supportAccessUntil: r.support_access_until, products: Array.isArray(r.products) ? r.products : [] },
    isPlatformAdmin: r.is_platform_admin,
    support,
  };
}

/** Opciones de ruta: exige sesión válida y, si se indican, uno de los roles dados. */
export function guard(...roles: Role[]) {
  return {
    preHandler: async (req: FastifyRequest) => {
      req.ctx = await authenticate(req);
      if (roles.length && !roles.includes(req.ctx.role)) throw forbidden();
      // Cada producto del ecosistema se contrata por separado: sus rutas solo responden si la empresa lo tiene activo.
      const product = PRODUCTS.find((p) => req.url.startsWith(`/api/${p}/`));
      if (product && !req.ctx.company.products.includes(product)) {
        throw new HttpError(403, 'producto_no_contratado', `Tu empresa no tiene activo ${product.charAt(0).toUpperCase() + product.slice(1)}.`);
      }
      if (req.ctx.mustChangePassword && !req.url.startsWith('/api/auth/')) {
        throw new HttpError(403, 'cambio_contrasena_requerido', 'Debes cambiar tu contraseña temporal antes de continuar.');
      }
    },
  };
}

/** Opciones de ruta para el panel de plataforma: solo quien opera OLYMPO, y nunca desde una sesión en modo soporte. */
export function guardPlatform() {
  return {
    preHandler: async (req: FastifyRequest) => {
      req.ctx = await authenticate(req);
      if (!req.ctx.isPlatformAdmin) throw forbidden();
      if (req.ctx.mustChangePassword) throw new HttpError(403, 'cambio_contrasena_requerido', 'Debes cambiar tu contraseña temporal antes de continuar.');
    },
  };
}

/** Comprueba el límite del plan antes de añadir una vendedora o una línea activa. */
export async function assertWithinPlan(companyId: string, kind: 'sellers' | 'lines'): Promise<void> {
  const { rows } = await db.query(
    `SELECT plan_limits,
            (SELECT count(*)::int FROM core_users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role = 'seller') AS sellers,
            (SELECT count(*)::int FROM argos_lines l WHERE l.company_id = c.id AND l.active) AS lines
       FROM core_companies c WHERE c.id = $1`,
    [companyId],
  );
  const limit = Number(rows[0]?.plan_limits?.[kind === 'sellers' ? 'maxSellers' : 'maxLines']);
  if (!Number.isFinite(limit) || limit <= 0) return;
  if (rows[0][kind] >= limit) {
    throw new HttpError(409, 'limite_del_plan', kind === 'sellers'
      ? `Tu plan permite hasta ${limit} vendedoras activas. Desactiva una cuenta o amplía el plan.`
      : `Tu plan permite hasta ${limit} líneas activas. Desactiva una línea o amplía el plan.`);
  }
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

/**
 * Fragmento SQL que limita una consulta a las personas visibles para quien la hace.
 * Añade el parámetro necesario a `params`. Para el administrador no añade nada.
 */
export async function scopeSql(ctx: Ctx, column: string, params: unknown[]): Promise<string> {
  const ids = await visibleUserIds(ctx);
  if (!ids) return '';
  params.push(JSON.stringify(ids));
  return ` AND ${column} IN (SELECT value::uuid FROM jsonb_array_elements_text($${params.length}::jsonb))`;
}

/** Equipos que supervisa quien hace la petición (vacío si no supervisa ninguno). */
export async function supervisedTeamIds(ctx: Ctx): Promise<string[]> {
  if (ctx.role !== 'supervisor') return [];
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM core_teams WHERE company_id = $1 AND supervisor_id = $2`, [ctx.companyId, ctx.userId]);
  return rows.map((r) => r.id);
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
