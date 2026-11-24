import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { db } from '../db/db.ts';
import { audit, auditBy, badRequest, guard, HttpError, parse, SESSION_COOKIE } from './http.ts';
import type { Ctx } from './http.ts';
import { hashPassword, hashToken, MIN_PASSWORD_LENGTH, newToken, verifyPassword } from './security.ts';

// Límite de intentos fallidos (en memoria; suficiente para una instancia). Se cuenta por correo, venga de donde venga,
// para frenar un ataque repartido entre muchas IP, y también por IP, para frenar a quien prueba muchos correos.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 10;
const MAX_PER_IP = 40;
const limitOf = (key: string) => (key.startsWith('ip|') ? MAX_PER_IP : MAX_PER_ACCOUNT);

function checkRate(...keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    const entry = attempts.get(key);
    if (entry && entry.resetAt > now && entry.count >= limitOf(key)) {
      throw new HttpError(429, 'demasiados_intentos', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    }
  }
}

function registerFailure(...keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    else entry.count++;
  }
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}

// Se comprueba contra este hash cuando el correo no existe, para que la respuesta tarde lo mismo que con una cuenta real.
const DUMMY_HASH = await hashPassword(newToken());

export function publicUser(ctx: Ctx) {
  return {
    user: { id: ctx.userId, name: ctx.name, email: ctx.email, role: ctx.role, teamId: ctx.teamId, mustChangePassword: ctx.mustChangePassword, isPlatformAdmin: ctx.isPlatformAdmin },
    company: ctx.company,
    support: ctx.support,
  };
}

export function authRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(
      z.object({ email: z.string().trim().toLowerCase().min(3).max(200), password: z.string().min(1).max(200), client: z.enum(['web', 'extension']).default('web') }),
      req.body,
    );
    const accountKey = `cuenta|${body.email}`;
    const ipKey = `ip|${req.ip}`;
    checkRate(accountKey, ipKey);

    const { rows } = await db.query(
      `SELECT u.id, u.company_id, u.name, u.email, u.role, u.team_id, u.password_hash, u.status, u.must_change_password, u.is_platform_admin,
              c.status AS company_status
         FROM core_users u JOIN core_companies c ON c.id = u.company_id WHERE lower(u.email) = $1`,
      [body.email],
    );
    const user = rows[0];
    const ok = (await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH)) && Boolean(user);
    if (!user || !ok || user.status !== 'active') {
      registerFailure(accountKey, ipKey);
      if (user) {
        await audit(db, {
          companyId: user.company_id, actorId: user.id, actorName: user.name, action: 'acceso.fallido',
          entityType: 'usuario', entityId: user.id, summary: `Intento de inicio de sesión fallido (${body.client})`, ip: req.ip,
        });
      }
      throw new HttpError(401, 'credenciales_invalidas', 'Correo o contraseña incorrectos.');
    }
    if (user.company_status === 'suspended' && !user.is_platform_admin) {
      throw new HttpError(403, 'empresa_suspendida', 'La cuenta de tu empresa está suspendida. Contacta con tu administrador.');
    }
    if (body.client === 'extension' && user.must_change_password) {
      throw new HttpError(403, 'cambio_contrasena_requerido', 'Primero entra a la plataforma web y cambia tu contraseña temporal.');
    }
    attempts.delete(accountKey);

    const token = newToken();
    await db.query(
      `INSERT INTO core_sessions (company_id, user_id, token_hash, client, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
      [user.company_id, user.id, hashToken(token), body.client, String(req.headers['user-agent'] ?? '').slice(0, 300), String(config.sessionDays)],
    );
    await audit(db, {
      companyId: user.company_id, actorId: user.id, actorName: user.name, action: 'acceso.inicio',
      entityType: 'usuario', entityId: user.id, summary: `Inicio de sesión (${body.client === 'web' ? 'plataforma web' : 'extensión'})`, ip: req.ip,
    });

    const payload = { user: { id: user.id, name: user.name, email: user.email, role: user.role, teamId: user.team_id, mustChangePassword: user.must_change_password, isPlatformAdmin: user.is_platform_admin } };
    if (body.client === 'extension') return { ...payload, token };
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: config.sessionDays * 86400,
    });
    return payload;
  });

  app.get('/api/auth/me', guard(), async (req) => publicUser(req.ctx));

  app.post('/api/auth/logout', guard(), async (req, reply) => {
    await db.query('UPDATE core_sessions SET revoked_at = now() WHERE id = $1', [req.ctx.sessionId]);
    await auditBy(req.ctx, { action: 'acceso.cierre', entityType: 'usuario', entityId: req.ctx.userId, summary: 'Cierre de sesión' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/change-password', guard(), async (req) => {
    const body = parse(z.object({ current: z.string().min(1).max(200), next: z.string().min(MIN_PASSWORD_LENGTH).max(200) }), req.body);
    const { rows } = await db.query('SELECT password_hash FROM core_users WHERE id = $1', [req.ctx.userId]);
    const changeKey = `cambio|${req.ctx.userId}`;
    checkRate(changeKey);
    if (!(await verifyPassword(body.current, rows[0].password_hash))) {
      registerFailure(changeKey);
      throw badRequest('La contraseña actual no es correcta.', 'contrasena_incorrecta');
    }
    attempts.delete(changeKey);
    if (body.current === body.next) throw badRequest('La nueva contraseña debe ser distinta de la actual.');
    await db.query('UPDATE core_users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2', [
      await hashPassword(body.next), req.ctx.userId,
    ]);
    // Se cierran las demás sesiones de la persona.
    await db.query('UPDATE core_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.ctx.userId, req.ctx.sessionId]);
    await auditBy(req.ctx, { action: 'usuario.cambio_contrasena', entityType: 'usuario', entityId: req.ctx.userId, summary: 'Cambió su contraseña' });
    return { ok: true };
  });
}
