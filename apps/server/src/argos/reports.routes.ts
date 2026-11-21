// Reportes: totales por persona y por día a partir de los resúmenes de turno y de los datos de la plataforma de mensajería.
// No incluye conteos de teclas ni clics: los reportes se basan en tiempos, estados y resultados verificables.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { guard, parse, scopeSql } from '../core/http.ts';

const num = (field: string) => `coalesce(sum((s.summary->>'${field}')::int), 0)::int`;

export function reportRoutes(app: FastifyInstance): void {
  app.get('/api/argos/reports', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const q = parse(
      z.object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
        userId: z.uuid().optional(),
        teamId: z.uuid().optional(),
        lineId: z.uuid().optional(),
      }),
      req.query,
    );

    // Filtros comunes sobre turnos
    const params: unknown[] = [ctx.companyId, q.from, q.to];
    let where = await scopeSql(ctx, 's.user_id', params);
    if (q.userId) {
      params.push(q.userId);
      where += ` AND s.user_id = $${params.length}`;
    }
    if (q.teamId) {
      params.push(q.teamId);
      where += ` AND s.team_id = $${params.length}`;
    }
    if (q.lineId) {
      // La línea se toma de la copia guardada al iniciar el turno.
      params.push(JSON.stringify([{ id: q.lineId }]));
      where += ` AND s.lines @> $${params.length}::jsonb`;
    }
    const base = `FROM argos_shifts s JOIN core_users u ON u.id = s.user_id LEFT JOIN core_teams t ON t.id = s.team_id
                 WHERE s.company_id = $1 AND s.started_at >= $2::timestamptz AND s.started_at <= $3::timestamptz ${where}`;
    const totals = `count(*)::int AS shifts, (count(*) FILTER (WHERE s.status = 'active'))::int AS "openShifts",
                    ${num('durationMinutes')} AS "durationMinutes", ${num('observedMinutes')} AS "observedMinutes",
                    ${num('noActivityMinutes')} AS "noActivityMinutes", ${num('breakMinutes')} AS "breakMinutes",
                    ${num('noDataMinutes')} AS "noDataMinutes", ${num('incidents')} AS incidents`;

    const tzParams = [...params, ctx.company.timezone];
    const [byUser, byDay] = await Promise.all([
      db.query(`SELECT s.user_id AS "userId", u.name AS "userName", max(t.name) AS "teamName", ${totals} ${base} GROUP BY s.user_id, u.name ORDER BY u.name`, params),
      db.query(
        `SELECT to_char(s.started_at AT TIME ZONE $${tzParams.length}, 'YYYY-MM-DD') AS day, ${totals} ${base} GROUP BY 1 ORDER BY 1`,
        tzParams,
      ),
    ]);

    // Atención según la plataforma de mensajería, en el mismo periodo y con los mismos filtros.
    const cParams: unknown[] = [ctx.companyId, q.from, q.to];
    let cWhere = await scopeSql(ctx, 'x.user_id', cParams);
    if (q.userId) {
      cParams.push(q.userId);
      cWhere += ` AND x.user_id = $${cParams.length}`;
    }
    if (q.teamId) {
      cParams.push(q.teamId);
      cWhere += ` AND u.team_id = $${cParams.length}`;
    }
    if (q.lineId) {
      cParams.push(q.lineId);
      cWhere += ` AND h.line_id = $${cParams.length}`;
    }
    const channel = await db.query(
      `SELECT x.user_id AS "userId", sum(h.inbox_count)::int AS inbox,
              CASE WHEN sum(h.inbox_count) > 0 THEN (sum(h.avg_response_ms::bigint * h.inbox_count) / sum(h.inbox_count) / 1000)::int END AS "avgResponseSeconds"
         FROM argos_channel_hours h
         JOIN argos_external_staff x ON x.company_id = h.company_id AND x.provider = h.provider AND x.external_id = h.external_id
         JOIN core_users u ON u.id = x.user_id
        WHERE h.company_id = $1 AND h.hour_start >= $2::timestamptz AND h.hour_start <= $3::timestamptz ${cWhere}
        GROUP BY x.user_id`,
      cParams,
    );

    const rows = byUser.rows.map((r) => {
      const c = channel.rows.find((x) => x.userId === r.userId);
      return { ...r, inbox: c?.inbox ?? null, avgResponseSeconds: c?.avgResponseSeconds ?? null };
    });
    // Personas con datos de mensajería pero sin turnos en el periodo: también se muestran.
    for (const c of channel.rows) {
      if (rows.some((r) => r.userId === c.userId)) continue;
      const u = (await db.query(`SELECT u.name, t.name AS team FROM core_users u LEFT JOIN core_teams t ON t.id = u.team_id WHERE u.id = $1`, [c.userId])).rows[0];
      rows.push({ userId: c.userId, userName: u?.name ?? '', teamName: u?.team ?? null, shifts: 0, openShifts: 0, durationMinutes: 0, observedMinutes: 0, noActivityMinutes: 0, breakMinutes: 0, noDataMinutes: 0, incidents: 0, inbox: c.inbox, avgResponseSeconds: c.avgResponseSeconds });
    }

    return { from: q.from, to: q.to, generatedAt: new Date(), hasChannelData: channel.rows.length > 0, byUser: rows, byDay: byDay.rows };
  });
}
