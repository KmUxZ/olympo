// Alarmas: reglas configurables por empresa y alertas que se abren y se cierran solas según la situación real.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveSettings } from '../config.ts';
import { db } from '../db/db.ts';
import { auditBy, guard, notFound, parse, scopeSql } from '../core/http.ts';
import { localParts } from '../core/time.ts';

export const ALARM_TYPES = {
  turno_no_iniciado: { label: 'Turno programado sin iniciar', help: 'Minutos después de la hora programada sin que la persona haya iniciado turno.', defaultMinutes: 10 },
  sin_senal: { label: 'Sin señal durante el turno', help: 'Minutos sin que la extensión sincronice con un turno abierto.', defaultMinutes: 5 },
  pausa_larga: { label: 'Pausa prolongada', help: 'Minutos que lleva abierta una pausa.', defaultMinutes: 30 },
  sin_actividad: { label: 'Sin actividad observada', help: 'Minutos conectada sin teclado ni ratón en las herramientas. Es un aviso para preguntar, no una falta: puede estar en llamada o leyendo. No se dispara si tiene una novedad abierta.', defaultMinutes: 20 },
  novedad_sin_atender: { label: 'Novedad sin atender', help: 'Minutos que lleva una novedad en estado «abierta».', defaultMinutes: 30 },
} as const;
export type AlarmType = keyof typeof ALARM_TYPES;
const TYPE_KEYS = Object.keys(ALARM_TYPES) as AlarmType[];

async function rulesOf(companyId: string): Promise<Record<AlarmType, { enabled: boolean; thresholdMinutes: number }>> {
  const { rows } = await db.query(`SELECT type, enabled, threshold_minutes FROM argos_alarm_rules WHERE company_id = $1`, [companyId]);
  const out = {} as Record<AlarmType, { enabled: boolean; thresholdMinutes: number }>;
  for (const type of TYPE_KEYS) {
    const row = rows.find((r) => r.type === type);
    out[type] = { enabled: row ? row.enabled : true, thresholdMinutes: row ? row.threshold_minutes : ALARM_TYPES[type].defaultMinutes };
  }
  return out;
}

interface Condition {
  type: AlarmType;
  userId: string;
  key: string;
  message: string;
}

