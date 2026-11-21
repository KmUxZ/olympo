import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { COMMITMENT_STATUS, fmtDate, isoDay } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHero } from '../components/ui';

interface Commitment { id: string; text: string; dueDate: string | null; status: string }
interface Session { id: string; userId: string; userName: string; coachName: string; heldAt: string; topic: string; notes: string; commitments: Commitment[] }

export function Coaching() {
  const { me } = useAuth();
  const canManage = me!.user.role !== 'seller';
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>(canManage ? '/api/users' : null);
  const [userId, setUserId] = useState('');
  const list = useApi<{ sessions: Session[] }>(`/api/argos/coaching${userId ? `?userId=${userId}` : ''}`);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sellers = (users.data?.users ?? []).filter((u) => u.role === 'seller' && u.status === 'active');

  const allSessions = list.data?.sessions ?? [];
  const allCommitments = allSessions.flatMap((s) => s.commitments);

  async function setStatus(c: Commitment, status: string) {
    setError(null);
    try {
      await api('PATCH', `/api/argos/coaching/commitments/${c.id}`, { status });
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero kpis={[{ label: 'Sesiones', value: allSessions.length }, { label: 'Compromisos pendientes', value: allCommitments.filter((c) => c.status === 'pendiente').length }, { label: 'Cumplidos', value: allCommitments.length ? `${Math.round((allCommitments.filter((c) => c.status === 'cumplido').length / allCommitments.length) * 100)} %` : '—' }]} title="Acompañamiento" subtitle={canManage ? 'Sesiones de seguimiento con cada persona, sus compromisos y planes de mejora.' : 'Tus sesiones de seguimiento y los compromisos acordados.'}>
        {canManage && (
          <>
            <select aria-label="Filtrar por persona" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 220 }}>
              <option value="">Todas las personas</option>
              {sellers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="btn primary" onClick={() => setCreating(true)}>Registrar sesión</button>
          </>
        )}
      </PageHero>
      <ErrorNote error={error ?? list.error} />

      {!list.data ? <Loading /> : list.data.sessions.length ? (
        list.data.sessions.map((s) => (
          <div className="card" key={s.id}>
            <div className="card-head">
              <div>
                <h2>{s.topic}</h2>
                <span className="small muted">{canManage && <>{s.userName} · </>}{fmtDate(s.heldAt)} · Acompañó: {s.coachName}</span>
              </div>
              <Badge tone="plain">{s.commitments.filter((c) => c.status === 'cumplido').length} de {s.commitments.length} compromisos cumplidos</Badge>
            </div>
            {s.notes && <div className="card-pad" style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</div>}
            {s.commitments.length > 0 && (
              <table>
                <thead><tr><th>Compromiso</th><th>Fecha límite</th><th>Estado</th></tr></thead>
                <tbody>
                  {s.commitments.map((c) => (
                    <tr key={c.id}>
                      <td>{c.text}</td>
                      <td className="nowrap">{c.dueDate ? fmtDate(`${c.dueDate}T12:00:00`) : '—'}</td>
                      <td>
                        {canManage ? (
                          <select aria-label={`Estado de: ${c.text}`} value={c.status} onChange={(e) => void setStatus(c, e.target.value)} style={{ width: 150 }}>
                            {Object.entries(COMMITMENT_STATUS).map(([v, st]) => <option key={v} value={v}>{st.label}</option>)}
                          </select>
                        ) : (
                          <Badge tone={COMMITMENT_STATUS[c.status]?.tone}>{COMMITMENT_STATUS[c.status]?.label}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      ) : (
        <div className="card"><Empty>{canManage ? 'Aún no hay sesiones registradas.' : 'Aún no tienes sesiones de acompañamiento.'}</Empty></div>
      )}

      {creating && (
        <SessionModal
          sellers={sellers}
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

function SessionModal({ sellers, onClose, onSaved }: { sellers: { id: string; name: string }[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [userId, setUserId] = useState('');
  const [day, setDay] = useState(isoDay(new Date()));
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [commitments, setCommitments] = useState<{ text: string; dueDate: string }[]>([{ text: '', dueDate: '' }]);
  const patch = (i: number, change: Partial<{ text: string; dueDate: string }>) => setCommitments(commitments.map((c, n) => (n === i ? { ...c, ...change } : c)));

  async function save() {
    await api('POST', '/api/argos/coaching', {
      userId, topic, notes,
      heldAt: new Date(`${day}T12:00:00`).toISOString(),
      commitments: commitments.filter((c) => c.text.trim()).map((c) => ({ text: c.text.trim(), dueDate: c.dueDate || null })),
    });
    await onSaved();
  }

  return (
    <FormModal title="Registrar sesión de acompañamiento" submitLabel="Guardar sesión" onClose={onClose} onSubmit={save} wide>
      <div className="row">
        <div className="grow">
          <Field label="Persona">
            <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Elige…</option>
              {sellers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow"><Field label="Fecha de la sesión"><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
      </div>
      <Field label="Tema"><input required minLength={2} maxLength={160} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Ej.: Seguimiento semanal" /></Field>
      <Field label="Notas de la conversación" hint="La persona podrá leerlas."><textarea maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <legend className="small muted">Compromisos acordados</legend>
        {commitments.map((c, i) => (
          <div className="row" key={i}>
            <div className="grow"><input aria-label={`Compromiso ${i + 1}`} maxLength={300} value={c.text} onChange={(e) => patch(i, { text: e.target.value })} placeholder="Qué se compromete a hacer" /></div>
            <input type="date" aria-label={`Fecha límite del compromiso ${i + 1}`} value={c.dueDate} onChange={(e) => patch(i, { dueDate: e.target.value })} style={{ width: 160 }} />
          </div>
        ))}
        <div><button type="button" className="btn sm" onClick={() => setCommitments([...commitments, { text: '', dueDate: '' }])}>Añadir otro compromiso</button></div>
      </fieldset>
    </FormModal>
  );
}
