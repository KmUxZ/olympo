// Agenda: tareas, reuniones, compromisos y actividades programadas para una persona, un equipo o toda la empresa.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { assertCanSeeUser, badRequest, forbidden, guard, notFound, parse, supervisedTeamIds, visibleUserIds } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';

const KINDS = ['tarea', 'reunion', 'compromiso', 'actividad'] as const;
const STATUSES = ['pendiente', 'hecha', 'cancelada'] as const;
const idParam = z.object({ id: z.uuid() });

/** Condición SQL de qué elementos de agenda puede ver quien consulta. */
export async function agendaVisibility(ctx: Ctx, params: unknown[]): Promise<string> {
  if (ctx.role === 'admin') return '';
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const forAll = `(a.user_id IS NULL AND a.team_id IS NULL)`;
  if (ctx.role === 'seller') {
    return ` AND (a.user_id = ${push(ctx.userId)} OR ${ctx.teamId ? `a.team_id = ${push(ctx.teamId)} OR ` : ''}${forAll})`;
  }
  const users = JSON.stringify((await visibleUserIds(ctx)) ?? []);
  const teams = JSON.stringify([...(await supervisedTeamIds(ctx)), ...(ctx.teamId ? [ctx.teamId] : [])]);
  const inJson = (p: string) => `IN (SELECT value::uuid FROM jsonb_array_elements_text(${p}::jsonb))`;
  return ` AND (a.user_id ${inJson(push(users))} OR a.team_id ${inJson(push(teams))} OR a.created_by = ${push(ctx.userId)} OR ${forAll})`;
}

async function assertTarget(ctx: Ctx, userId: string | null, teamId: string | null): Promise<void> {
  if (userId && teamId) throw badRequest('Elige una persona o un equipo, no ambos.');
  if (ctx.role === 'seller') {
    if (userId !== ctx.userId || teamId) throw forbidden('Solo puedes crear elementos en tu propia agenda.');
    return;
  }
  if (userId) {
    await assertCanSeeUser(ctx, userId);
    const ok = await db.query(`SELECT 1 FROM core_users WHERE id = $1 AND company_id = $2`, [userId, ctx.companyId]);
    if (!ok.rows.length) throw badRequest('La persona indicada no existe.');
  }
  if (teamId) {
    const ok = await db.query(`SELECT supervisor_id FROM core_teams WHERE id = $1 AND company_id = $2`, [teamId, ctx.companyId]);
    if (!ok.rows.length) throw badRequest('El equipo indicado no existe.');
    if (ctx.role === 'supervisor' && ok.rows[0].supervisor_id !== ctx.userId) throw forbidden('Solo puedes programar para los equipos que supervisas.');
  }
  if (!userId && !teamId && ctx.role !== 'admin') throw forbidden('Solo un administrador puede programar para toda la empresa.');
}

export function agendaRoutes(app: FastifyInstance): void {
  app.get('/api/argos/agenda', guard(), async (req) => {
    const q = parse(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), status: z.enum(STATUSES).optional() }), req.query);
    const params: unknown[] = [req.ctx.companyId, q.from, q.to];
    let where = await agendaVisibility(req.ctx, params);
    if (q.status) {
      params.push(q.status);
      where += ` AND a.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.notes, a.kind, a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status, a.completed_at AS "completedAt",
              a.user_id AS "userId", u.name AS "userName", a.team_id AS "teamId", t.name AS "teamName", a.created_by AS "createdBy", c.name AS "createdByName"
         FROM argos_agenda a
         LEFT JOIN core_users u ON u.id = a.user_id LEFT JOIN core_teams t ON t.id = a.team_id JOIN core_users c ON c.id = a.created_by
        WHERE a.company_id = $1 AND a.starts_at >= $2::timestamptz AND a.starts_at <= $3::timestamptz ${where}
        ORDER BY a.starts_at LIMIT 500`,
      params,
    );
    return { items: rows };
  });

  const body = z.object({
    title: z.string().trim().min(2).max(140),
    notes: z.string().trim().max(1000).default(''),
    kind: z.enum(KINDS),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    userId: z.uuid().nullable().optional(),
    teamId: z.uuid().nullable().optional(),
  });

  app.post('/api/argos/agenda', guard(), async (req) => {
    const b = parse(body, req.body);
    const userId = req.ctx.role === 'seller' ? req.ctx.userId : (b.userId ?? null);
    const teamId = b.teamId ?? null;
    await assertTarget(req.ctx, userId, teamId);
    if (b.endsAt && new Date(b.endsAt) < new Date(b.startsAt)) throw badRequest('La hora de fin debe ser posterior al inicio.');
    const { rows } = await db.query(
      `INSERT INTO argos_agenda (company_id, title, notes, kind, starts_at, ends_at, user_id, team_id, created_by)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9) RETURNING id`,
      [req.ctx.companyId, b.title, b.notes, b.kind, b.startsAt, b.endsAt ?? null, userId, teamId, req.ctx.userId],
    );
    return { id: rows[0].id };
  });

  /** Cambiar estado: lo puede hacer cualquiera que vea el elemento (p. ej. la persona marca su tarea como hecha). */
  app.patch('/api/argos/agenda/:id', guard(), async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(STATUSES) }), req.body);
    const params: unknown[] = [req.ctx.companyId, id];
    const visible = await agendaVisibility(req.ctx, params);
    const found = await db.query(`SELECT a.id FROM argos_agenda a WHERE a.company_id = $1 AND a.id = $2 ${visible}`, params);
    if (!found.rows.length) throw notFound('Elemento de agenda no encontrado.');
    await db.query(`UPDATE argos_agenda SET status = $2, completed_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1`, [id, b.status, b.status === 'hecha']);
    return { ok: true };
  });

  app.delete('/api/argos/agenda/:id', guard(), async (req) => {
    const { id } = parse(idParam, req.params);
    const item = (await db.query(`SELECT created_by FROM argos_agenda WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!item) throw notFound('Elemento de agenda no encontrado.');
    if (item.created_by !== req.ctx.userId && req.ctx.role !== 'admin') throw forbidden('Solo quien lo creó o un administrador puede eliminarlo.');
    await db.query(`DELETE FROM argos_agenda WHERE id = $1`, [id]);
    return { ok: true };
  });
}
