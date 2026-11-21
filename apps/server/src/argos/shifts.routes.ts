import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONSENT_VERSION } from '../config.ts';
import { db, inIds } from '../db/db.ts';
import { assertCanSeeUser, auditBy, badRequest, forbidden, guard, HttpError, notFound, parse, visibleUserIds } from '../core/http.ts';
import type { Ctx } from '../core/http.ts';
import { closeShift, computeSummary, floorMinute } from './summary.ts';
import type { ShiftRow } from './summary.ts';

const idParam = z.object({ id: z.uuid() });
export const BREAK_REASONS = ['descanso', 'almuerzo', 'personal', 'capacitacion', 'otro'] as const;

async function getShift(ctx: Ctx, id: string): Promise<ShiftRow & { lines: unknown; end_reason: string | null; summary: unknown }> {
  const { rows } = await db.query(`SELECT * FROM argos_shifts WHERE id = $1 AND company_id = $2`, [id, ctx.companyId]);
  if (!rows.length) throw notFound('Turno no encontrado.');
  return rows[0];
}

async function activeShiftOf(userId: string): Promise<ShiftRow | null> {
  const { rows } = await db.query(`SELECT * FROM argos_shifts WHERE user_id = $1 AND status = 'active'`, [userId]);
  return rows[0] ?? null;
}

async function openBreakOf(shiftId: string) {
  const { rows } = await db.query(`SELECT id, reason, note, started_at AS "startedAt" FROM argos_breaks WHERE shift_id = $1 AND ended_at IS NULL`, [shiftId]);
  return rows[0] ?? null;
}

/**
 * Los conteos de teclas, clics y desplazamientos solo los ven la propia persona y el administrador.
 * A los supervisores se les entregan estados y tiempos: así ninguna evaluación se apoya en el teclado.
 */
function summaryFor(ctx: Ctx, ownerId: string, summary: any): any {
  if (!summary || ctx.role !== 'supervisor' || ownerId === ctx.userId) return summary;
  const { keyCount: _k, clickCount: _c, scrollCount: _s, ...rest } = summary;
  return { ...rest, tools: (summary.tools ?? []).map(({ keyCount: _tk, clickCount: _tc, ...tool }: any) => tool), countsHidden: true };
}

async function consentOf(userId: string): Promise<{ version: string; accepted: boolean; acceptedAt: Date | null }> {
  const { rows } = await db.query(`SELECT accepted_at FROM argos_consents WHERE user_id = $1 AND version = $2`, [userId, CONSENT_VERSION]);
  return { version: CONSENT_VERSION, accepted: rows.length > 0, acceptedAt: rows[0]?.accepted_at ?? null };
}

const shiftView = (s: ShiftRow) => ({ id: s.id, status: s.status, startedAt: s.started_at, endedAt: s.ended_at, lastSyncAt: s.last_sync_at });

const syncBody = z.object({
  sentAt: z.iso.datetime({ offset: true }),
  minutes: z
    .array(
      z.object({
        minute: z.iso.datetime({ offset: true }),
        systemState: z.enum(['active', 'idle', 'locked', 'unknown']).default('unknown'),
        tools: z
          .array(
            z.object({
              toolId: z.uuid(),
              focusSeconds: z.number().int().min(0),
              activeSeconds: z.number().int().min(0),
              keys: z.number().int().min(0),
              clicks: z.number().int().min(0),
              scrolls: z.number().int().min(0),
            }),
          )
          .max(30)
          .default([]),
      }),
    )
    .max(3000),
});

