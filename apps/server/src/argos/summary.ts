import type { Queryable } from '../db/db.ts';

export type MinuteState = 'observada' | 'sin_actividad' | 'pausa' | 'sin_datos';

export interface ShiftRow {
  id: string;
  company_id: string;
  user_id: string;
  status: 'active' | 'ended';
  started_at: Date;
  ended_at: Date | null;
  last_sync_at: Date | null;
}

export interface ShiftSummary {
  computedAt: string;
  /** true mientras el turno sigue abierto: las cifras son parciales. */
  live: boolean;
  durationMinutes: number;
  /** Minutos con al menos un evento de entrada en una herramienta autorizada. */
  observedMinutes: number;
  /** Minutos con la extensión conectada pero sin eventos de entrada. No implica ausencia de trabajo. */
  noActivityMinutes: number;
  breakMinutes: number;
  /** Minutos sin ningún dato: navegador cerrado, equipo suspendido o datos aún no sincronizados. */
  noDataMinutes: number;
  /** Minutos que llegaron con más de 5 minutos de retraso (hubo falta de conexión y se recuperaron). */
  lateSyncMinutes: number;
  /** Minutos en los que el sistema operativo informó pantalla bloqueada. */
  lockedMinutes: number;
  keyCount: number;
  clickCount: number;
  scrollCount: number;
  tools: { toolId: string; name: string; focusSeconds: number; activeSeconds: number; keyCount: number; clickCount: number }[];
  breaks: { reason: string; startedAt: string; endedAt: string | null; minutes: number }[];
  incidents: number;
  timeline: { start: string; end: string; state: MinuteState }[];
}

const MIN = 60_000;
export const floorMinute = (d: Date | number): number => Math.floor(new Date(d).getTime() / MIN) * MIN;

/** Los minutos más recientes de un turno abierto aún no han podido sincronizarse: no se clasifican. */
const LIVE_LAG_MS = 1 * MIN;
const LATE_MS = 5 * MIN;

