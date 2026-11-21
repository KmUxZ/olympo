import type { FastifyInstance } from 'fastify';
import { db, inIds } from '../db/db.ts';
import { guard, visibleUserIds } from '../core/http.ts';
import { startOfLocalDay } from '../core/time.ts';

/**
 * Estados en vivo. Se basan en evidencia, no en suposiciones:
 *  - actividad_observada: hubo eventos de entrada en una herramienta autorizada dentro de la ventana reciente.
 *  - sin_actividad_observada: la extensión está conectada pero no hubo eventos. NO significa que no esté trabajando.
 *  - en_pausa: pausa declarada por la persona.
 *  - sin_senal: la extensión dejó de sincronizar (sin conexión, navegador cerrado o equipo suspendido).
 *  - fuera_de_turno: no hay turno abierto.
 */
export type LiveState = 'actividad_observada' | 'sin_actividad_observada' | 'en_pausa' | 'sin_senal' | 'fuera_de_turno';

interface Schedule {
  weekdays: number[];
  startTime: string;
  endTime: string;
}

export function isScheduledNow(schedule: Schedule | undefined, timezone: string, now = new Date()): boolean {
  if (!schedule) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return false;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const time = `${get('hour')}:${get('minute')}`;
  const { weekdays, startTime, endTime } = schedule;
  if (startTime <= endTime) return weekdays.includes(day) && time >= startTime && time < endTime;
  // Turno que cruza la medianoche.
  return (weekdays.includes(day) && time >= startTime) || (weekdays.includes((day + 6) % 7) && time < endTime);
}

