// Reportes: totales por persona y por día a partir de los resúmenes de turno y de los datos de la plataforma de mensajería.
// No incluye conteos de teclas ni clics: los reportes se basan en tiempos, estados y resultados verificables.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { guard, parse, scopeSql } from '../core/http.ts';
import { localParts, localToUtc } from '../core/time.ts';

const num = (field: string) => `coalesce(sum((s.summary->>'${field}')::int), 0)::int`;

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');

export function reportRoutes(app: FastifyInstance): void {
  /**
   * Cumplimiento del turno programado, por persona y día: tiempo en turno frente al tiempo programado.
   * Límite conocido: se usa la programación actual de cada persona también para los días pasados
   * (todavía no se guarda historial de programaciones).
   */
  app.get('/api/argos/reports/attendance', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(35).default(14) }), req.query);
    const tz = ctx.company.timezone;
    const now = new Date();
    const today = localParts(tz, now);
    const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    const nowMin = today.hour * 60 + today.minute;

    // Lista de días locales, del más antiguo al de hoy (se parte del mediodía para no depender de cambios de hora).
    const noon = localToUtc(tz, today.year, today.month, today.day, 12).getTime();
    const days: { key: string; weekday: number }[] = [];
    for (let i = q.days - 1; i >= 0; i--) {
      const p = localParts(tz, new Date(noon - i * 86400_000));
      days.push({ key: `${p.year}-${pad(p.month)}-${pad(p.day)}`, weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() });
    }
    const first = days[0].key.split('-').map(Number);
    const from = localToUtc(tz, first[0], first[1], first[2]).toISOString();

    const params: unknown[] = [ctx.companyId];
    const scope = await scopeSql(ctx, 'u.id', params);
    const people = await db.query(
      `SELECT u.id, u.name, t.name AS team, sc.weekdays, sc.start_time, sc.end_time,
              to_char(u.created_at AT TIME ZONE $${params.length + 1}, 'YYYY-MM-DD') AS created_day
         FROM core_users u LEFT JOIN core_teams t ON t.id = u.team_id LEFT JOIN argos_schedules sc ON sc.user_id = u.id
        WHERE u.company_id = $1 AND u.role = 'seller' AND u.status = 'active' ${scope} ORDER BY u.name`,
      [...params, tz],
    );
    const ids = JSON.stringify(people.rows.map((p) => p.id));
    const worked = await db.query(
      `SELECT s.user_id, to_char(s.started_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, count(*)::int AS shifts,
              to_char(min(s.started_at) AT TIME ZONE $3, 'HH24:MI') AS first_start,
              round(sum(extract(epoch FROM (coalesce(s.ended_at, now()) - s.started_at)) / 60))::int AS minutes,
              coalesce(sum((s.summary->>'breakMinutes')::int), 0)::int AS break_minutes,
              bool_or(s.status = 'active') AS open
         FROM argos_shifts s
        WHERE s.company_id = $1 AND s.started_at >= $2::timestamptz AND s.user_id IN (SELECT value::uuid FROM jsonb_array_elements_text($4::jsonb))
        GROUP BY 1, 2`,
      [ctx.companyId, from, tz, ids],
    );

    const rows = people.rows.map((p) => {
      const scheduled = p.start_time ? { weekdays: p.weekdays as number[], start: toMin(p.start_time), end: toMin(p.end_time) } : null;
      const length = scheduled ? (scheduled.end > scheduled.start ? scheduled.end - scheduled.start : scheduled.end + 1440 - scheduled.start) : 0;
      return {
        userId: p.id,
        userName: p.name,
        teamName: p.team,
        schedule: scheduled ? { weekdays: scheduled.weekdays, startTime: p.start_time, endTime: p.end_time } : null,
        days: days.map((d) => {
          const w = worked.rows.find((x) => x.user_id === p.id && x.day === d.key);
          const isToday = d.key === todayKey;
          const isScheduled = Boolean(scheduled?.weekdays.includes(d.weekday)) && d.key >= p.created_day;
          // Hoy se compara contra lo que ya debería llevar, no contra el turno completo.
          let expected = isScheduled ? length : 0;
          let pending = false;
          if (isScheduled && isToday && scheduled) {
            if (nowMin < scheduled.start) {
              expected = 0;
              pending = true;
            } else expected = Math.min(length, nowMin - scheduled.start);
          }
          const minutes = w?.minutes ?? 0;
          const late = w && scheduled && isScheduled ? Math.max(0, toMin(w.first_start) - scheduled.start) : 0;
          return {
            day: d.key,
            scheduled: isScheduled,
            pending,
            expectedMinutes: expected,
            workedMinutes: minutes,
            breakMinutes: w?.break_minutes ?? 0,
            shifts: w?.shifts ?? 0,
            firstStart: w?.first_start ?? null,
            lateMinutes: late,
            open: w?.open ?? false,
            // null = no aplica (día sin turno programado o aún no empieza)
            fulfillment: expected > 0 ? Math.min(100, Math.round((minutes / expected) * 100)) : null,
          };
        }),
      };
    });
    return { timezone: tz, today: todayKey, days, rows };
  });

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

    return { from: q.from, to: q.to, generatedAt: new Date(), byUser: byUser.rows, byDay: byDay.rows };
  });
}
