import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, inIds } from '../db/db.ts';
import { assertCanSeeUser, auditBy, badRequest, guard, notFound, parse, visibleUserIds } from '../core/http.ts';

const idParam = z.object({ id: z.uuid() });

// Solo dominios (con comodín de subdominio opcional). Nunca rutas ni parámetros de URL.
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Escribe solo el dominio, p. ej. web.whatsapp.com');

const toolBody = z.object({
  name: z.string().trim().min(2).max(60),
  hosts: z.array(hostSchema).min(1).max(10),
  active: z.boolean().default(true),
});

const lineBody = z.object({
  label: z.string().trim().min(2).max(60),
  channel: z.enum(['whatsapp', 'messenger', 'instagram', 'telefono', 'otro']).default('whatsapp'),
  identifier: z.string().trim().max(60).default(''),
  assignedUserId: z.uuid().nullable().optional(),
  active: z.boolean().default(true),
});

const scheduleBody = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

async function userName(companyId: string, userId: string): Promise<string> {
  const { rows } = await db.query(`SELECT name FROM core_users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
  if (!rows.length) throw badRequest('La persona indicada no existe.');
  return rows[0].name;
}

export function catalogRoutes(app: FastifyInstance): void {
  // ───────── Herramientas autorizadas ─────────
  app.get('/api/argos/tools', guard(), async (req) => {
    const { rows } = await db.query(`SELECT id, name, hosts, active FROM argos_tools WHERE company_id = $1 ORDER BY active DESC, name`, [req.ctx.companyId]);
    return { tools: rows };
  });

  app.post('/api/argos/tools', guard('admin'), async (req) => {
    const body = parse(toolBody, req.body);
    const { rows } = await db.query(`INSERT INTO argos_tools (company_id, name, hosts, active) VALUES ($1, $2, $3::jsonb, $4) RETURNING id`, [
      req.ctx.companyId, body.name, JSON.stringify([...new Set(body.hosts)]), body.active,
    ]);
    await auditBy(req.ctx, { action: 'herramienta.creada', entityType: 'herramienta', entityId: rows[0].id, summary: `Autorizó la herramienta ${body.name}`, metadata: { hosts: body.hosts } });
    return { id: rows[0].id };
  });

  app.patch('/api/argos/tools/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(toolBody, req.body);
    const prev = (await db.query(`SELECT name, hosts, active FROM argos_tools WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!prev) throw notFound('Herramienta no encontrada.');
    await db.query(`UPDATE argos_tools SET name = $1, hosts = $2::jsonb, active = $3 WHERE id = $4`, [body.name, JSON.stringify([...new Set(body.hosts)]), body.active, id]);
    await auditBy(req.ctx, {
      action: body.active ? 'herramienta.actualizada' : 'herramienta.desactivada', entityType: 'herramienta', entityId: id,
      summary: `Actualizó la herramienta ${body.name}`, metadata: { antes: prev, despues: body },
    });
    return { ok: true };
  });

  // ───────── Líneas ─────────
  app.get('/api/argos/lines', guard(), async (req) => {
    const ids = await visibleUserIds(req.ctx);
    const params: unknown[] = [req.ctx.companyId];
    let filter = '';
    if (ids) {
      params.push(JSON.stringify(ids));
      filter = `AND l.assigned_user_id ${inIds(2)}`;
    }
    const { rows } = await db.query(
      `SELECT l.id, l.label, l.channel, l.identifier, l.active, l.assigned_user_id AS "assignedUserId", u.name AS "assignedUserName"
         FROM argos_lines l LEFT JOIN core_users u ON u.id = l.assigned_user_id
        WHERE l.company_id = $1 ${filter} ORDER BY l.active DESC, l.label`,
      params,
    );
    return { lines: rows };
  });

  app.post('/api/argos/lines', guard('admin'), async (req) => {
    const body = parse(lineBody, req.body);
    const assignee = body.assignedUserId ? await userName(req.ctx.companyId, body.assignedUserId) : null;
    const { rows } = await db.query(
      `INSERT INTO argos_lines (company_id, label, channel, identifier, assigned_user_id, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.ctx.companyId, body.label, body.channel, body.identifier, body.assignedUserId ?? null, body.active],
    );
    await auditBy(req.ctx, {
      action: 'linea.creada', entityType: 'linea', entityId: rows[0].id,
      summary: `Creó la línea ${body.label}${assignee ? ` y la asignó a ${assignee}` : ''}`, metadata: { ...body },
    });
    return { id: rows[0].id };
  });

  app.patch('/api/argos/lines/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(lineBody, req.body);
    const prev = (await db.query(`SELECT label, channel, identifier, assigned_user_id, active FROM argos_lines WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!prev) throw notFound('Línea no encontrada.');
    const assignee = body.assignedUserId ? await userName(req.ctx.companyId, body.assignedUserId) : null;
    await db.query(`UPDATE argos_lines SET label = $1, channel = $2, identifier = $3, assigned_user_id = $4, active = $5 WHERE id = $6`, [
      body.label, body.channel, body.identifier, body.assignedUserId ?? null, body.active, id,
    ]);
    const reassigned = (prev.assigned_user_id ?? null) !== (body.assignedUserId ?? null);
    await auditBy(req.ctx, {
      action: reassigned ? 'linea.asignacion' : 'linea.actualizada', entityType: 'linea', entityId: id,
      summary: reassigned ? `${assignee ? `Asignó la línea ${body.label} a ${assignee}` : `Dejó sin asignar la línea ${body.label}`}` : `Actualizó la línea ${body.label}`,
      metadata: { antes: prev, despues: body },
    });
    return { ok: true };
  });

  // ───────── Programación de turnos ─────────
  app.get('/api/argos/schedules', guard(), async (req) => {
    const ids = await visibleUserIds(req.ctx);
    const params: unknown[] = [req.ctx.companyId];
    let filter = '';
    if (ids) {
      params.push(JSON.stringify(ids));
      filter = `AND user_id ${inIds(2)}`;
    }
    const { rows } = await db.query(
      `SELECT user_id AS "userId", weekdays, start_time AS "startTime", end_time AS "endTime" FROM argos_schedules WHERE company_id = $1 ${filter}`,
      params,
    );
    return { schedules: rows };
  });

  app.put('/api/argos/schedules/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(scheduleBody, req.body);
    const name = await userName(req.ctx.companyId, id);
    const weekdays = [...new Set(body.weekdays)].sort();
    await db.query(
      `INSERT INTO argos_schedules (user_id, company_id, weekdays, start_time, end_time) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET weekdays = EXCLUDED.weekdays, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, updated_at = now()`,
      [id, req.ctx.companyId, JSON.stringify(weekdays), body.startTime, body.endTime],
    );
    await auditBy(req.ctx, { action: 'turno.programacion', entityType: 'usuario', entityId: id, summary: `Programó el turno de ${name} (${body.startTime}–${body.endTime})`, metadata: { ...body, weekdays } });
    return { ok: true };
  });

  app.delete('/api/argos/schedules/:id', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    await assertCanSeeUser(req.ctx, id);
    const name = await userName(req.ctx.companyId, id);
    const { count } = await db.query(`DELETE FROM argos_schedules WHERE user_id = $1 AND company_id = $2`, [id, req.ctx.companyId]);
    if (count) await auditBy(req.ctx, { action: 'turno.programacion_eliminada', entityType: 'usuario', entityId: id, summary: `Quitó la programación de turno de ${name}` });
    return { ok: true };
  });
}
