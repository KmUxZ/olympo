// Acompañamiento: sesiones de seguimiento con cada persona, compromisos y su cumplimiento.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { assertCanSeeUser, badRequest, guard, notFound, parse, scopeSql } from '../core/http.ts';

const COMMITMENT_STATUS = ['pendiente', 'cumplido', 'no_cumplido'] as const;

export function coachingRoutes(app: FastifyInstance): void {
  /** Cada persona ve sus propias sesiones; supervisores las de su equipo; administradores todas. */
  app.get('/api/argos/coaching', guard(), async (req) => {
    const q = parse(z.object({ userId: z.uuid().optional() }), req.query);
    const params: unknown[] = [req.ctx.companyId];
    let where = await scopeSql(req.ctx, 's.user_id', params);
    if (q.userId) {
      params.push(q.userId);
      where += ` AND s.user_id = $${params.length}`;
    }
    const sessions = await db.query(
      `SELECT s.id, s.user_id AS "userId", u.name AS "userName", c.name AS "coachName", s.held_at AS "heldAt", s.topic, s.notes
         FROM argos_coaching_sessions s JOIN core_users u ON u.id = s.user_id JOIN core_users c ON c.id = s.coach_id
        WHERE s.company_id = $1 ${where} ORDER BY s.held_at DESC LIMIT 200`,
      params,
    );
    const ids = JSON.stringify(sessions.rows.map((s) => s.id));
    const commitments = await db.query(
      `SELECT id, session_id AS "sessionId", text, due_date AS "dueDate", status FROM argos_commitments
        WHERE session_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) ORDER BY due_date NULLS LAST`,
      [ids],
    );
    return { sessions: sessions.rows.map((s) => ({ ...s, commitments: commitments.rows.filter((c) => c.sessionId === s.id) })) };
  });

  app.post('/api/argos/coaching', guard('admin', 'supervisor'), async (req) => {
    const b = parse(
      z.object({
        userId: z.uuid(),
        heldAt: z.iso.datetime({ offset: true }),
        topic: z.string().trim().min(2).max(160),
        notes: z.string().trim().max(4000).default(''),
        commitments: z.array(z.object({ text: z.string().trim().min(2).max(300), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })).max(20).default([]),
      }),
      req.body,
    );
    await assertCanSeeUser(req.ctx, b.userId);
    const exists = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2`, [b.userId, req.ctx.companyId]);
    if (!exists.rows.length) throw badRequest('La persona indicada no existe.');
    const session = (
      await db.query(`INSERT INTO argos_coaching_sessions (company_id, user_id, coach_id, held_at, topic, notes) VALUES ($1, $2, $3, $4::timestamptz, $5, $6) RETURNING id`, [
        req.ctx.companyId, b.userId, req.ctx.userId, b.heldAt, b.topic, b.notes,
      ])
    ).rows[0];
    for (const c of b.commitments) {
      await db.query(`INSERT INTO argos_commitments (company_id, session_id, user_id, text, due_date) VALUES ($1, $2, $3, $4, $5)`, [req.ctx.companyId, session.id, b.userId, c.text, c.dueDate ?? null]);
    }
    return { id: session.id };
  });

  app.patch('/api/argos/coaching/commitments/:id', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ status: z.enum(COMMITMENT_STATUS) }), req.body);
    const c = (await db.query(`SELECT user_id FROM argos_commitments WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!c) throw notFound('Compromiso no encontrado.');
    await assertCanSeeUser(req.ctx, c.user_id);
    await db.query(`UPDATE argos_commitments SET status = $2, updated_at = now() WHERE id = $1`, [id, b.status]);
    return { ok: true };
  });
}
