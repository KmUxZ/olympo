// Argos · malla de turnos: el turno de cada persona por fecha. En un día con malla, la malla manda sobre el horario fijo.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, inIds } from '../db/db.ts';
import { auditBy, badRequest, guard, parse, visibleUserIds } from '../core/http.ts';
import { localParts, localToUtc } from '../core/time.ts';

export interface Schedule {
  weekdays: number[];
  startTime: string;
  endTime: string;
}
/** Una fila de la malla. Sin horas = descanso. */
export interface RosterEntry {
  startTime: string | null;
  endTime: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKeyOf = (p: { year: number; month: number; day: number }) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
const weekdayOf = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const addDays = (key: string, n: number) => new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);

/** Malla de hoy para una empresa: usuario → fila. */
export async function rosterToday(companyId: string, timezone: string, now = new Date()): Promise<{ weekday: number; entries: Map<string, RosterEntry> }> {
  const key = dayKeyOf(localParts(timezone, now));
  const { rows } = await db.query(`SELECT user_id, start_time, end_time FROM argos_roster WHERE company_id = $1 AND day = $2`, [companyId, key]);
  return { weekday: weekdayOf(key), entries: new Map(rows.map((r) => [r.user_id as string, { startTime: r.start_time, endTime: r.end_time }])) };
}

/**
 * Horario que aplica hoy. Con malla para hoy, el turno es el de la malla; si la malla dice descanso, hoy no hay turno.
 * Sin malla para hoy, queda el horario fijo.
 */
export function effectiveSchedule(base: Schedule | undefined, entry: RosterEntry | undefined, weekday: number): Schedule | undefined {
  if (!entry) return base;
  if (entry.startTime && entry.endTime) return { weekdays: [weekday], startTime: entry.startTime, endTime: entry.endTime };
  return base ? { ...base, weekdays: base.weekdays.filter((d) => d !== weekday) } : undefined;
}

const dayRe = /^\d{4}-\d{2}-\d{2}$/;
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const entryBody = z.object({
  userId: z.uuid(),
  day: z.string().regex(dayRe).refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)), 'fecha no válida'),
  startTime: z.string().regex(timeRe).nullable().default(null),
  endTime: z.string().regex(timeRe).nullable().default(null),
  /** true = quitar la fila: ese día vuelve al horario fijo. */
  remove: z.boolean().default(false),
});

