import { resolveSettings } from '../config.ts';
import { db } from '../db/db.ts';
import { audit } from '../core/http.ts';
import { closeShift } from './summary.ts';
import { syncAll } from './pancake.ts';

/** Cierra turnos que quedaron abiertos sin señal (p. ej. se apagó el equipo sin finalizar el turno). */
export async function autoCloseStaleShifts(): Promise<number> {
  const { rows } = await db.query(
    `SELECT s.*, c.settings FROM argos_shifts s JOIN core_companies c ON c.id = s.company_id WHERE s.status = 'active'`,
  );
  let closed = 0;
  for (const shift of rows) {
    const { autoCloseHours } = resolveSettings(shift.settings);
    const lastSeen: Date = shift.last_sync_at ?? shift.started_at;
    if (Date.now() - lastSeen.getTime() < autoCloseHours * 3600_000) continue;
    // El turno se da por terminado en el último momento del que hay datos, no en la hora del cierre automático.
    await closeShift(db, shift, lastSeen, 'automatico', null);
    await audit(db, {
      companyId: shift.company_id, actorName: 'Sistema', action: 'turno.cierre_automatico', entityType: 'turno', entityId: shift.id,
      summary: `Turno cerrado automáticamente tras ${autoCloseHours} h sin señal`,
    });
    closed++;
  }
  return closed;
}

/**
 * Conservación de datos: elimina los registros por minuto más antiguos que el plazo de cada empresa.
 * Los resúmenes de turno (agregados) se conservan.
 */
export async function purgeOldActivity(): Promise<void> {
  const { rows } = await db.query(`SELECT id, settings FROM core_companies`);
  for (const company of rows) {
    const { retentionDays } = resolveSettings(company.settings);
    const args = [company.id, String(retentionDays)];
    const a = await db.query(`DELETE FROM argos_activity_minutes WHERE company_id = $1 AND minute_start < now() - ($2 || ' days')::interval`, args);
    const p = await db.query(`DELETE FROM argos_presence_minutes WHERE company_id = $1 AND minute_start < now() - ($2 || ' days')::interval`, args);
    await db.query(`DELETE FROM core_sessions WHERE company_id = $1 AND (expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days')`, [company.id]);
    if (a.count + p.count > 0) {
      await audit(db, {
        companyId: company.id, actorName: 'Sistema', action: 'datos.depuracion', entityType: 'empresa', entityId: company.id,
        summary: `Depuración automática: ${a.count + p.count} registros de actividad con más de ${retentionDays} días`,
        metadata: { actividad: a.count, presencia: p.count, retentionDays },
      });
    }
  }
}

export function startJobs(log: { error: (o: unknown, msg?: string) => void }): () => void {
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((err) => log.error(err, `tarea ${name} falló`));
  const timers = [
    setInterval(safe('cierre automático', autoCloseStaleShifts), 5 * 60_000),
    setInterval(safe('depuración', purgeOldActivity), 6 * 3600_000),
    setInterval(safe('sincronización Pancake', () => syncAll()), 5 * 60_000),
  ];
  setTimeout(safe('cierre automático', autoCloseStaleShifts), 5_000);
  setTimeout(safe('depuración', purgeOldActivity), 15_000);
  setTimeout(safe('sincronización Pancake', () => syncAll()), 20_000);
  return () => timers.forEach(clearInterval);
}
