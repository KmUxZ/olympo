// Panel de plataforma: gestión de empresas cliente por parte de quien opera OLYMPO.
// Principio: aquí solo hay datos de gestión (cantidades, estado, uso). Los datos operativos de una empresa
// (turnos, actividad, novedades) solo son accesibles en modo soporte, que la propia empresa concede por tiempo limitado.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { audit, auditBy, badRequest, forbidden, guard, guardPlatform, notFound, parse, PRODUCTS } from './http.ts';
import type { Ctx } from './http.ts';
import { hashPassword, tempPassword } from './security.ts';

const idParam = z.object({ id: z.uuid() });
/** Productos que hoy existen y se pueden activar. */
const productsSchema = z.array(z.enum(['argos', 'hermes', 'athena'])).min(1, 'activa al menos un producto').transform((list) => PRODUCTS.filter((p) => (list as string[]).includes(p)) as string[]);
const limitsSchema = z.object({
  maxSellers: z.number().int().min(1).max(100000).nullable().optional(),
  maxLines: z.number().int().min(1).max(100000).nullable().optional(),
});

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Las acciones de plataforma quedan en la auditoría de la empresa afectada: el cliente puede verlas. */
function platformAudit(ctx: Ctx, companyId: string, action: string, summary: string, metadata: Record<string, unknown> = {}) {
  return audit(db, { companyId, actorId: ctx.userId, actorName: `Plataforma OLYMPO · ${ctx.name}`, action, entityType: 'empresa', entityId: companyId, summary, metadata, ip: ctx.ip });
}

