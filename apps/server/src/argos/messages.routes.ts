// Mensajes internos entre administración, supervisores y vendedoras.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { badRequest, forbidden, guard, parse, supervisedTeamIds, visibleUserIds } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';

const inJson = (p: string) => `IN (SELECT value::uuid FROM jsonb_array_elements_text(${p}::jsonb))`;

/** Equipos cuyos mensajes de difusión recibe la persona: el suyo y los que supervisa. */
async function myTeams(ctx: Ctx): Promise<string[]> {
  return [...new Set([...(ctx.teamId ? [ctx.teamId] : []), ...(await supervisedTeamIds(ctx))])];
}

/** Condición: mensajes dirigidos a mí (directos, a mi equipo o a toda la empresa). */
export async function receivedSql(ctx: Ctx, params: unknown[]): Promise<string> {
  params.push(ctx.userId);
  const me = `$${params.length}`;
  params.push(JSON.stringify(await myTeams(ctx)));
  const teams = `$${params.length}`;
  return `(m.sender_id <> ${me} AND (m.to_user_id = ${me} OR m.to_team_id ${inJson(teams)} OR m.to_all))`;
}

/** A quién puede escribir cada rol. */
async function recipients(ctx: Ctx) {
  const all = await db.query(`SELECT u.id, u.name, u.role, u.team_id FROM core_users u WHERE u.company_id = $1 AND u.status = 'active' AND u.id <> $2 ORDER BY u.name`, [ctx.companyId, ctx.userId]);
  const teams = await db.query(`SELECT id, name, supervisor_id FROM core_teams WHERE company_id = $1 ORDER BY name`, [ctx.companyId]);
  if (ctx.role === 'admin') return { users: all.rows, teams: teams.rows, canAll: true };
  if (ctx.role === 'supervisor') {
    const scope = new Set((await visibleUserIds(ctx)) ?? []);
    return { users: all.rows.filter((u) => scope.has(u.id) || u.role !== 'seller'), teams: teams.rows.filter((t) => t.supervisor_id === ctx.userId), canAll: false };
  }
  // Vendedora: a administración y a quien supervisa su equipo.
  const mySupervisor = teams.rows.find((t) => t.id === ctx.teamId)?.supervisor_id;
  return { users: all.rows.filter((u) => u.role === 'admin' || u.id === mySupervisor), teams: [], canAll: false };
}

export function messageRoutes(app: FastifyInstance): void {
  app.get('/api/argos/messages/recipients', guard(), async (req) => {
    const r = await recipients(req.ctx);
    return { users: r.users.map((u) => ({ id: u.id, name: u.name, role: u.role })), teams: r.teams.map((t) => ({ id: t.id, name: t.name })), canAll: r.canAll };
  });

  app.get('/api/argos/messages', guard(), async (req) => {
    const params: unknown[] = [req.ctx.companyId];
    const received = await receivedSql(req.ctx, params);
    params.push(req.ctx.userId);
    const me = `$${params.length}`;
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.created_at AS "createdAt", m.sender_id AS "senderId", s.name AS "senderName",
              m.to_user_id AS "toUserId", tu.name AS "toUserName", m.to_team_id AS "toTeamId", tt.name AS "toTeamName", m.to_all AS "toAll",
              (m.sender_id = ${me}) AS mine,
              (m.sender_id = ${me} OR EXISTS (SELECT 1 FROM argos_message_reads r WHERE r.message_id = m.id AND r.user_id = ${me})) AS read
         FROM argos_messages m
         JOIN core_users s ON s.id = m.sender_id LEFT JOIN core_users tu ON tu.id = m.to_user_id LEFT JOIN core_teams tt ON tt.id = m.to_team_id
        WHERE m.company_id = $1 AND (m.sender_id = ${me} OR ${received})
        ORDER BY m.created_at DESC LIMIT 200`,
      params,
    );
    return { messages: rows };
  });

  app.post('/api/argos/messages', guard(), async (req) => {
    const b = parse(
      z.object({ body: z.string().trim().min(1).max(2000), toUserId: z.uuid().nullable().optional(), toTeamId: z.uuid().nullable().optional(), toAll: z.boolean().default(false) }),
      req.body,
    );
    const targets = [b.toUserId, b.toTeamId, b.toAll || null].filter(Boolean).length;
    if (targets !== 1) throw badRequest('Elige un único destinatario: una persona, un equipo o toda la empresa.');
    const allowed = await recipients(req.ctx);
    if (b.toUserId && !allowed.users.some((u) => u.id === b.toUserId)) throw forbidden('No puedes escribir a esa persona.');
    if (b.toTeamId && !allowed.teams.some((t) => t.id === b.toTeamId)) throw forbidden('No puedes escribir a ese equipo.');
    if (b.toAll && !allowed.canAll) throw forbidden('Solo un administrador puede escribir a toda la empresa.');
    const { rows } = await db.query(
      `INSERT INTO argos_messages (company_id, sender_id, to_user_id, to_team_id, to_all, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.ctx.companyId, req.ctx.userId, b.toUserId ?? null, b.toTeamId ?? null, b.toAll, b.body],
    );
    return { id: rows[0].id };
  });

  /** Marca como leídos todos los mensajes recibidos. */
  app.post('/api/argos/messages/read', guard(), async (req) => {
    const params: unknown[] = [req.ctx.companyId];
    const received = await receivedSql(req.ctx, params);
    params.push(req.ctx.userId);
    await db.query(
      `INSERT INTO argos_message_reads (message_id, user_id)
       SELECT m.id, $${params.length}::uuid FROM argos_messages m WHERE m.company_id = $1 AND ${received}
       ON CONFLICT DO NOTHING`,
      params,
    );
    return { ok: true };
  });
}
