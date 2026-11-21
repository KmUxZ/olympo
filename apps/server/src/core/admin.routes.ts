import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../config.ts';
import { db, inIds } from '../db/db.ts';
import { auditBy, badRequest, guard, notFound, parse, visibleUserIds } from './http.ts';
import { hashPassword, tempPassword } from './security.ts';

const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', supervisor: 'Supervisor', seller: 'Vendedora' };
const idParam = z.object({ id: z.uuid() });

async function assertTeam(companyId: string, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const { rows } = await db.query('SELECT 1 FROM core_teams WHERE id = $1 AND company_id = $2', [teamId, companyId]);
  if (!rows.length) throw badRequest('El equipo indicado no existe.');
}

async function activeAdminCount(companyId: string, exceptId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM core_users WHERE company_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2`,
    [companyId, exceptId],
  );
  return rows[0].n;
}

export function adminRoutes(app: FastifyInstance): void {
  // ───────── Usuarios ─────────
  app.get('/api/users', guard('admin', 'supervisor'), async (req) => {
    const ids = await visibleUserIds(req.ctx);
    const params: unknown[] = [req.ctx.companyId];
    let filter = '';
    if (ids) {
      params.push(JSON.stringify(ids));
      filter = `AND u.id ${inIds(2)}`;
    }
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.team_id AS "teamId", u.is_demo AS "isDemo",
              u.must_change_password AS "mustChangePassword", u.created_at AS "createdAt",
              t.name AS "teamName", s.name AS "supervisorName"
         FROM core_users u
         LEFT JOIN core_teams t ON t.id = u.team_id
         LEFT JOIN core_users s ON s.id = t.supervisor_id
        WHERE u.company_id = $1 ${filter}
        ORDER BY u.status, u.name`,
      params,
    );
    return { users: rows };
  });

  app.post('/api/users', guard('admin'), async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.email().max(200).transform((s) => s.trim().toLowerCase()),
        role: z.enum(['admin', 'supervisor', 'seller']),
        teamId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    await assertTeam(req.ctx.companyId, body.teamId);
    const exists = await db.query('SELECT 1 FROM core_users WHERE lower(email) = $1', [body.email]);
    if (exists.rows.length) throw badRequest('Ya existe una cuenta con ese correo.', 'correo_duplicado');

    const password = tempPassword();
    const { rows } = await db.query(
      `INSERT INTO core_users (company_id, email, name, role, password_hash, team_id, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, role`,
      [req.ctx.companyId, body.email, body.name, body.role, await hashPassword(password), body.teamId ?? null, req.ctx.company.isDemo],
    );
    await auditBy(req.ctx, {
      action: 'usuario.creado', entityType: 'usuario', entityId: rows[0].id,
      summary: `Creó la cuenta de ${body.name} (${ROLE_LABEL[body.role]})`, metadata: { email: body.email, role: body.role, teamId: body.teamId ?? null },
    });
    // La contraseña temporal se muestra una sola vez; la persona debe cambiarla al entrar.
    return { user: rows[0], tempPassword: password };
  });

  app.patch('/api/users/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['admin', 'supervisor', 'seller']).optional(),
        teamId: z.uuid().nullable().optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }),
      req.body,
    );
    const current = (await db.query('SELECT * FROM core_users WHERE id = $1 AND company_id = $2', [id, req.ctx.companyId])).rows[0];
    if (!current) throw notFound('Usuario no encontrado.');
    if (body.teamId !== undefined) await assertTeam(req.ctx.companyId, body.teamId);

    const losesAdmin = current.role === 'admin' && current.status === 'active' && ((body.role && body.role !== 'admin') || body.status === 'disabled');
    if (losesAdmin) {
      if (id === req.ctx.userId) throw badRequest('No puedes quitarte tu propio acceso de administrador.');
      if ((await activeAdminCount(req.ctx.companyId, id)) === 0) throw badRequest('Debe quedar al menos un administrador activo.');
    }

    const next = {
      name: body.name ?? current.name,
      role: body.role ?? current.role,
      team_id: body.teamId !== undefined ? body.teamId : current.team_id,
      status: body.status ?? current.status,
    };
    await db.query('UPDATE core_users SET name = $1, role = $2, team_id = $3, status = $4, updated_at = now() WHERE id = $5', [
      next.name, next.role, next.team_id, next.status, id,
    ]);

    const changes: Record<string, { antes: unknown; despues: unknown }> = {};
    for (const key of ['name', 'role', 'team_id', 'status'] as const) {
      if (current[key] !== next[key]) changes[key] = { antes: current[key], despues: next[key] };
    }
    if (next.status === 'disabled' && current.status !== 'disabled') {
      await db.query('UPDATE core_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    if (Object.keys(changes).length) {
      const action = changes.status ? (next.status === 'disabled' ? 'usuario.desactivado' : 'usuario.reactivado') : changes.role ? 'usuario.cambio_rol' : 'usuario.actualizado';
      await auditBy(req.ctx, { action, entityType: 'usuario', entityId: id, summary: `Actualizó la cuenta de ${next.name}`, metadata: { cambios: changes } });
    }
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const user = (await db.query('SELECT id, name FROM core_users WHERE id = $1 AND company_id = $2', [id, req.ctx.companyId])).rows[0];
    if (!user) throw notFound('Usuario no encontrado.');
    const password = tempPassword();
    await db.query('UPDATE core_users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2', [await hashPassword(password), id]);
    await db.query('UPDATE core_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2', [id, req.ctx.sessionId]);
    await auditBy(req.ctx, { action: 'usuario.contrasena_restablecida', entityType: 'usuario', entityId: id, summary: `Restableció la contraseña de ${user.name}` });
    return { tempPassword: password };
  });

  // ───────── Equipos ─────────
  app.get('/api/teams', guard('admin', 'supervisor'), async (req) => {
    const params: unknown[] = [req.ctx.companyId];
    let filter = '';
    if (req.ctx.role === 'supervisor') {
      params.push(req.ctx.userId);
      filter = 'AND t.supervisor_id = $2';
    }
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.supervisor_id AS "supervisorId", s.name AS "supervisorName",
              (SELECT count(*)::int FROM core_users u WHERE u.team_id = t.id AND u.status = 'active') AS members
         FROM core_teams t LEFT JOIN core_users s ON s.id = t.supervisor_id
        WHERE t.company_id = $1 ${filter} ORDER BY t.name`,
      params,
    );
    return { teams: rows };
  });

  const teamBody = z.object({ name: z.string().trim().min(2).max(80), supervisorId: z.uuid().nullable().optional() });

  async function assertSupervisor(companyId: string, supervisorId: string | null | undefined): Promise<void> {
    if (!supervisorId) return;
    const { rows } = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2 AND role IN ('supervisor', 'admin') AND status = 'active'`, [supervisorId, companyId]);
    if (!rows.length) throw badRequest('La persona indicada no es un supervisor activo.');
  }

  app.post('/api/teams', guard('admin'), async (req) => {
    const body = parse(teamBody, req.body);
    await assertSupervisor(req.ctx.companyId, body.supervisorId);
    const { rows } = await db.query('INSERT INTO core_teams (company_id, name, supervisor_id) VALUES ($1, $2, $3) RETURNING id', [
      req.ctx.companyId, body.name, body.supervisorId ?? null,
    ]);
    await auditBy(req.ctx, { action: 'equipo.creado', entityType: 'equipo', entityId: rows[0].id, summary: `Creó el equipo ${body.name}`, metadata: { supervisorId: body.supervisorId ?? null } });
    return { id: rows[0].id };
  });

  app.patch('/api/teams/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(teamBody, req.body);
    await assertSupervisor(req.ctx.companyId, body.supervisorId);
    const prev = (await db.query('SELECT name, supervisor_id FROM core_teams WHERE id = $1 AND company_id = $2', [id, req.ctx.companyId])).rows[0];
    if (!prev) throw notFound('Equipo no encontrado.');
    await db.query('UPDATE core_teams SET name = $1, supervisor_id = $2 WHERE id = $3', [body.name, body.supervisorId ?? null, id]);
    await auditBy(req.ctx, {
      action: 'equipo.actualizado', entityType: 'equipo', entityId: id, summary: `Actualizó el equipo ${body.name}`,
      metadata: { antes: { name: prev.name, supervisorId: prev.supervisor_id }, despues: { name: body.name, supervisorId: body.supervisorId ?? null } },
    });
    return { ok: true };
  });

  // ───────── Auditoría ─────────
  app.get('/api/audit', guard('admin'), async (req) => {
    const q = parse(
      z.object({ action: z.string().max(60).optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );
    const params: unknown[] = [req.ctx.companyId];
    let where = '';
    if (q.action) {
      params.push(`${q.action}%`);
      where += ` AND action LIKE $${params.length}`;
    }
    if (q.from) {
      params.push(q.from);
      where += ` AND created_at >= $${params.length}::timestamptz`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND created_at <= $${params.length}::timestamptz`;
    }
    params.push(q.limit);
    const { rows } = await db.query(
      `SELECT id, actor_name AS "actorName", action, entity_type AS "entityType", summary, metadata, ip, created_at AS "createdAt"
         FROM core_audit_log WHERE company_id = $1 ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { entries: rows };
  });

  // ───────── Ajustes de la empresa ─────────
  app.get('/api/settings', guard('admin'), async (req) => ({ settings: req.ctx.company.settings, defaults: DEFAULT_SETTINGS }));

  app.patch('/api/settings', guard('admin'), async (req) => {
    const body = parse(
      z.object({
        retentionDays: z.number().int().min(7).max(730).optional(),
        staleSeconds: z.number().int().min(90).max(900).optional(),
        activityWindowMinutes: z.number().int().min(2).max(30).optional(),
        autoCloseHours: z.number().int().min(1).max(12).optional(),
      }),
      req.body,
    );
    const next = { ...req.ctx.company.settings, ...body };
    await db.query('UPDATE core_companies SET settings = $1::jsonb WHERE id = $2', [JSON.stringify(next), req.ctx.companyId]);
    await auditBy(req.ctx, { action: 'ajustes.actualizados', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Actualizó los ajustes de la empresa', metadata: { antes: req.ctx.company.settings, despues: next } });
    return { settings: next };
  });
}
