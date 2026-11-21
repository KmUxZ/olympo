import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, inIds } from '../db/db.ts';
import { assertCanSeeUser, auditBy, badRequest, guard, notFound, parse, visibleUserIds } from '../core/http.ts';

const TYPES = ['conexion', 'linea', 'plataforma', 'ausencia', 'otro'] as const;
const STATUSES = ['abierta', 'en_curso', 'resuelta'] as const;

export function incidentRoutes(app: FastifyInstance): void {
  app.get('/api/argos/incidents', guard(), async (req) => {
    const ctx = req.ctx;
    const q = parse(z.object({ status: z.enum(STATUSES).optional(), limit: z.coerce.number().int().min(1).max(300).default(150) }), req.query);
    const params: unknown[] = [ctx.companyId];
    let where = '';
    const ids = await visibleUserIds(ctx);
    if (ids) {
      params.push(JSON.stringify(ids));
      where += ` AND i.user_id ${inIds(params.length)}`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND i.status = $${params.length}`;
    }
    params.push(q.limit);
    const { rows } = await db.query(
      `SELECT i.id, i.user_id AS "userId", u.name AS "userName", r.name AS "reportedByName", i.type, i.description, i.status,
              i.resolution_note AS "resolutionNote", i.line_id AS "lineId", l.label AS "lineLabel", i.shift_id AS "shiftId",
              i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.resolved_at AS "resolvedAt"
         FROM argos_incidents i
         JOIN core_users u ON u.id = i.user_id
         JOIN core_users r ON r.id = i.reported_by
         LEFT JOIN argos_lines l ON l.id = i.line_id
        WHERE i.company_id = $1 ${where}
        ORDER BY (i.status = 'resuelta'), i.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { incidents: rows };
  });

  app.post('/api/argos/incidents', guard(), async (req) => {
    const ctx = req.ctx;
    const body = parse(
      z.object({
        type: z.enum(TYPES),
        description: z.string().trim().min(3).max(1000),
        userId: z.uuid().optional(), // supervisores y administradores pueden registrar por otra persona (p. ej. una ausencia)
        lineId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    const userId = body.userId && body.userId !== ctx.userId ? body.userId : ctx.userId;
    if (userId !== ctx.userId) {
      if (ctx.role === 'seller') throw badRequest('Solo puedes registrar novedades propias.');
      await assertCanSeeUser(ctx, userId);
      const exists = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2`, [userId, ctx.companyId]);
      if (!exists.rows.length) throw badRequest('La persona indicada no existe.');
    }
    if (body.lineId) {
      const line = await db.query(`SELECT 1 FROM argos_lines WHERE id = $1 AND company_id = $2`, [body.lineId, ctx.companyId]);
      if (!line.rows.length) throw badRequest('La línea indicada no existe.');
    }
    const shift = (await db.query(`SELECT id FROM argos_shifts WHERE user_id = $1 AND status = 'active'`, [userId])).rows[0];
    const { rows } = await db.query(
      `INSERT INTO argos_incidents (company_id, user_id, reported_by, shift_id, line_id, type, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ctx.companyId, userId, ctx.userId, shift?.id ?? null, body.lineId ?? null, body.type, body.description],
    );
    return { id: rows[0].id };
  });

  app.patch('/api/argos/incidents/:id', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ status: z.enum(STATUSES), resolutionNote: z.string().trim().max(1000).default('') }), req.body);
    const prev = (await db.query(`SELECT user_id, status, type FROM argos_incidents WHERE id = $1 AND company_id = $2`, [id, ctx.companyId])).rows[0];
    if (!prev) throw notFound('Novedad no encontrada.');
    await assertCanSeeUser(ctx, prev.user_id);
    const resolved = body.status === 'resuelta';
    await db.query(
      `UPDATE argos_incidents SET status = $2, resolution_note = $3, updated_at = now(),
              resolved_at = CASE WHEN $4 THEN now() ELSE NULL END, resolved_by = CASE WHEN $4 THEN $5::uuid ELSE NULL END
        WHERE id = $1`,
      [id, body.status, body.resolutionNote, resolved, ctx.userId],
    );
    if (prev.status !== body.status) {
      await auditBy(ctx, { action: 'novedad.estado', entityType: 'novedad', entityId: id, summary: `Cambió una novedad de "${prev.status}" a "${body.status}"`, metadata: { tipo: prev.type } });
    }
    return { ok: true };
  });
}
