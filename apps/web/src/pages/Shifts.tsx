import { useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { END_REASON, fmtDateTime, fmtMinutes, fmtTime, scheduleText } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHead } from '../components/ui';
import { ScheduleFields, toScheduleValue } from '../components/ScheduleFields';
import type { ScheduleValue } from '../components/ScheduleFields';
import { ShiftDetailModal } from '../components/ShiftDetail';

interface User { id: string; name: string; role: string; status: string; teamName: string | null }
interface Schedule { userId: string; weekdays: number[]; startTime: string; endTime: string }

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function Shifts() {
  const [tab, setTab] = useState<'historial' | 'programacion'>('historial');
  return (
    <>
      <PageHead title="Turnos" subtitle="Turnos realizados con su resumen y la programación semanal de cada persona." />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'historial'} onClick={() => setTab('historial')}>Historial</button>
        <button role="tab" aria-selected={tab === 'programacion'} onClick={() => setTab('programacion')}>Programación</button>
      </div>
      {tab === 'historial' ? <History /> : <Planning />}
    </>
  );
}

function History() {
  const users = useApi<{ users: User[] }>('/api/users');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 6 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const path = useMemo(() => {
    const q = new URLSearchParams({ from: dayStart(from), to: dayEnd(to) });
    if (userId) q.set('userId', userId);
    return `/api/argos/shifts?${q}`;
  }, [userId, from, to]);
  const shifts = useApi(path);

  return (
    <>
      <div className="card card-pad row">
        <div className="grow">
          <Field label="Persona">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todas</option>
              {(users.data?.users ?? []).filter((u) => u.role === 'seller').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow"><Field label="Desde"><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Hasta"><input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field></div>
      </div>
      <div className="card">
        <ErrorNote error={shifts.error} />
        {!shifts.data ? <Loading /> : shifts.data.shifts.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Persona</th><th>Inicio</th><th>Fin</th><th>Duración</th><th>Con actividad</th><th>Sin actividad</th><th>Pausas</th><th>Sin datos</th><th>Novedades</th><th></th></tr></thead>
              <tbody>
                {shifts.data.shifts.map((s: { id: string; userName: string; status: string; startedAt: string; endedAt: string | null; endReason: string | null; durationMinutes: number | null; observedMinutes: number | null; noActivityMinutes: number | null; breakMinutes: number | null; noDataMinutes: number | null; incidents: number | null }) => (
                  <tr key={s.id}>
                    <td><strong>{s.userName}</strong></td>
                    <td className="nowrap">{fmtDateTime(s.startedAt)}</td>
                    <td className="nowrap">
                      {s.status === 'active' ? <Badge tone="info">En curso</Badge> : fmtTime(s.endedAt)}
                      {s.endReason && s.endReason !== 'usuario' && <span className="sub">{END_REASON[s.endReason]}</span>}
                    </td>
                    <td>{fmtMinutes(s.durationMinutes)}</td>
                    <td>{fmtMinutes(s.observedMinutes)}</td>
                    <td>{fmtMinutes(s.noActivityMinutes)}</td>
                    <td>{fmtMinutes(s.breakMinutes)}</td>
                    <td>{fmtMinutes(s.noDataMinutes)}</td>
                    <td>{s.incidents ?? '—'}</td>
                    <td><button className="btn sm" onClick={() => setOpen(s.id)}>Ver</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay turnos en el periodo elegido.</Empty>
        )}
      </div>
      {open && <ShiftDetailModal shiftId={open} onClose={() => setOpen(null)} onChanged={() => void shifts.reload()} />}
    </>
  );
}

function Planning() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const users = useApi<{ users: User[] }>('/api/users');
  const schedules = useApi<{ schedules: Schedule[] }>('/api/argos/schedules');
  const [editing, setEditing] = useState<User | null>(null);
  if (!users.data || !schedules.data) return <Loading />;
  const sellers = users.data.users.filter((u) => u.role === 'seller' && u.status === 'active');
  const of = (id: string) => schedules.data!.schedules.find((s) => s.userId === id);
  return (
    <>
      <div className="card">
        {sellers.length ? (
          <table>
            <thead><tr><th>Persona</th><th>Equipo</th><th>Turno programado</th><th></th></tr></thead>
            <tbody>
              {sellers.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong></td>
                  <td>{u.teamName ?? '—'}</td>
                  <td>{of(u.id) ? scheduleText(of(u.id)) : <span className="muted">Sin programar</span>}</td>
                  <td>{isAdmin && <button className="btn sm" onClick={() => setEditing(u)}>Programar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No hay vendedoras activas.</Empty>
        )}
      </div>
      {editing && (
        <PlanModal
          user={editing}
          schedule={of(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await schedules.reload();
          }}
        />
      )}
    </>
  );
}

function PlanModal({ user, schedule, onClose, onSaved }: { user: User; schedule?: Schedule; onClose: () => void; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState<ScheduleValue>(schedule ? toScheduleValue(schedule) : { ...toScheduleValue(null), enabled: true });
  async function save() {
    if (value.enabled) {
      if (!value.weekdays.length) throw new Error('Elige al menos un día.');
      await api('PUT', `/api/argos/schedules/${user.id}`, { weekdays: value.weekdays, startTime: value.startTime, endTime: value.endTime });
    } else if (schedule) await api('DELETE', `/api/argos/schedules/${user.id}`);
    await onSaved();
  }
  return (
    <FormModal title={`Turno de ${user.name}`} onClose={onClose} onSubmit={save}>
      <ScheduleFields value={value} onChange={setValue} />
      <p className="small muted">La programación sirve para avisar cuando alguien no ha iniciado su turno a la hora prevista. No inicia ni cierra turnos por sí sola.</p>
    </FormModal>
  );
}