export async function computeSummary(q: Queryable, shift: ShiftRow, now = new Date()): Promise<ShiftSummary> {
  const live = shift.status === 'active';
  const start = floorMinute(shift.started_at);
  const hardEnd = shift.ended_at ? shift.ended_at.getTime() : now.getTime();
  const end = live ? Math.max(start, floorMinute(now.getTime() - LIVE_LAG_MS)) : hardEnd;

  const [presence, activity, breaks, tools, incidents] = await Promise.all([
    q.query<{ minute_start: Date; system_state: string; received_at: Date }>(
      `SELECT minute_start, system_state, received_at FROM argos_presence_minutes WHERE shift_id = $1`, [shift.id]),
    q.query<{ minute_start: Date; tool_id: string; focus_seconds: number; active_seconds: number; key_count: number; click_count: number; scroll_count: number }>(
      `SELECT minute_start, tool_id, focus_seconds, active_seconds, key_count, click_count, scroll_count FROM argos_activity_minutes WHERE shift_id = $1`, [shift.id]),
    q.query<{ reason: string; started_at: Date; ended_at: Date | null }>(
      `SELECT reason, started_at, ended_at FROM argos_breaks WHERE shift_id = $1 ORDER BY started_at`, [shift.id]),
    q.query<{ id: string; name: string }>(`SELECT id, name FROM argos_tools WHERE company_id = $1`, [shift.company_id]),
    q.query<{ n: number }>(`SELECT count(*)::int AS n FROM argos_incidents WHERE shift_id = $1`, [shift.id]),
  ]);

  const present = new Map<number, { state: string; late: boolean }>();
  for (const p of presence.rows) {
    const m = p.minute_start.getTime();
    present.set(m, { state: p.system_state, late: p.received_at.getTime() - m > LATE_MS });
  }

  const activeByMinute = new Map<number, number>();
  const toolNames = new Map(tools.rows.map((t) => [t.id, t.name]));
  const perTool = new Map<string, ShiftSummary['tools'][number]>();
  let keyCount = 0, clickCount = 0, scrollCount = 0;
  for (const a of activity.rows) {
    const m = a.minute_start.getTime();
    activeByMinute.set(m, (activeByMinute.get(m) ?? 0) + a.active_seconds);
    keyCount += a.key_count;
    clickCount += a.click_count;
    scrollCount += a.scroll_count;
    const t = perTool.get(a.tool_id) ?? { toolId: a.tool_id, name: toolNames.get(a.tool_id) ?? 'Herramienta', focusSeconds: 0, activeSeconds: 0, keyCount: 0, clickCount: 0 };
    t.focusSeconds += a.focus_seconds;
    t.activeSeconds += a.active_seconds;
    t.keyCount += a.key_count;
    t.clickCount += a.click_count;
    perTool.set(a.tool_id, t);
  }

  const breakRanges = breaks.rows.map((b) => ({ from: b.started_at.getTime(), to: b.ended_at ? b.ended_at.getTime() : hardEnd }));
  const counts: Record<MinuteState, number> = { observada: 0, sin_actividad: 0, pausa: 0, sin_datos: 0 };
  const timeline: ShiftSummary['timeline'] = [];
  let lateSyncMinutes = 0, lockedMinutes = 0;

  for (let m = start; m < end; m += MIN) {
    const mid = m + MIN / 2;
    const p = present.get(m);
    let state: MinuteState;
    if (breakRanges.some((b) => b.from <= mid && mid < b.to)) state = 'pausa';
    else if ((activeByMinute.get(m) ?? 0) > 0) state = 'observada';
    else if (p) state = 'sin_actividad';
    else state = 'sin_datos';
    if (p?.late) lateSyncMinutes++;
    if (p?.state === 'locked' && state !== 'pausa') lockedMinutes++;
    counts[state]++;
    const last = timeline[timeline.length - 1];
    const endIso = new Date(Math.min(m + MIN, Math.max(end, m + 1))).toISOString();
    if (last && last.state === state) last.end = endIso;
    else timeline.push({ start: new Date(m).toISOString(), end: endIso, state });
  }

  return {
    computedAt: now.toISOString(),
    live,
    durationMinutes: Math.max(0, Math.round((hardEnd - shift.started_at.getTime()) / MIN)),
    observedMinutes: counts.observada,
    noActivityMinutes: counts.sin_actividad,
    breakMinutes: counts.pausa,
    noDataMinutes: counts.sin_datos,
    lateSyncMinutes,
    lockedMinutes,
    keyCount,
    clickCount,
    scrollCount,
    tools: [...perTool.values()].sort((a, b) => b.focusSeconds - a.focusSeconds),
    breaks: breaks.rows.map((b) => ({
      reason: b.reason,
      startedAt: b.started_at.toISOString(),
      endedAt: b.ended_at ? b.ended_at.toISOString() : null,
      minutes: Math.max(0, Math.round(((b.ended_at ? b.ended_at.getTime() : hardEnd) - b.started_at.getTime()) / MIN)),
    })),
    incidents: incidents.rows[0]?.n ?? 0,
    timeline,
  };
}

/** Cierra el turno, cierra la pausa abierta si la hay y guarda el resumen definitivo. */
export async function closeShift(q: Queryable, shift: ShiftRow, endedAt: Date, reason: 'usuario' | 'supervision' | 'automatico', endedBy: string | null): Promise<ShiftSummary> {
  const at = new Date(Math.max(endedAt.getTime(), shift.started_at.getTime()));
  await q.query(`UPDATE argos_breaks SET ended_at = $2::timestamptz WHERE shift_id = $1 AND ended_at IS NULL`, [shift.id, at.toISOString()]);
  await q.query(`UPDATE argos_shifts SET status = 'ended', ended_at = $2::timestamptz, end_reason = $3, ended_by = $4 WHERE id = $1 AND status = 'active'`, [
    shift.id, at.toISOString(), reason, endedBy,
  ]);
  const summary = await computeSummary(q, { ...shift, status: 'ended', ended_at: at });
  await q.query(`UPDATE argos_shifts SET summary = $2::jsonb WHERE id = $1`, [shift.id, JSON.stringify(summary)]);
  return summary;
}