const MIN = 60_000;
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Calcula qué situaciones están ocurriendo ahora mismo en una empresa. */
async function currentConditions(company: { id: string; timezone: string; settings: unknown }, now: Date): Promise<Condition[]> {
  const rules = await rulesOf(company.id);
  const settings = resolveSettings(company.settings);
  const out: Condition[] = [];
  const on = (t: AlarmType) => rules[t].enabled;
  const over = (t: AlarmType, since: Date) => now.getTime() - since.getTime() >= rules[t].thresholdMinutes * MIN;
  const mins = (since: Date) => Math.round((now.getTime() - since.getTime()) / MIN);

  const [sellers, shifts, breaks, incidents, lastActivity] = await Promise.all([
    db.query(
      `SELECT u.id, u.name, sc.weekdays, sc.start_time, sc.end_time
         FROM core_users u JOIN argos_schedules sc ON sc.user_id = u.id
        WHERE u.company_id = $1 AND u.status = 'active' AND u.role = 'seller'`,
      [company.id],
    ),
    db.query(`SELECT s.id, s.user_id, s.started_at, s.last_sync_at, u.name FROM argos_shifts s JOIN core_users u ON u.id = s.user_id WHERE s.company_id = $1 AND s.status = 'active'`, [company.id]),
    db.query(`SELECT b.id, b.shift_id, b.user_id, b.started_at, u.name FROM argos_breaks b JOIN core_users u ON u.id = b.user_id WHERE b.company_id = $1 AND b.ended_at IS NULL`, [company.id]),
    db.query(`SELECT i.id, i.user_id, i.status, i.created_at, u.name FROM argos_incidents i JOIN core_users u ON u.id = i.user_id WHERE i.company_id = $1 AND i.status <> 'resuelta'`, [company.id]),
    db.query(
      `SELECT a.shift_id, max(a.minute_start) AS last FROM argos_activity_minutes a JOIN argos_shifts s ON s.id = a.shift_id
        WHERE s.company_id = $1 AND s.status = 'active' AND a.active_seconds > 0 GROUP BY a.shift_id`,
      [company.id],
    ),
  ]);

  // Turno programado sin iniciar
  if (on('turno_no_iniciado')) {
    const p = localParts(company.timezone, now);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const nowMin = p.hour * 60 + p.minute;
    for (const s of sellers.rows) {
      const start = toMinutes(s.start_time), end = toMinutes(s.end_time);
      let sinceStart: number | null = null;
      if (start <= end) {
        if (s.weekdays.includes(weekday) && nowMin >= start && nowMin < end) sinceStart = nowMin - start;
      } else if (s.weekdays.includes(weekday) && nowMin >= start) sinceStart = nowMin - start;
      else if (s.weekdays.includes((weekday + 6) % 7) && nowMin < end) sinceStart = nowMin + 1440 - start;
      if (sinceStart === null || sinceStart < rules.turno_no_iniciado.thresholdMinutes) continue;
      if (shifts.rows.some((sh) => sh.user_id === s.id)) continue;
      // Si ya trabajó en esta franja (inició y terminó), no es "sin iniciar".
      const windowStart = new Date(now.getTime() - (sinceStart + 60) * MIN).toISOString();
      const worked = await db.query(`SELECT 1 FROM argos_shifts WHERE user_id = $1 AND started_at >= $2::timestamptz LIMIT 1`, [s.id, windowStart]);
      if (worked.rows.length) continue;
      out.push({ type: 'turno_no_iniciado', userId: s.id, key: `turno_no_iniciado:${s.id}:${p.year}-${p.month}-${p.day}`, message: `${s.name} tenía turno a las ${s.start_time} y no lo ha iniciado` });
    }
  }

  const staleIds = new Set<string>();
  for (const sh of shifts.rows) {
    const lastSeen: Date = sh.last_sync_at ?? sh.started_at;
    const stale = now.getTime() - lastSeen.getTime() > settings.staleSeconds * 1000;
    if (stale) staleIds.add(sh.id);
    if (on('sin_senal') && over('sin_senal', lastSeen)) {
      out.push({ type: 'sin_senal', userId: sh.user_id, key: `sin_senal:${sh.id}`, message: `${sh.name} lleva ${mins(lastSeen)} min sin señal de la extensión` });
    }
  }

  for (const b of breaks.rows) {
    if (on('pausa_larga') && over('pausa_larga', b.started_at)) {
      out.push({ type: 'pausa_larga', userId: b.user_id, key: `pausa_larga:${b.id}`, message: `${b.name} lleva ${mins(b.started_at)} min en pausa` });
    }
  }

  if (on('sin_actividad')) {
    for (const sh of shifts.rows) {
      if (staleIds.has(sh.id)) continue; // eso ya es "sin señal"
      if (breaks.rows.some((b) => b.shift_id === sh.id)) continue;
      if (incidents.rows.some((i) => i.user_id === sh.user_id)) continue; // una novedad abierta explica la inactividad
      const last = lastActivity.rows.find((a) => a.shift_id === sh.id);
      const since: Date = last ? new Date(last.last.getTime() + MIN) : sh.started_at;
      if (over('sin_actividad', since)) {
        out.push({ type: 'sin_actividad', userId: sh.user_id, key: `sin_actividad:${sh.id}`, message: `${sh.name} lleva ${mins(since)} min sin actividad observada en las herramientas` });
      }
    }
  }

  if (on('novedad_sin_atender')) {
    for (const i of incidents.rows) {
      if (i.status === 'abierta' && over('novedad_sin_atender', i.created_at)) {
        out.push({ type: 'novedad_sin_atender', userId: i.user_id, key: `novedad:${i.id}`, message: `La novedad de ${i.name} lleva ${mins(i.created_at)} min sin atender` });
      }
    }
  }
  return out;
}