export function shiftRoutes(app: FastifyInstance): void {
  /** Estado propio: lo usan la extensión y la vista "Mi turno". */
  app.get('/api/argos/me/state', guard(), async (req) => {
    const ctx = req.ctx;
    const shift = await activeShiftOf(ctx.userId);
    const [tools, lines, schedule] = await Promise.all([
      db.query(`SELECT id, name, hosts FROM argos_tools WHERE company_id = $1 AND active ORDER BY name`, [ctx.companyId]),
      db.query(`SELECT id, label, channel, identifier FROM argos_lines WHERE assigned_user_id = $1 AND active ORDER BY label`, [ctx.userId]),
      db.query(`SELECT weekdays, start_time AS "startTime", end_time AS "endTime" FROM argos_schedules WHERE user_id = $1`, [ctx.userId]),
    ]);
    return {
      serverTime: new Date(),
      user: { id: ctx.userId, name: ctx.name, email: ctx.email, role: ctx.role },
      company: { name: ctx.company.name, isDemo: ctx.company.isDemo, timezone: ctx.company.timezone },
      shift: shift ? shiftView(shift) : null,
      openBreak: shift ? await openBreakOf(shift.id) : null,
      tools: tools.rows,
      lines: lines.rows,
      schedule: schedule.rows[0] ?? null,
      breakReasons: BREAK_REASONS,
      consent: await consentOf(ctx.userId),
    };
  });

  /** La persona acepta el aviso de qué se registra. Sin esta aceptación no se puede iniciar turno. */
  app.post('/api/argos/consent', guard(), async (req) => {
    const ctx = req.ctx;
    const body = parse(z.object({ version: z.string().max(20) }), req.body);
    if (body.version !== CONSENT_VERSION) throw badRequest('El aviso cambió. Vuelve a abrir la extensión para leer la versión actual.', 'aviso_desactualizado');
    if (ctx.support) throw forbidden();
    const { count } = await db.query(
      `INSERT INTO argos_consents (company_id, user_id, version, client, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, version) DO NOTHING`,
      [ctx.companyId, ctx.userId, CONSENT_VERSION, ctx.client, ctx.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    if (count) await auditBy(ctx, { action: 'consentimiento.aceptado', entityType: 'usuario', entityId: ctx.userId, summary: `Aceptó el aviso de registro de actividad (versión ${CONSENT_VERSION})`, metadata: { version: CONSENT_VERSION, client: ctx.client } });
    return { consent: await consentOf(ctx.userId) };
  });

  app.post('/api/argos/shifts/start', guard(), async (req) => {
    const ctx = req.ctx;
    const existing = await activeShiftOf(ctx.userId);
    if (existing) return { shift: shiftView(existing), alreadyActive: true };
    if (!(await consentOf(ctx.userId)).accepted) {
      throw new HttpError(403, 'consentimiento_requerido', 'Antes de iniciar turno debes leer y aceptar qué registra la extensión.');
    }
    const lines = await db.query(`SELECT id, label, channel FROM argos_lines WHERE assigned_user_id = $1 AND active ORDER BY label`, [ctx.userId]);
    try {
      const { rows } = await db.query(
        `INSERT INTO argos_shifts (company_id, user_id, team_id, lines) VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
        [ctx.companyId, ctx.userId, ctx.teamId, JSON.stringify(lines.rows)],
      );
      return { shift: shiftView(rows[0]), alreadyActive: false };
    } catch (err) {
      // Dos inicios simultáneos: el índice único garantiza un solo turno activo.
      const again = await activeShiftOf(ctx.userId);
      if (again) return { shift: shiftView(again), alreadyActive: true };
      throw err;
    }
  });

  app.post('/api/argos/shifts/:id/end', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const shift = await getShift(ctx, id);
    const own = shift.user_id === ctx.userId;
    if (!own) {
      if (ctx.role === 'seller') throw forbidden();
      await assertCanSeeUser(ctx, shift.user_id);
    }
    if (shift.status === 'ended') return { shift: shiftView(shift), summary: summaryFor(ctx, shift.user_id, shift.summary) };
    const summary = await closeShift(db, shift, new Date(), own ? 'usuario' : 'supervision', ctx.userId);
    if (!own) {
      const owner = (await db.query(`SELECT name FROM core_users WHERE id = $1`, [shift.user_id])).rows[0];
      await auditBy(ctx, { action: 'turno.cierre_supervision', entityType: 'turno', entityId: id, summary: `Cerró el turno de ${owner?.name ?? 'una persona'}` });
    }
    return { shift: shiftView(await getShift(ctx, id)), summary: summaryFor(ctx, shift.user_id, summary) };
  });

  app.post('/api/argos/shifts/:id/breaks', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: z.enum(BREAK_REASONS), note: z.string().trim().max(200).default('') }), req.body);
    const shift = await getShift(ctx, id);
    if (shift.user_id !== ctx.userId) throw forbidden();
    if (shift.status !== 'active') throw badRequest('El turno ya terminó.', 'turno_terminado');
    const open = await openBreakOf(id);
    if (open) return { openBreak: open };
    await db.query(`INSERT INTO argos_breaks (company_id, shift_id, user_id, reason, note) VALUES ($1, $2, $3, $4, $5)`, [ctx.companyId, id, ctx.userId, body.reason, body.note]);
    return { openBreak: await openBreakOf(id) };
  });

  app.post('/api/argos/shifts/:id/breaks/end', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const shift = await getShift(ctx, id);
    if (shift.user_id !== ctx.userId) throw forbidden();
    await db.query(`UPDATE argos_breaks SET ended_at = now() WHERE shift_id = $1 AND ended_at IS NULL`, [id]);
    return { openBreak: null };
  });

  /**
   * Sincronización de la extensión. Es idempotente: cada minuto se identifica por (turno, minuto, herramienta),
   * así que reenviar el mismo lote tras una desconexión no duplica nada.
   */
  app.post('/api/argos/shifts/:id/sync', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const body = parse(syncBody, req.body);
    const shift = await getShift(ctx, id);
    if (shift.user_id !== ctx.userId) throw forbidden();

    const now = Date.now();
    const lateLimit = 24 * 3600_000;
    if (shift.status === 'ended' && shift.ended_at && now - shift.ended_at.getTime() > lateLimit) {
      throw new HttpError(409, 'turno_cerrado', 'El turno terminó hace más de 24 horas; ya no admite datos.');
    }

    // Corrección del reloj del equipo: si difiere más de 90 s del servidor, se desplazan los minutos.
    const skew = now - new Date(body.sentAt).getTime();
    const shiftMs = Math.abs(skew) > 90_000 ? skew : 0;
    const from = floorMinute(shift.started_at);
    const to = shift.ended_at ? shift.ended_at.getTime() : now + 60_000;

    const validTools = new Set((await db.query<{ id: string }>(`SELECT id FROM argos_tools WHERE company_id = $1`, [ctx.companyId])).rows.map((t) => t.id));
    const presence = new Map<number, string>();
    const activity = new Map<string, { minute: string; tool: string; focus: number; active: number; keys: number; clicks: number; scrolls: number }>();
    for (const m of body.minutes) {
      const minute = floorMinute(new Date(m.minute).getTime() + shiftMs);
      if (minute < from || minute > to) continue;
      presence.set(minute, m.systemState);
      for (const t of m.tools) {
        if (!validTools.has(t.toolId)) continue;
        const key = `${minute}|${t.toolId}`;
        const a = activity.get(key) ?? { minute: new Date(minute).toISOString(), tool: t.toolId, focus: 0, active: 0, keys: 0, clicks: 0, scrolls: 0 };
        a.focus = Math.min(60, a.focus + t.focusSeconds);
        a.active = Math.min(60, a.active + t.activeSeconds);
        a.keys = Math.min(2000, a.keys + t.keys);
        a.clicks = Math.min(2000, a.clicks + t.clicks);
        a.scrolls = Math.min(600, a.scrolls + t.scrolls);
        activity.set(key, a);
      }
    }

    if (presence.size) {
      await db.query(
        `INSERT INTO argos_presence_minutes (shift_id, minute_start, company_id, user_id, system_state)
         SELECT $1::uuid, x.minute, $2::uuid, $3::uuid, x.state
           FROM jsonb_to_recordset($4::jsonb) AS x(minute timestamptz, state text)
         ON CONFLICT (shift_id, minute_start) DO NOTHING`,
        [id, ctx.companyId, ctx.userId, JSON.stringify([...presence].map(([minute, state]) => ({ minute: new Date(minute).toISOString(), state })))],
      );
    }
    if (activity.size) {
      await db.query(
        `INSERT INTO argos_activity_minutes (shift_id, minute_start, tool_id, company_id, user_id, focus_seconds, active_seconds, key_count, click_count, scroll_count)
         SELECT $1::uuid, x.minute, x.tool::uuid, $2::uuid, $3::uuid, x.focus, x.active, x.keys, x.clicks, x.scrolls
           FROM jsonb_to_recordset($4::jsonb) AS x(minute timestamptz, tool text, focus int, active int, keys int, clicks int, scrolls int)
         ON CONFLICT (shift_id, minute_start, tool_id) DO UPDATE SET
           focus_seconds  = GREATEST(argos_activity_minutes.focus_seconds, EXCLUDED.focus_seconds),
           active_seconds = GREATEST(argos_activity_minutes.active_seconds, EXCLUDED.active_seconds),
           key_count      = GREATEST(argos_activity_minutes.key_count, EXCLUDED.key_count),
           click_count    = GREATEST(argos_activity_minutes.click_count, EXCLUDED.click_count),
           scroll_count   = GREATEST(argos_activity_minutes.scroll_count, EXCLUDED.scroll_count)`,
        [id, ctx.companyId, ctx.userId, JSON.stringify([...activity.values()])],
      );
    }

    if (shift.status === 'active') {
      await db.query(`UPDATE argos_shifts SET last_sync_at = now() WHERE id = $1`, [id]);
    } else if (presence.size) {
      // Datos recuperados después del cierre (p. ej. tras una desconexión): se recalcula el resumen.
      const summary = await computeSummary(db, shift);
      await db.query(`UPDATE argos_shifts SET summary = $2::jsonb WHERE id = $1`, [id, JSON.stringify(summary)]);
    }

    return {
      serverTime: new Date(),
      accepted: presence.size,
      shift: { id, status: shift.status },
      openBreak: shift.status === 'active' ? await openBreakOf(id) : null,
    };
  });

  // ───────── Consulta de turnos ─────────
  app.get('/api/argos/shifts', guard(), async (req) => {
    const ctx = req.ctx;
    const q = parse(
      z.object({
        userId: z.uuid().optional(),
        status: z.enum(['active', 'ended']).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(300).default(100),
      }),
      req.query,
    );
    const params: unknown[] = [ctx.companyId];
    let where = '';
    const ids = await visibleUserIds(ctx);
    if (ids) {
      params.push(JSON.stringify(ids));
      where += ` AND s.user_id ${inIds(params.length)}`;
    }
    if (q.userId) {
      params.push(q.userId);
      where += ` AND s.user_id = $${params.length}`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND s.status = $${params.length}`;
    }
    if (q.from) {
      params.push(q.from);
      where += ` AND s.started_at >= $${params.length}::timestamptz`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND s.started_at <= $${params.length}::timestamptz`;
    }
    params.push(q.limit);
    const { rows } = await db.query(
      `SELECT s.id, s.user_id AS "userId", u.name AS "userName", s.status, s.started_at AS "startedAt", s.ended_at AS "endedAt",
              s.end_reason AS "endReason", s.last_sync_at AS "lastSyncAt", s.lines,
              s.summary->'durationMinutes' AS "durationMinutes", s.summary->'observedMinutes' AS "observedMinutes",
              s.summary->'noActivityMinutes' AS "noActivityMinutes", s.summary->'breakMinutes' AS "breakMinutes",
              s.summary->'noDataMinutes' AS "noDataMinutes", s.summary->'incidents' AS incidents
         FROM argos_shifts s JOIN core_users u ON u.id = s.user_id
        WHERE s.company_id = $1 ${where}
        ORDER BY s.started_at DESC LIMIT $${params.length}`,
      params,
    );
    return { shifts: rows };
  });

  app.get('/api/argos/shifts/:id', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const shift = await getShift(ctx, id);
    await assertCanSeeUser(ctx, shift.user_id);
    const owner = (await db.query(`SELECT name FROM core_users WHERE id = $1`, [shift.user_id])).rows[0];
    const summary = shift.status === 'ended' && shift.summary ? shift.summary : await computeSummary(db, shift);
    const incidents = await db.query(
      `SELECT id, type, description, status, created_at AS "createdAt", resolved_at AS "resolvedAt" FROM argos_incidents WHERE shift_id = $1 ORDER BY created_at`,
      [id],
    );
    return {
      incidents: incidents.rows,
      shift: { ...shiftView(shift), userId: shift.user_id, userName: owner?.name, endReason: shift.end_reason, lines: shift.lines },
      summary: summaryFor(ctx, shift.user_id, summary),
    };
  });

  /** Registros crudos por minuto: es exactamente todo lo que la extensión guardó de ese turno. */
  app.get('/api/argos/shifts/:id/minutes', guard(), async (req) => {
    const ctx = req.ctx;
    const { id } = parse(idParam, req.params);
    const shift = await getShift(ctx, id);
    await assertCanSeeUser(ctx, shift.user_id);
    const [presence, activity] = await Promise.all([
      db.query(`SELECT minute_start AS minute, system_state AS "systemState", received_at AS "receivedAt" FROM argos_presence_minutes WHERE shift_id = $1 ORDER BY minute_start`, [id]),
      db.query(
        `SELECT a.minute_start AS minute, t.name AS tool, a.focus_seconds AS "focusSeconds", a.active_seconds AS "activeSeconds",
                a.key_count AS "keyCount", a.click_count AS "clickCount", a.scroll_count AS "scrollCount"
           FROM argos_activity_minutes a JOIN argos_tools t ON t.id = a.tool_id WHERE a.shift_id = $1 ORDER BY a.minute_start`,
        [id],
      ),
    ]);
    const hideCounts = ctx.role === 'supervisor' && shift.user_id !== ctx.userId;
    const rows = hideCounts ? activity.rows.map(({ keyCount: _k, clickCount: _c, scrollCount: _s, ...row }) => row) : activity.rows;
    return { shiftId: id, presence: presence.rows, activity: rows };
  });
}