export function rosterRoutes(app: FastifyInstance): void {
  /** La malla de un rango de fechas, con lo que cada persona hizo de verdad esos días. Cada quien ve lo que le corresponde. */
  app.get('/api/argos/roster', guard(), async (req) => {
    const ctx = req.ctx;
    const q = parse(z.object({ from: z.string().regex(dayRe), to: z.string().regex(dayRe) }), req.query);
    if (q.to < q.from || addDays(q.from, 41) < q.to) throw badRequest('El rango debe ser de 42 días como máximo.');
    const tz = ctx.company.timezone;
    const nowParts = localParts(tz, new Date());

    const ids = await visibleUserIds(ctx);
    const params: unknown[] = [ctx.companyId];
    let filter = '';
    if (ids) {
      params.push(JSON.stringify(ids));
      filter = `AND u.id ${inIds(2)}`;
    }
    const people = (
      await db.query(
        `SELECT u.id, u.name, u.email, t.name AS "teamName", sc.weekdays, sc.start_time, sc.end_time
           FROM core_users u LEFT JOIN core_teams t ON t.id = u.team_id LEFT JOIN argos_schedules sc ON sc.user_id = u.id
          WHERE u.company_id = $1 AND u.role = 'seller' AND u.status = 'active' ${filter} ORDER BY u.name`,
        params,
      )
    ).rows;
    const userIds = JSON.stringify(people.map((p) => p.id));
    const [y, m, d] = q.from.split('-').map(Number);
    const [ty, tm, td] = addDays(q.to, 1).split('-').map(Number);

    const [entries, worked] = await Promise.all([
      db.query(
        `SELECT user_id AS "userId", day, start_time AS "startTime", end_time AS "endTime" FROM argos_roster
          WHERE company_id = $1 AND day >= $2 AND day <= $3 AND user_id ${inIds(4)}`,
        [ctx.companyId, q.from, q.to, userIds],
      ),
      db.query(
        `SELECT s.user_id AS "userId", to_char(s.started_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
                to_char(min(s.started_at) AT TIME ZONE $4, 'HH24:MI') AS "firstStart",
                round(sum(extract(epoch FROM (coalesce(s.ended_at, now()) - s.started_at)) / 60))::int AS minutes,
                bool_or(s.status = 'active') AS open
           FROM argos_shifts s
          WHERE s.company_id = $1 AND s.started_at >= $2::timestamptz AND s.started_at < $3::timestamptz AND s.user_id ${inIds(5)}
          GROUP BY 1, 2`,
        [ctx.companyId, localToUtc(tz, y, m, d).toISOString(), localToUtc(tz, ty, tm, td).toISOString(), tz, userIds],
      ),
    ]);
    return {
      today: dayKeyOf(nowParts),
      nowMinutes: nowParts.hour * 60 + nowParts.minute,
      canEdit: ctx.role !== 'seller',
      people: people.map((p) => ({ id: p.id, name: p.name, email: p.email, teamName: p.teamName, schedule: p.start_time ? { weekdays: p.weekdays, startTime: p.start_time, endTime: p.end_time } : null })),
      entries: entries.rows,
      worked: worked.rows,
    };
  });

  /** Guarda varias celdas de la malla de una vez (edición a mano, copiar semana o carga desde Excel). */
  app.put('/api/argos/roster', guard('admin', 'supervisor'), async (req) => {
    const ctx = req.ctx;
    const body = parse(z.object({ entries: z.array(entryBody).min(1).max(2000) }), req.body);
    for (const e of body.entries) {
      if (e.remove) continue;
      if (Boolean(e.startTime) !== Boolean(e.endTime)) throw badRequest('Cada turno necesita hora de inicio y hora de fin.');
      if (e.startTime && e.startTime === e.endTime) throw badRequest('La hora de inicio y la de fin no pueden ser iguales.');
    }
    // Solo vendedoras activas de la empresa que quien guarda puede ver.
    const visible = await visibleUserIds(ctx);
    const sellers = new Set((await db.query(`SELECT id FROM core_users WHERE company_id = $1 AND role = 'seller' AND status = 'active'`, [ctx.companyId])).rows.map((r) => r.id as string));
    for (const e of body.entries) {
      if (!sellers.has(e.userId) || (visible && !visible.includes(e.userId))) throw badRequest('La malla incluye una persona que no es una vendedora activa de tu equipo.', 'persona_no_valida');
    }
    await db.tx(async (t) => {
      for (const e of body.entries) {
        if (e.remove) await t.query(`DELETE FROM argos_roster WHERE user_id = $1 AND day = $2 AND company_id = $3`, [e.userId, e.day, ctx.companyId]);
        else
          await t.query(
            `INSERT INTO argos_roster (user_id, company_id, day, start_time, end_time, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, day) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [e.userId, ctx.companyId, e.day, e.startTime, e.endTime, ctx.userId],
          );
      }
    });
    const days = body.entries.map((e) => e.day).sort();
    const people = new Set(body.entries.map((e) => e.userId)).size;
    await auditBy(ctx, {
      action: 'turno.malla',
      entityType: 'malla',
      summary: `Actualizó la malla de turnos: ${body.entries.length} día(s) de ${people} persona(s), del ${days[0]} al ${days[days.length - 1]}`,
      metadata: { celdas: body.entries.length, personas: people, desde: days[0], hasta: days[days.length - 1] },
    });
    return { ok: true, saved: body.entries.length };
  });
}