async function getCompany(id: string) {
  const { rows } = await db.query(`SELECT id, name, status, plan_limits, support_access_until, products FROM core_companies WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Empresa no encontrada.');
  return rows[0];
}

export function platformRoutes(app: FastifyInstance): void {
  app.get('/api/platform/companies', guardPlatform(), async () => {
    const [companies, admins] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.timezone, c.is_demo AS "isDemo", c.status, c.suspended_reason AS "suspendedReason",
                c.plan_limits AS limits, c.products, c.support_access_until AS "supportAccessUntil", c.created_at AS "createdAt",
                (SELECT count(*)::int FROM core_users u WHERE u.company_id = c.id AND u.status = 'active') AS users,
                (SELECT count(*)::int FROM core_users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role = 'seller') AS sellers,
                (SELECT count(*)::int FROM argos_lines l WHERE l.company_id = c.id AND l.active) AS lines,
                (SELECT count(*)::int FROM argos_shifts s WHERE s.company_id = c.id AND s.status = 'active') AS "activeShifts",
                (SELECT max(s.last_used_at) FROM core_sessions s WHERE s.company_id = c.id) AS "lastUsedAt"
           FROM core_companies c ORDER BY c.created_at`,
      ),
      db.query(`SELECT id, company_id, name, email FROM core_users WHERE role = 'admin' AND status = 'active' ORDER BY created_at`),
    ]);
    return {
      companies: companies.rows.map((c) => ({
        ...c,
        admins: admins.rows.filter((a) => a.company_id === c.id).map((a) => ({ id: a.id, name: a.name, email: a.email })),
      })),
    };
  });

  app.post('/api/platform/companies', guardPlatform(), async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        timezone: z.string().trim().min(3).max(60),
        adminName: z.string().trim().min(2).max(120),
        adminEmail: z.email().max(200).transform((s) => s.trim().toLowerCase()),
        limits: limitsSchema.default({}),
        products: productsSchema.default(['argos']),
      }),
      req.body,
    );
    if (!validTimezone(body.timezone)) throw badRequest('La zona horaria no es válida (ejemplo: America/Bogota).');
    const taken = await db.query(`SELECT 1 FROM core_users WHERE lower(email) = $1`, [body.adminEmail]);
    if (taken.rows.length) throw badRequest('Ya existe una cuenta con ese correo.', 'correo_duplicado');

    const password = tempPassword();
    const hash = await hashPassword(password);
    const companyId = await db.tx(async (q) => {
      const company = (await q.query(`INSERT INTO core_companies (name, timezone, plan_limits, products) VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING id`, [body.name, body.timezone, JSON.stringify(body.limits), JSON.stringify(body.products)])).rows[0];
      await q.query(`INSERT INTO core_users (company_id, email, name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)`, [company.id, body.adminEmail, body.adminName, hash]);
      return company.id as string;
    });
    await platformAudit(req.ctx, companyId, 'plataforma.empresa_creada', `Se creó la empresa ${body.name} con ${body.adminName} como administrador`, { limits: body.limits, products: body.products });
    return { id: companyId, tempPassword: password, adminEmail: body.adminEmail };
  });

  app.patch('/api/platform/companies/:id', guardPlatform(), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        status: z.enum(['active', 'suspended']).optional(),
        suspendedReason: z.string().trim().max(300).optional(),
        limits: limitsSchema.optional(),
        products: productsSchema.optional(),
      }),
      req.body,
    );
    const company = await getCompany(id);
    if (body.status === 'suspended' && id === req.ctx.company.id && !req.ctx.support) throw badRequest('No puedes suspender tu propia empresa.');

    const name = body.name ?? company.name;
    const status = body.status ?? company.status;
    const limits = body.limits ?? company.plan_limits;
    const products = body.products ?? company.products;
    await db.query(`UPDATE core_companies SET name = $2, status = $3, suspended_reason = $4, plan_limits = $5::jsonb, products = $6::jsonb WHERE id = $1`, [
      id, name, status, status === 'suspended' ? (body.suspendedReason ?? '') : '', JSON.stringify(limits), JSON.stringify(products),
    ]);
    if (body.products && JSON.stringify(body.products) !== JSON.stringify(company.products)) {
      await platformAudit(req.ctx, id, 'plataforma.productos', `Productos activos: ${body.products.join(', ')}`, { antes: company.products, despues: body.products });
    }

    if (status !== company.status) {
      if (status === 'suspended') {
        // Se cierran las sesiones de la empresa (web y extensiones) y se termina cualquier acceso de soporte.
        await db.query(`UPDATE core_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM core_users WHERE company_id = $1 AND NOT is_platform_admin)`, [id]);
        await db.query(`UPDATE core_companies SET support_access_until = NULL WHERE id = $1`, [id]);
        await platformAudit(req.ctx, id, 'plataforma.empresa_suspendida', `Se suspendió la empresa${body.suspendedReason ? `: ${body.suspendedReason}` : ''}`);
      } else {
        await platformAudit(req.ctx, id, 'plataforma.empresa_reactivada', 'Se reactivó la empresa');
      }
    }
    if (body.limits && JSON.stringify(body.limits) !== JSON.stringify(company.plan_limits)) {
      await platformAudit(req.ctx, id, 'plataforma.limites', 'Se cambiaron los límites del plan', { antes: company.plan_limits, despues: body.limits });
    }
    if (body.name && body.name !== company.name) await platformAudit(req.ctx, id, 'plataforma.empresa_renombrada', `La empresa pasó a llamarse ${body.name}`, { antes: company.name });
    return { ok: true };
  });

  /** Restablece el acceso de un administrador de la empresa cliente (p. ej. si perdió su contraseña). */
  app.post('/api/platform/companies/:id/reset-admin', guardPlatform(), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ userId: z.uuid() }), req.body);
    const user = (await db.query(`SELECT id, name, email FROM core_users WHERE id = $1 AND company_id = $2 AND role = 'admin'`, [body.userId, id])).rows[0];
    if (!user) throw notFound('Administrador no encontrado en esa empresa.');
    const password = tempPassword();
    await db.query(`UPDATE core_users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2`, [await hashPassword(password), user.id]);
    await db.query(`UPDATE core_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    await platformAudit(req.ctx, id, 'plataforma.acceso_restablecido', `Se restableció la contraseña del administrador ${user.name}`);
    return { tempPassword: password, email: user.email, name: user.name };
  });

  // ───────── Modo soporte ─────────
  /** Entra en una empresa cliente. Solo funciona si su administrador concedió acceso y sigue vigente. */
  app.post('/api/platform/companies/:id/support', guardPlatform(), async (req) => {
    const { id } = parse(idParam, req.params);
    const company = await getCompany(id);
    if (req.ctx.client !== 'web') throw forbidden();
    if (!company.support_access_until || company.support_access_until.getTime() <= Date.now()) {
      throw forbidden('Esta empresa no ha concedido acceso de soporte. Su administrador puede activarlo en Configuración.');
    }
    await db.query(`UPDATE core_sessions SET support_company_id = $2 WHERE id = $1`, [req.ctx.sessionId, id]);
    await platformAudit(req.ctx, id, 'soporte.entrada', `${req.ctx.name} entró en modo soporte`);
    return { ok: true };
  });

  app.post('/api/platform/support/exit', guard(), async (req) => {
    if (req.ctx.support) {
      await db.query(`UPDATE core_sessions SET support_company_id = NULL WHERE id = $1`, [req.ctx.sessionId]);
      await auditBy(req.ctx, { action: 'soporte.salida', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Salió del modo soporte' });
    }
    return { ok: true };
  });

  // ───────── Del lado de la empresa: conceder o revocar el acceso de soporte ─────────
  app.get('/api/settings/support-access', guard('admin'), async (req) => ({ until: req.ctx.company.supportAccessUntil }));

  app.post('/api/settings/support-access', guard('admin'), async (req) => {
    if (req.ctx.support) throw forbidden('El acceso de soporte solo puede concederlo la propia empresa.');
    const body = parse(z.object({ hours: z.number().int().min(1).max(72) }), req.body);
    const { rows } = await db.query(`UPDATE core_companies SET support_access_until = now() + ($2 || ' hours')::interval WHERE id = $1 RETURNING support_access_until`, [req.ctx.companyId, String(body.hours)]);
    await auditBy(req.ctx, { action: 'soporte.acceso_concedido', entityType: 'empresa', entityId: req.ctx.companyId, summary: `Concedió acceso de soporte a OLYMPO durante ${body.hours} h` });
    return { until: rows[0].support_access_until };
  });

  app.delete('/api/settings/support-access', guard('admin'), async (req) => {
    if (req.ctx.support) throw forbidden('El acceso de soporte solo puede revocarlo la propia empresa.');
    await db.query(`UPDATE core_companies SET support_access_until = NULL WHERE id = $1`, [req.ctx.companyId]);
    await auditBy(req.ctx, { action: 'soporte.acceso_revocado', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Revocó el acceso de soporte de OLYMPO' });
    return { until: null };
  });
}
