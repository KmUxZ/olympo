import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { api, useApi, useNow } from '../lib/api';
import { MyWeek } from './Roster';
import { ago, BREAK_LABEL, fmtDateTime, fmtMinutes, fmtTime, scheduleText } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHead } from '../components/ui';
import { ShiftDetailModal, ShiftSummaryView } from '../components/ShiftDetail';
import { IncidentForm } from '../components/IncidentForm';

export function MyShift() {
  const { me } = useAuth();
  const state = useApi('/api/argos/me/state', 15_000);
  const history = useApi(`/api/argos/shifts?status=ended&limit=15&userId=${me?.user.id}`);
  const now = useNow(5000);
  const [pausing, setPausing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!state.data) return state.error ? <ErrorNote error={state.error} /> : <Loading />;
  const { shift, openBreak, lines, schedule, tools } = state.data;

  async function resume() {
    setError(null);
    try {
      await api('POST', `/api/argos/shifts/${shift.id}/breaks/end`);
      await state.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHead title="Mi turno" subtitle="Tu turno, tus pausas y todo lo que se registra de tu actividad.">
        <Freshness updatedAt={state.updatedAt} error={state.error} />
      </PageHead>
      <ErrorNote error={error} />
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <div className="card card-pad stack hero-card">
        <div className="row">
          <div className="grow">
            {shift ? (
              <>
                <div className="big-timer" aria-label="Tiempo en turno">{elapsed(shift.startedAt, now)}</div>
                <h2>{openBreak ? `En pausa · ${BREAK_LABEL[openBreak.reason] ?? openBreak.reason}` : 'Turno en curso'}</h2>
                <p className="small muted">
                  Iniciado a las {fmtTime(shift.startedAt)} · {openBreak ? `en pausa desde las ${fmtTime(openBreak.startedAt)}` : `última sincronización de la extensión ${shift.lastSyncAt ? ago(shift.lastSyncAt, now) : 'pendiente'}`}
                </p>
              </>
            ) : (
              <>
                <h2>Sin turno activo</h2>
                <p className="small muted">El turno se inicia y finaliza desde la extensión Argos de Chrome. Fuera de turno no se registra nada.</p>
              </>
            )}
          </div>
          {shift ? (openBreak ? <Badge tone="warn">En pausa</Badge> : <Badge tone="ok">En turno</Badge>) : <Badge tone="plain">Fuera de turno</Badge>}
        </div>
        <div className="small">
          <span className="muted">Línea: </span>{lines.length ? lines.map((l: { label: string }) => l.label).join(', ') : 'sin asignar'}
          <span className="muted"> · Turno programado: </span>{scheduleText(schedule)}
          <span className="muted"> · Herramientas autorizadas: </span>{tools.length ? tools.map((t: { name: string }) => t.name).join(', ') : 'ninguna'}
        </div>
        <div className="actions">
          {shift && (openBreak
            ? <button className="btn primary" onClick={() => void resume()}>Reanudar</button>
            : <button className="btn" onClick={() => setPausing(true)}>Iniciar pausa</button>)}
          <button className="btn" onClick={() => setReporting(true)}>Reportar novedad</button>
          <Link to="/que-se-registra" className="small">¿Qué se registra?</Link>
        </div>
      </div>

      {me?.user.role === 'seller' && <MyWeek />}

      {shift && (
        <div className="card card-pad">
          <ShiftSummaryView shiftId={shift.id} refreshMs={30_000} />
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Mis turnos anteriores</h2></div>
        {!history.data ? <Loading /> : history.data.shifts.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Inicio</th><th>Fin</th><th>Duración</th><th>Con actividad observada</th><th>Pausas</th><th></th></tr></thead>
              <tbody>
                {history.data.shifts.map((s: { id: string; startedAt: string; endedAt: string; durationMinutes: number; observedMinutes: number; breakMinutes: number }) => (
                  <tr key={s.id}>
                    <td>{fmtDateTime(s.startedAt)}</td><td>{fmtTime(s.endedAt)}</td><td>{fmtMinutes(s.durationMinutes)}</td>
                    <td>{fmtMinutes(s.observedMinutes)}</td><td>{fmtMinutes(s.breakMinutes)}</td>
                    <td><button className="btn sm" onClick={() => setOpen(s.id)}>Ver</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Aún no tienes turnos finalizados.</Empty>
        )}
      </div>

      {pausing && shift && (
        <PauseModal
          shiftId={shift.id}
          reasons={state.data.breakReasons}
          onClose={() => setPausing(false)}
          onSaved={async () => {
            setPausing(false);
            await state.reload();
          }}
        />
      )}
      {reporting && (
        <IncidentForm
          onClose={() => setReporting(false)}
          onSaved={() => {
            setReporting(false);
            setNotice('Novedad registrada. Tu supervisor ya puede verla.');
          }}
        />
      )}
      {open && <ShiftDetailModal shiftId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Tiempo transcurrido como h:mm. */
function elapsed(since: string, now: number): string {
  const m = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
}

function PauseModal({ shiftId, reasons, onClose, onSaved }: { shiftId: string; reasons: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState(reasons[0] ?? 'descanso');
  async function save() {
    await api('POST', `/api/argos/shifts/${shiftId}/breaks`, { reason });
    await onSaved();
  }
  return (
    <FormModal title="Iniciar pausa" submitLabel="Iniciar pausa" onClose={onClose} onSubmit={save}>
      <Field label="Motivo" hint="Durante la pausa no se registra actividad. La extensión se actualiza en menos de un minuto.">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => <option key={r} value={r}>{BREAK_LABEL[r] ?? r}</option>)}
        </select>
      </Field>
    </FormModal>
  );
}