/** Abre las alertas nuevas y cierra las que ya no aplican. */
export async function evaluateAlarms(): Promise<void> {
  const companies = await db.query(`SELECT id, timezone, settings FROM core_companies WHERE status = 'active'`);
  const now = new Date();
  for (const company of companies.rows) {
    const conditions = await currentConditions(company, now);
    const open = await db.query(`SELECT id, dedupe_key FROM argos_alerts WHERE company_id = $1 AND resolved_at IS NULL`, [company.id]);
    const openKeys = new Set(open.rows.map((a) => a.dedupe_key));
    const activeKeys = new Map(conditions.map((c) => [c.key, c]));
    for (const c of conditions) {
      if (openKeys.has(c.key)) {
        await db.query(`UPDATE argos_alerts SET message = $3 WHERE company_id = $1 AND dedupe_key = $2 AND resolved_at IS NULL`, [company.id, c.key, c.message]);
      } else {
        await db.query(`INSERT INTO argos_alerts (company_id, type, user_id, dedupe_key, message) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [company.id, c.type, c.userId, c.key, c.message]);
      }
    }
    for (const a of open.rows) {
      if (!activeKeys.has(a.dedupe_key)) await db.query(`UPDATE argos_alerts SET resolved_at = now() WHERE id = $1`, [a.id]);
    }
  }
}

export function alarmRoutes(app: FastifyInstance): void {
  app.get('/api/argos/alarms/rules', guard('admin', 'supervisor'), async (req) => {
    const rules = await rulesOf(req.ctx.companyId);
    return { rules: TYPE_KEYS.map((type) => ({ type, label: ALARM_TYPES[type].label, help: ALARM_TYPES[type].help, defaultMinutes: ALARM_TYPES[type].defaultMinutes, ...rules[type] })) };
  });

  app.put('/api/argos/alarms/rules', guard('admin'), async (req) => {
    const body = parse(
      z.object({ rules: z.array(z.object({ type: z.enum(TYPE_KEYS as [AlarmType, ...AlarmType[]]), enabled: z.boolean(), thresholdMinutes: z.number().int().min(1).max(600) })).min(1).max(TYPE_KEYS.length) }),
      req.body,
    );
    const before = await rulesOf(req.ctx.companyId);
    for (const r of body.rules) {
      await db.query(
        `INSERT INTO argos_alarm_rules (company_id, type, enabled, threshold_minutes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, threshold_minutes = EXCLUDED.threshold_minutes`,
        [req.ctx.companyId, r.type, r.enabled, r.thresholdMinutes],
      );
    }
    await auditBy(req.ctx, { action: 'alarmas.reglas', entityType: 'empresa', entityId: req.ctx.companyId, summary: 'Cambió las reglas de alarmas', metadata: { antes: before, despues: body.rules } });
    await evaluateAlarms();
    return { ok: true };
  });

  app.get('/api/argos/alerts', guard('admin', 'supervisor'), async (req) => {
    const q = parse(z.object({ state: z.enum(['open', 'all']).default('open') }), req.query);
    const params: unknown[] = [req.ctx.companyId];
    const scope = await scopeSql(req.ctx, 'a.user_id', params);
    const { rows } = await db.query(
      `SELECT a.id, a.type, a.user_id AS "userId", u.name AS "userName", a.message, a.started_at AS "startedAt", a.resolved_at AS "resolvedAt",
              a.ack_at AS "ackAt", k.name AS "ackByName"
         FROM argos_alerts a JOIN core_users u ON u.id = a.user_id LEFT JOIN core_users k ON k.id = a.ack_by
        WHERE a.company_id = $1 ${scope} ${q.state === 'open' ? 'AND a.resolved_at IS NULL' : ''}
        ORDER BY (a.resolved_at IS NOT NULL), a.started_at DESC LIMIT 200`,
      params,
    );
    return { alerts: rows.map((r) => ({ ...r, typeLabel: ALARM_TYPES[r.type as AlarmType]?.label ?? r.type })) };
  });

  /** "Enterado": alguien ya está atendiendo la situación. La alerta sigue abierta hasta que la situación termine. */
  app.post('/api/argos/alerts/:id/ack', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const params: unknown[] = [req.ctx.companyId, id];
    const scope = await scopeSql(req.ctx, 'a.user_id', params);
    const found = await db.query(`SELECT a.id FROM argos_alerts a WHERE a.company_id = $1 AND a.id = $2 ${scope}`, params);
    if (!found.rows.length) throw notFound('Alerta no encontrada.');
    await db.query(`UPDATE argos_alerts SET ack_by = $2, ack_at = now() WHERE id = $1 AND ack_at IS NULL`, [id, req.ctx.userId]);
    return { ok: true };
  });
}
