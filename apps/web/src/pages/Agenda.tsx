import { useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { AGENDA_KIND, fmtLongDay, fmtTime, isoDay } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHead } from '../components/ui';

interface Item { id: string; title: string; notes: string; kind: string; startsAt: string; endsAt: string | null; status: string; userId: string | null; userName: string | null; teamId: string | null; teamName: string | null; createdBy: string; createdByName: string }

export function Agenda() {
  const { me } = useAuth();
  const role = me!.user.role;
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una semana atrás (para ver lo atrasado) y un mes adelante.
  const path = useMemo(() => {
    const now = Date.now();
    return `/api/argos/agenda?${new URLSearchParams({ from: new Date(now - 7 * 86400_000).toISOString(), to: new Date(now + 30 * 86400_000).toISOString() })}`;
  }, []);
  const list = useApi<{ items: Item[] }>(path, 60_000);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const setStatus = (item: Item, status: string) => act(() => api('PATCH', `/api/argos/agenda/${item.id}`, { status }));
  const remove = (item: Item) => window.confirm(`¿Eliminar «${item.title}»?`) && act(() => api('DELETE', `/api/argos/agenda/${item.id}`));

  const today = isoDay(new Date());
  const items = (list.data?.items ?? []).filter((i) => showDone || i.status === 'pendiente');
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const day = isoDay(new Date(item.startsAt));
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }

  return (
    <>
      <PageHead title="Agenda" subtitle="Tareas, reuniones, compromisos y actividades programadas.">
        <label className="checks small"><span><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Mostrar hechas y canceladas</span></label>
        <button className="btn primary" onClick={() => setCreating(true)}>Nuevo</button>
      </PageHead>
      <ErrorNote error={error ?? list.error} />

      {!list.data ? <Loading /> : groups.size ? (
        [...groups.entries()].map(([day, dayItems]) => (
          <div className="card" key={day}>
            <div className="card-head">
              <h2>{fmtLongDay(`${day}T12:00:00`)}</h2>
              {day === today ? <Badge tone="info">Hoy</Badge> : day < today ? <Badge tone="danger">Atrasado</Badge> : null}
            </div>
            <table>
              <tbody>
                {dayItems.map((i) => (
                  <tr key={i.id} style={i.status !== 'pendiente' ? { opacity: 0.6 } : undefined}>
                    <td className="nowrap" style={{ width: 90 }}>{fmtTime(i.startsAt)}{i.endsAt && <span className="sub">a {fmtTime(i.endsAt)}</span>}</td>
                    <td>
                      <strong>{i.title}</strong> <Badge tone="plain">{AGENDA_KIND[i.kind] ?? i.kind}</Badge>
                      {i.notes && <span className="sub">{i.notes}</span>}
                      <span className="sub">
                        Para: {i.userName ?? (i.teamName ? `equipo ${i.teamName}` : 'toda la empresa')}
                        {i.createdBy !== i.userId && ` · Programó: ${i.createdByName}`}
                      </span>
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      {i.status === 'pendiente' ? (
                        <>
                          <button className="btn sm" onClick={() => void setStatus(i, 'hecha')}>Marcar hecha</button>{' '}
                          <button className="btn sm" onClick={() => void setStatus(i, 'cancelada')}>Cancelar</button>
                        </>
                      ) : (
                        <>
                          <Badge tone={i.status === 'hecha' ? 'ok' : ''}>{i.status === 'hecha' ? 'Hecha' : 'Cancelada'}</Badge>{' '}
                          <button className="btn sm" onClick={() => void setStatus(i, 'pendiente')}>Reabrir</button>
                        </>
                      )}
                      {(i.createdBy === me!.user.id || role === 'admin') && <>{' '}<button className="btn sm danger" onClick={() => void remove(i)}>Eliminar</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      ) : (
        <div className="card"><Empty>No hay nada pendiente en la agenda. Usa «Nuevo» para programar una tarea, reunión o compromiso.</Empty></div>
      )}

      {creating && (
        <CreateModal
          role={role}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await list.reload();
          }}
        />
      )}
    </>
  );
}

function CreateModal({ role, onClose, onSaved }: { role: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const canAssign = role !== 'seller';
  const users = useApi<{ users: { id: string; name: string; status: string }[] }>(canAssign ? '/api/users' : null);
  const teams = useApi<{ teams: { id: string; name: string }[] }>(canAssign ? '/api/teams' : null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('tarea');
  const [day, setDay] = useState(isoDay(new Date()));
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('');
  const [target, setTarget] = useState(''); // "u:<id>" | "t:<id>" | "all"
  const [notes, setNotes] = useState('');

  async function save() {
    if (canAssign && !target) throw new Error('Elige para quién es.');
    await api('POST', '/api/argos/agenda', {
      title, notes, kind,
      startsAt: new Date(`${day}T${start}:00`).toISOString(),
      endsAt: end ? new Date(`${day}T${end}:00`).toISOString() : null,
      userId: target.startsWith('u:') ? target.slice(2) : null,
      teamId: target.startsWith('t:') ? target.slice(2) : null,
    });
    await onSaved();
  }

  return (
    <FormModal title="Nuevo en la agenda" submitLabel="Programar" onClose={onClose} onSubmit={save}>
      <Field label="Título"><input required minLength={2} maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="row">
        <div className="grow">
          <Field label="Tipo">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(AGENDA_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        {canAssign && (
          <div className="grow">
            <Field label="Para">
              <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Elige…</option>
                {role === 'admin' && <option value="all">Toda la empresa</option>}
                <optgroup label="Equipos">{(teams.data?.teams ?? []).map((t) => <option key={t.id} value={`t:${t.id}`}>Equipo {t.name}</option>)}</optgroup>
                <optgroup label="Personas">{(users.data?.users ?? []).filter((u) => u.status === 'active').map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}</optgroup>
              </select>
            </Field>
          </div>
        )}
      </div>
      <div className="row">
        <div className="grow"><Field label="Día"><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Hora"><input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Hasta (opcional)"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field></div>
      </div>
      <Field label="Notas (opcional)"><textarea maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormModal>
  );
}
