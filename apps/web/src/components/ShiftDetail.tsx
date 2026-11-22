import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { BREAK_LABEL, connectedPct, INCIDENT_LABEL, download, END_REASON, fmtDateTime, fmtMinutes, fmtTime } from '../lib/format';
import { Badge, ErrorNote, Loading, Modal } from './ui';
import { TeamTimeline } from './charts';

/** Resumen de un turno. Si el turno sigue abierto, las cifras son parciales y se indica. */
export function ShiftSummaryView({ shiftId, refreshMs = 0, onChanged }: { shiftId: string; refreshMs?: number; onChanged?: () => void }) {
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi(`/api/argos/shifts/${shiftId}`, refreshMs);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const { shift, summary } = data;
  const classified = summary.observedMinutes + summary.noActivityMinutes + summary.breakMinutes + summary.noDataMinutes;
  const connected = connectedPct(classified, summary.noDataMinutes);
  const canClose = shift.status === 'active' && me && me.user.role !== 'seller' && shift.userId !== me.user.id;

  async function closeShift() {
    if (!window.confirm(`¿Cerrar el turno de ${shift.userName}? Quedará registrado en auditoría.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api('POST', `/api/argos/shifts/${shiftId}/end`);
      await reload();
      onChanged?.();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportRaw() {
    download(`turno-${shiftId}.json`, await api('GET', `/api/argos/shifts/${shiftId}/minutes`));
  }

  return (
    <div className="stack">
      <ErrorNote error={actionError} />
      <div className="row">
        <div className="grow">
          <strong>{shift.userName}</strong>
          <div className="small muted">
            {fmtDateTime(shift.startedAt)} → {shift.endedAt ? fmtTime(shift.endedAt) : 'en curso'}
            {shift.endReason ? ` · ${END_REASON[shift.endReason] ?? shift.endReason}` : ''}
          </div>
          {shift.lines?.length > 0 && <div className="small muted">Línea: {shift.lines.map((l: { label: string }) => l.label).join(', ')}</div>}
        </div>
        {summary.live ? <Badge tone="info">Turno en curso · cifras parciales</Badge> : <Badge tone="plain">Turno cerrado</Badge>}
      </div>

      <div className="stats">
        <div className="card stat"><b>{fmtMinutes(summary.durationMinutes)}</b><span>Duración</span></div>
        <div className="card stat"><b>{connected === null ? '—' : `${connected}%`}</b><span>Del turno conectada</span></div>
        <div className="card stat"><b>{fmtMinutes(summary.observedMinutes)}</b><span>Con actividad observada</span></div>
        <div className="card stat"><b>{fmtMinutes(summary.noActivityMinutes)}</b><span>Sin actividad observada</span></div>
        <div className="card stat"><b>{fmtMinutes(summary.breakMinutes)}</b><span>En pausa</span></div>
        <div className="card stat"><b>{fmtMinutes(summary.noDataMinutes)}</b><span>Sin datos</span></div>
        <div className="card stat"><b>{summary.incidents}</b><span>Novedades</span></div>
      </div>

      <TeamTimeline
        single
        showNow={summary.live}
        now={Date.now()}
        rows={[{
          key: shiftId, name: shift.userName, note: '', segments: summary.timeline,
          markers: (data.incidents ?? []).map((i: { createdAt: string; type: string; description: string }) => ({ at: i.createdAt, label: `Novedad · ${INCIDENT_LABEL[i.type] ?? i.type}: ${i.description}` })),
        }]}
      />
      {data.incidents?.length > 0 && (
        <p className="small muted">Los rombos rojos marcan las novedades reportadas durante el turno ({data.incidents.length}). Sirven para entender los tramos sin actividad o sin datos.</p>
      )}

      <div className="alert info">
        «Sin actividad observada» indica que no hubo teclado ni ratón en las herramientas autorizadas; no equivale a no trabajar.
        «Sin datos» indica que la extensión no reportó (navegador cerrado, equipo suspendido o sin conexión).
        {summary.lateSyncMinutes > 0 && ` ${summary.lateSyncMinutes} min llegaron con retraso por falta de conexión y se recuperaron.`}
        {summary.lockedMinutes > 0 && ` Pantalla bloqueada durante ${summary.lockedMinutes} min.`}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>Uso por herramienta</h3></div>
          {summary.tools.length ? (
            <table>
              <thead><tr><th>Herramienta</th><th>En uso</th>{!summary.countsHidden && <><th>Teclas (n.º)</th><th>Clics (n.º)</th></>}</tr></thead>
              <tbody>
                {summary.tools.map((t: { toolId: string; name: string; focusSeconds: number; keyCount?: number; clickCount?: number }) => (
                  <tr key={t.toolId}><td>{t.name}</td><td>{fmtMinutes(t.focusSeconds / 60)}</td>{!summary.countsHidden && <><td>{t.keyCount}</td><td>{t.clickCount}</td></>}</tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">Sin actividad registrada en herramientas.</div>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h3>Pausas</h3></div>
          {summary.breaks.length ? (
            <table>
              <thead><tr><th>Motivo</th><th>Inicio</th><th>Duración</th></tr></thead>
              <tbody>
                {summary.breaks.map((b: { reason: string; startedAt: string; endedAt: string | null; minutes: number }, i: number) => (
                  <tr key={i}><td>{BREAK_LABEL[b.reason] ?? b.reason}</td><td>{fmtTime(b.startedAt)}</td><td>{b.endedAt ? fmtMinutes(b.minutes) : 'En curso'}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">Sin pausas.</div>
          )}
        </div>
      </div>

      <div className="actions">
        <button className="btn sm" onClick={() => void exportRaw()}>Descargar registros por minuto (JSON)</button>
        {canClose && <button className="btn sm danger" disabled={busy} onClick={() => void closeShift()}>Cerrar turno</button>}
      </div>
    </div>
  );
}

export function ShiftDetailModal({ shiftId, onClose, onChanged }: { shiftId: string; onClose: () => void; onChanged?: () => void }) {
  return (
    <Modal title="Detalle del turno" onClose={onClose} wide>
      <div className="modal-body">
        <ShiftSummaryView shiftId={shiftId} onChanged={onChanged} />
      </div>
    </Modal>
  );
}
