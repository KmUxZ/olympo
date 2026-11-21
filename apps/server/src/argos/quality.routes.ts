// Calidad: evaluaciones hechas por una persona (supervisor o administrador) con criterios configurables.
// Es un juicio humano sobre la atención; no usa datos de teclado.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { assertCanSeeUser, auditBy, badRequest, forbidden, guard, notFound, parse, scopeSql } from '../core/http.ts';

const MAX_SCORE = 5;
const criterionBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(''),
  weight: z.number().int().min(1).max(10).default(1),
  active: z.boolean().default(true),
});

export function qualityRoutes(app: FastifyInstance): void {
  app.get('/api/argos/quality/criteria', guard('admin', 'supervisor'), async (req) => {
    const { rows } = await db.query(`SELECT id, name, description, weight, active FROM argos_quality_criteria WHERE company_id = $1 ORDER BY active DESC, created_at`, [req.ctx.companyId]);
    return { criteria: rows, maxScore: MAX_SCORE };
  });

  app.post('/api/argos/quality/criteria', guard('admin'), async (req) => {
    const b = parse(criterionBody, req.body);
    const { rows } = await db.query(`INSERT INTO argos_quality_criteria (company_id, name, description, weight, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [req.ctx.companyId, b.name, b.description, b.weight, b.active]);
    await auditBy(req.ctx, { action: 'calidad.criterio_creado', entityType: 'criterio', entityId: rows[0].id, summary: `Creó el criterio de calidad «${b.name}»`, metadata: { weight: b.weight } });
    return { id: rows[0].id };
  });

  app.patch('/api/argos/quality/criteria/:id', guard('admin'), async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(criterionBody, req.body);
    const { count } = await db.query(`UPDATE argos_quality_criteria SET name = $3, description = $4, weight = $5, active = $6 WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId, b.name, b.description, b.weight, b.active]);
    if (!count) throw notFound('Criterio no encontrado.');
    await auditBy(req.ctx, { action: 'calidad.criterio_actualizado', entityType: 'criterio', entityId: id, summary: `Actualizó el criterio de calidad «${b.name}»`, metadata: { ...b } });
    return { ok: true };
  });

  /** Cada persona ve sus propias evaluaciones; supervisores las de su equipo; administradores todas. */
  app.get('/api/argos/quality/evaluations', guard(), async (req) => {
    const q = parse(z.object({ userId: z.uuid().optional() }), req.query);
    const params: unknown[] = [req.ctx.companyId];
    let where = await scopeSql(req.ctx, 'e.user_id', params);
    if (q.userId) {
      params.push(q.userId);
      where += ` AND e.user_id = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT e.id, e.user_id AS "userId", u.name AS "userName", v.name AS "evaluatorName", e.reference, e.observations, e.feedback,
              e.scores, e.total, e.created_at AS "createdAt", e.acknowledged_at AS "acknowledgedAt"
         FROM argos_quality_evaluations e JOIN core_users u ON u.id = e.user_id JOIN core_users v ON v.id = e.evaluator_id
        WHERE e.company_id = $1 ${where} ORDER BY e.created_at DESC LIMIT 200`,
      params,
    );
    return { evaluations: rows, maxScore: MAX_SCORE };
  });

  app.post('/api/argos/quality/evaluations', guard('admin', 'supervisor'), async (req) => {
    const b = parse(
      z.object({
        userId: z.uuid(),
        reference: z.string().trim().max(200).default(''),
        observations: z.string().trim().max(4000).default(''),
        feedback: z.string().trim().max(4000).default(''),
        scores: z.array(z.object({ criterionId: z.uuid(), score: z.number().int().min(0).max(MAX_SCORE) })).min(1).max(40),
      }),
      req.body,
    );
    await assertCanSeeUser(req.ctx, b.userId);
    if (b.userId === req.ctx.userId) throw badRequest('No puedes evaluarte a ti mismo.');
    const exists = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2`, [b.userId, req.ctx.companyId]);
    if (!exists.rows.length) throw badRequest('La persona indicada no existe.');

    const criteria = (await db.query(`SELECT id, name, weight FROM argos_quality_criteria WHERE company_id = $1 AND active`, [req.ctx.companyId])).rows;
    if (!criteria.length) throw badRequest('Primero hay que definir criterios de calidad.');
    // Se exige una nota por cada criterio activo y se guarda una copia: cambiar los criterios después no altera evaluaciones pasadas.
    const snapshot = criteria.map((c) => {
      const given = b.scores.find((s) => s.criterionId === c.id);
      if (!given) throw badRequest(`Falta la nota del criterio «${c.name}».`);
      return { criterionId: c.id, name: c.name, weight: c.weight, score: given.score };
    });
    const weightSum = snapshot.reduce((n, s) => n + s.weight, 0);
    const total = Math.round((snapshot.reduce((n, s) => n + (s.score / MAX_SCORE) * s.weight, 0) / weightSum) * 100);
    const { rows } = await db.query(
      `INSERT INTO argos_quality_evaluations (company_id, user_id, evaluator_id, reference, observations, feedback, scores, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
      [req.ctx.companyId, b.userId, req.ctx.userId, b.reference, b.observations, b.feedback, JSON.stringify(snapshot), total],
    );
    return { id: rows[0].id, total };
  });

  /** La persona evaluada confirma que leyó su evaluación. */
  app.post('/api/argos/quality/evaluations/:id/ack', guard(), async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const e = (await db.query(`SELECT user_id FROM argos_quality_evaluations WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!e) throw notFound('Evaluación no encontrada.');
    if (e.user_id !== req.ctx.userId) throw forbidden('Solo la persona evaluada puede confirmar la lectura.');
    await db.query(`UPDATE argos_quality_evaluations SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL`, [id]);
    return { ok: true };
  });
}