export function dashboardRoutes(app: FastifyInstance): void {
  app.get('/api/argos/dashboard', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const now = new Date();
    const { staleSeconds, activityWindowMinutes } = ctx.company.settings;
    const ids = await visibleUserIds(ctx);
    const params: unknown[] = [ctx.companyId];
    let filter = '';
    if (ids) {
      params.push(JSON.stringify(ids));
      filter = `AND u.id ${inIds(2)}`;
    }

    const users = (
      await db.query(
        `SELECT u.id, u.name, u.team_id AS "teamId", t.name AS "teamName"
           FROM core_users u LEFT JOIN core_teams t ON t.id = u.team_id
          WHERE u.company_id = $1 AND u.role = 'seller' AND u.status = 'active' ${filter} ORDER BY u.name`,
        params,
      )
    ).rows;
    const userIds = JSON.stringify(users.map((u) => u.id));

    const [shifts, lines, schedules, incidents] = await Promise.all([
      db.query(`SELECT id, user_id, started_at, last_sync_at FROM argos_shifts WHERE status = 'active' AND user_id ${inIds(1)}`, [userIds]),
      db.query(`SELECT id, label, assigned_user_id FROM argos_lines WHERE active AND assigned_user_id ${inIds(1)} ORDER BY label`, [userIds]),
      db.query(`SELECT user_id, weekdays, start_time AS "startTime", end_time AS "endTime" FROM argos_schedules WHERE user_id ${inIds(1)}`, [userIds]),
      db.query(
        `SELECT i.id, i.user_id AS "userId", u.name AS "userName", i.type, i.description, i.status, i.created_at AS "createdAt"
           FROM argos_incidents i JOIN core_users u ON u.id = i.user_id
          WHERE i.status <> 'resuelta' AND i.user_id ${inIds(1)} ORDER BY i.created_at DESC`,
        [userIds],
      ),
    ]);
    const shiftIds = JSON.stringify(shifts.rows.map((s) => s.id));

    // Atención de hoy según la plataforma de mensajería (dato verificable, no inferido del teclado).
    const channel = await db.query(
      `SELECT s.user_id, sum(h.inbox_count)::int AS inbox, sum(h.unique_inbox_count)::int AS conversations,
              CASE WHEN sum(h.inbox_count) > 0 THEN (sum(h.avg_response_ms::bigint * h.inbox_count) / sum(h.inbox_count) / 1000)::int END AS avg_response_seconds,
              max(h.fetched_at) AS fetched_at
         FROM argos_channel_hours h
         JOIN argos_external_staff s ON s.company_id = h.company_id AND s.provider = h.provider AND s.external_id = h.external_id
        WHERE h.company_id = $1 AND h.hour_start >= $2::timestamptz AND s.user_id ${inIds(3)}
        GROUP BY s.user_id`,
      [ctx.companyId, startOfLocalDay(ctx.company.timezone, now).toISOString(), userIds],
    );
    const channelSync = (await db.query(`SELECT count(*)::int AS lines, max(last_sync_at) AS last_sync_at, count(*) FILTER (WHERE status = 'error')::int AS errors FROM argos_line_connections WHERE company_id = $1`, [ctx.companyId])).rows[0];

    const [breaks, lastActivity, totals] = await Promise.all([
      db.query(`SELECT shift_id, reason, started_at, ended_at FROM argos_breaks WHERE shift_id ${inIds(1)}`, [shiftIds]),
      db.query(
        `SELECT DISTINCT ON (a.shift_id) a.shift_id, a.minute_start, t.name AS tool
           FROM argos_activity_minutes a JOIN argos_tools t ON t.id = a.tool_id
          WHERE a.active_seconds > 0 AND a.shift_id ${inIds(1)}
          ORDER BY a.shift_id, a.minute_start DESC, a.active_seconds DESC`,
        [shiftIds],
      ),
      db.query(
        `SELECT shift_id, count(DISTINCT minute_start)::int AS observed FROM argos_activity_minutes
          WHERE active_seconds > 0 AND shift_id ${inIds(1)} GROUP BY shift_id`,
        [shiftIds],
      ),
    ]);

    // Minutos-persona con actividad observada por hora del día (hora local de la empresa).
    const hourlyRows = await db.query(
      `SELECT extract(hour FROM (a.minute_start AT TIME ZONE $4))::int AS hour, count(DISTINCT (a.shift_id, a.minute_start))::int AS minutes
         FROM argos_activity_minutes a
        WHERE a.company_id = $1 AND a.minute_start >= $2::timestamptz AND a.active_seconds > 0 AND a.user_id ${inIds(3)}
        GROUP BY 1`,
      [ctx.companyId, startOfLocalDay(ctx.company.timezone, now).toISOString(), userIds, ctx.company.timezone],
    );
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, observedMinutes: hourlyRows.rows.find((r) => r.hour === hour)?.minutes ?? 0 }));

    const counts: Record<LiveState, number> = { actividad_observada: 0, sin_actividad_observada: 0, en_pausa: 0, sin_senal: 0, fuera_de_turno: 0 };
    let notStarted = 0;

    const sellers = users.map((u) => {
      const shift = shifts.rows.find((s) => s.user_id === u.id);
      const schedule = schedules.rows.find((s) => s.user_id === u.id);
      const scheduledNow = isScheduledNow(schedule, ctx.company.timezone, now);
      const openIncidents = incidents.rows.filter((i) => i.userId === u.id).length;
      const ch = channel.rows.find((c) => c.user_id === u.id);
      const base = {
        channel: ch ? { inbox: ch.inbox, conversations: ch.conversations, avgResponseSeconds: ch.avg_response_seconds, fetchedAt: ch.fetched_at } : null,
        user: u,
        lines: lines.rows.filter((l) => l.assigned_user_id === u.id).map((l) => ({ id: l.id, label: l.label })),
        schedule: schedule ? { weekdays: schedule.weekdays, startTime: schedule.startTime, endTime: schedule.endTime } : null,
        scheduledNow,
        openIncidents,
      };
      if (!shift) {
        counts.fuera_de_turno++;
        if (scheduledNow) notStarted++;
        return { ...base, state: 'fuera_de_turno' as LiveState, since: null, shift: null, break: null, lastActivityAt: null, lastTool: null, lastDataAt: null, observedMinutes: 0, breakMinutes: 0 };
      }
      const shiftBreaks = breaks.rows.filter((b) => b.shift_id === shift.id);
      const open = shiftBreaks.find((b) => !b.ended_at);
      const last = lastActivity.rows.find((a) => a.shift_id === shift.id);
      const lastDataAt: Date = shift.last_sync_at ?? shift.started_at;
      const lastActivityAt: Date | null = last ? new Date(Math.min(last.minute_start.getTime() + 60_000, now.getTime())) : null; // el minuto en curso llega parcial

      let state: LiveState;
      let since: Date;
      if (now.getTime() - lastDataAt.getTime() > staleSeconds * 1000) {
        state = 'sin_senal';
        since = lastDataAt;
      } else if (open) {
        state = 'en_pausa';
        since = open.started_at;
      } else if (lastActivityAt && now.getTime() - lastActivityAt.getTime() <= activityWindowMinutes * 60_000) {
        state = 'actividad_observada';
        since = lastActivityAt;
      } else {
        state = 'sin_actividad_observada';
        since = lastActivityAt ?? shift.started_at;
      }
      counts[state]++;
      const breakMs = shiftBreaks.reduce((sum, b) => sum + ((b.ended_at ?? now).getTime() - b.started_at.getTime()), 0);
      return {
        ...base,
        state,
        since,
        shift: { id: shift.id, startedAt: shift.started_at },
        break: open ? { reason: open.reason, startedAt: open.started_at } : null,
        lastActivityAt,
        lastTool: last?.tool ?? null,
        lastDataAt,
        observedMinutes: totals.rows.find((t) => t.shift_id === shift.id)?.observed ?? 0,
        breakMinutes: Math.round(breakMs / 60_000),
      };
    });

    // Actividad reciente: hechos declarados o registrados en las últimas 24 h (no métricas inferidas).
    const feedRows = await db.query(
      `SELECT * FROM (
         SELECT s.started_at AS at, 'turno_inicio' AS type, s.user_id, '' AS detail FROM argos_shifts s WHERE s.user_id ${inIds(1)}
         UNION ALL
         SELECT s.ended_at, 'turno_fin', s.user_id, coalesce(s.end_reason, '') FROM argos_shifts s WHERE s.ended_at IS NOT NULL AND s.user_id ${inIds(1)}
         UNION ALL
         SELECT b.started_at, 'pausa_inicio', b.user_id, b.reason FROM argos_breaks b WHERE b.user_id ${inIds(1)}
         UNION ALL
         SELECT b.ended_at, 'pausa_fin', b.user_id, b.reason FROM argos_breaks b WHERE b.ended_at IS NOT NULL AND b.user_id ${inIds(1)}
         UNION ALL
         SELECT i.created_at, 'novedad', i.user_id, i.type FROM argos_incidents i WHERE i.user_id ${inIds(1)}
       ) e WHERE e.at > now() - interval '24 hours' ORDER BY e.at DESC LIMIT 25`,
      [userIds],
    );
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      serverTime: now,
      hourly,
      channel: { provider: 'pancake', connectedLines: channelSync.lines, lastSyncAt: channelSync.last_sync_at, errors: channelSync.errors },
      settings: { staleSeconds, activityWindowMinutes },
      counts: { ...counts, total: users.length, enTurno: users.length - counts.fuera_de_turno, sinIniciarProgramadas: notStarted, novedadesAbiertas: incidents.rows.length },
      sellers,
      openIncidents: incidents.rows,
      feed: feedRows.rows.map((f) => ({ at: f.at, type: f.type, userName: names.get(f.user_id) ?? '', detail: f.detail })),
    };
  });
}
