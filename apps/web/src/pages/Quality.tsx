import { Fragment, useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Sparkline } from '../components/charts';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHero } from '../components/ui';

interface Score { criterionId: string; name: string; weight: number; score: number }
interface Evaluation { id: string; userId: string; userName: string; evaluatorName: string; reference: string; observations: string; feedback: string; scores: Score[]; total: number; createdAt: string; acknowledgedAt: string | null }
interface Criterion { id: string; name: string; description: string; weight: number; active: boolean }

const SUGGESTED = [
  { name: 'Saludo y cordialidad', description: 'Trato amable y presentación adecuada.', weight: 1 },
  { name: 'Comprensión de la necesidad', description: 'Pregunta y entiende lo que busca el cliente.', weight: 2 },
  { name: 'Conocimiento del producto', description: 'Responde con información correcta y completa.', weight: 2 },
  { name: 'Manejo de objeciones', description: 'Resuelve dudas y objeciones con argumentos.', weight: 2 },
  { name: 'Cierre y siguiente paso', description: 'Propone el cierre o deja claro el siguiente paso.', weight: 3 },
];
const tone = (total: number) => (total >= 80 ? 'ok' : total >= 60 ? 'warn' : 'danger');

export function Quality() {
  const { me } = useAuth();
  const role = me!.user.role;
  const canEvaluate = role !== 'seller';
  const list = useApi<{ evaluations: Evaluation[]; maxScore: number }>('/api/argos/quality/evaluations');
  const criteria = useApi<{ criteria: Criterion[]; maxScore: number }>(canEvaluate ? '/api/argos/quality/criteria' : null);
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>(canEvaluate ? '/api/users' : null);
  const [open, setOpen] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [editing, setEditing] = useState<Criterion | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = (criteria.data?.criteria ?? []).filter((c) => c.active);
  const maxScore = list.data?.maxScore ?? 5;
  const evals = list.data?.evaluations ?? [];
  // Evolución: evaluaciones de cada persona en orden cronológico.
  const byUser = new Map<string, Evaluation[]>();
  for (const e of [...evals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  const trends = [...byUser.values()].map((list) => {
    const values = list.map((e) => e.total);
    const last = values[values.length - 1];
    return {
      userId: list[0].userId, userName: list[0].userName, values, last,
      average: Math.round(values.reduce((n, v) => n + v, 0) / values.length),
      change: values.length > 1 ? last - values[values.length - 2] : null,
    };
  }).sort((a, b) => a.userName.localeCompare(b.userName));

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await Promise.all([list.reload(), criteria.reload()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const useSuggested = () => act(async () => { for (const c of SUGGESTED) await api('POST', '/api/argos/quality/criteria', c); });

  return (
    <>
      <PageHero kpis={[{ label: 'Evaluaciones', value: evals.length }, { label: 'Promedio', value: evals.length ? `${Math.round(evals.reduce((n, e) => n + e.total, 0) / evals.length)}` : '—' }, { label: 'Sin confirmar lectura', value: evals.filter((e) => !e.acknowledgedAt).length }]} title="Calidad" subtitle={canEvaluate ? 'Evaluaciones de la atención con criterios configurables, observaciones y retroalimentación.' : 'Tus evaluaciones de calidad y la retroalimentación recibida.'}>
        {canEvaluate && <button className="btn primary" disabled={!active.length} onClick={() => setEvaluating(true)}>Nueva evaluación</button>}
      </PageHero>
      <ErrorNote error={error ?? list.error} />

      {trends.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>{canEvaluate ? 'Evolución por persona' : 'Tu evolución'}</h2>
            <span className="xs muted">Cada punto es una evaluación, de la más antigua a la más reciente · línea punteada = 80</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr>{canEvaluate && <th>Persona</th>}<th>Evolución</th><th>Última</th><th>Promedio</th><th>Cambio</th><th>Evaluaciones</th></tr></thead>
              <tbody>
                {trends.map((t) => (
                  <tr key={t.userId}>
                    {canEvaluate && <td><strong>{t.userName}</strong></td>}
                    <td><Sparkline values={t.values} label={`Evolución de ${t.userName}`} /></td>
                    <td><Badge tone={tone(t.last)}>{t.last} de 100</Badge></td>
                    <td>{t.average}</td>
                    <td>{t.change === null ? <span className="muted">Primera evaluación</span> : t.change === 0 ? 'Igual' : <span className={t.change > 0 ? 'trend-up' : 'trend-down'}>{t.change > 0 ? `▲ +${t.change}` : `▼ ${t.change}`}</span>}</td>
                    <td>{t.values.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        {!list.data ? <Loading /> : list.data.evaluations.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr>{canEvaluate && <th>Persona</th>}<th>Fecha</th><th>Qué se evaluó</th><th>Resultado</th><th>Evaluó</th><th>Lectura</th><th></th></tr></thead>
              <tbody>
                {list.data.evaluations.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      {canEvaluate && <td><strong>{e.userName}</strong></td>}
                      <td className="nowrap">{fmtDate(e.createdAt)}</td>
                      <td>{e.reference || '—'}</td>
                      <td><Badge tone={tone(e.total)}>{e.total} de 100</Badge></td>
                      <td>{e.evaluatorName}</td>
                      <td>{e.acknowledgedAt ? <span className="small muted">Leída el {fmtDate(e.acknowledgedAt)}</span> : <Badge tone="plain">Sin confirmar</Badge>}</td>
                      <td><button className="btn sm" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Ocultar' : 'Ver detalle'}</button></td>
                    </tr>
                    {open === e.id && (
                      <tr>
                        <td colSpan={canEvaluate ? 7 : 6} style={{ background: 'var(--color-surface-alt)' }}>
                          <div className="grid cols-2">
                            <table>
                              <thead><tr><th>Criterio</th><th>Peso</th><th>Nota</th></tr></thead>
                              <tbody>{e.scores.map((s) => <tr key={s.criterionId}><td>{s.name}</td><td>{s.weight}</td><td>{s.score} de {maxScore}</td></tr>)}</tbody>
                            </table>
                            <div className="stack">
                              <div><strong className="small">Observaciones</strong><div style={{ whiteSpace: 'pre-wrap' }}>{e.observations || <span className="muted">Sin observaciones.</span>}</div></div>
                              <div><strong className="small">Retroalimentación</strong><div style={{ whiteSpace: 'pre-wrap' }}>{e.feedback || <span className="muted">Sin retroalimentación.</span>}</div></div>
                              {e.userId === me!.user.id && !e.acknowledgedAt && (
                                <div><button className="btn primary sm" onClick={() => void act(() => api('POST', `/api/argos/quality/evaluations/${e.id}/ack`))}>Confirmar que la leí</button></div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{canEvaluate ? 'Aún no hay evaluaciones.' : 'Aún no tienes evaluaciones de calidad.'}</Empty>
        )}
        <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
          Las evaluaciones son una valoración hecha por una persona sobre la atención. No usan datos de teclado ni de actividad.
        </div>
      </div>

      {canEvaluate && (
        <div className="card">
          <div className="card-head">
            <h2>Criterios de evaluación</h2>
            {role === 'admin' ? <button className="btn sm" onClick={() => setEditing('new')}>Nuevo criterio</button> : <span className="xs muted">Los define un administrador</span>}
          </div>
          {!criteria.data ? <Loading /> : criteria.data.criteria.length ? (
            <table>
              <thead><tr><th>Criterio</th><th>Peso</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {criteria.data.criteria.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong>{c.description && <span className="sub">{c.description}</span>}</td>
                    <td>{c.weight}</td>
                    <td>{c.active ? <Badge tone="ok">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
                    <td>{role === 'admin' && <button className="btn sm" onClick={() => setEditing(c)}>Editar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>
              Aún no hay criterios.{' '}
              {role === 'admin' ? <button className="btn sm" onClick={() => void useSuggested()}>Usar criterios sugeridos</button> : 'Pide a un administrador que los defina.'}
            </Empty>
          )}
        </div>
      )}

      {evaluating && (
        <EvaluationModal
          criteria={active}
          maxScore={maxScore}
          people={(users.data?.users ?? []).filter((u) => u.role === 'seller' && u.status === 'active')}
          onClose={() => setEvaluating(false)}
          onSaved={async () => {
            setEvaluating(false);
            await list.reload();
          }}
        />
      )}
      {editing && (
        <CriterionModal
          criterion={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await criteria.reload();
          }}
        />
      )}
    </>
  );
}

function EvaluationModal({ criteria, maxScore, people, onClose, onSaved }: { criteria: Criterion[]; maxScore: number; people: { id: string; name: string }[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [userId, setUserId] = useState('');
  const [reference, setReference] = useState('');
  const [observations, setObservations] = useState('');
  const [feedback, setFeedback] = useState('');
  const [scores, setScores] = useState<Record<string, number>>({});
  const complete = criteria.every((c) => scores[c.id] !== undefined);
  const weightSum = criteria.reduce((n, c) => n + c.weight, 0);
  const total = complete ? Math.round((criteria.reduce((n, c) => n + (scores[c.id] / maxScore) * c.weight, 0) / weightSum) * 100) : null;

  async function save() {
    if (!complete) throw new Error('Pon una nota en cada criterio.');
    await api('POST', '/api/argos/quality/evaluations', { userId, reference, observations, feedback, scores: criteria.map((c) => ({ criterionId: c.id, score: scores[c.id] })) });
    await onSaved();
  }

  return (
    <FormModal title="Nueva evaluación de calidad" submitLabel="Guardar evaluación" onClose={onClose} onSubmit={save} wide>
      <div className="row">
        <div className="grow">
          <Field label="Persona evaluada">
            <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Elige…</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow"><Field label="Qué se evaluó" hint="Conversación, llamada o fecha de referencia."><input maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} /></Field></div>
      </div>
      <table>
        <thead><tr><th>Criterio</th><th>Peso</th><th>Nota (0 a {maxScore})</th></tr></thead>
        <tbody>
          {criteria.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong>{c.description && <span className="sub">{c.description}</span>}</td>
              <td>{c.weight}</td>
              <td>
                <select aria-label={`Nota de ${c.name}`} required value={scores[c.id] ?? ''} onChange={(e) => setScores({ ...scores, [c.id]: Number(e.target.value) })} style={{ width: 110 }}>
                  <option value="">—</option>
                  {Array.from({ length: maxScore + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="alert info" role="status">Resultado: {total === null ? 'completa todas las notas' : `${total} de 100`}</div>
      <Field label="Observaciones"><textarea maxLength={4000} value={observations} onChange={(e) => setObservations(e.target.value)} /></Field>
      <Field label="Retroalimentación para la persona" hint="Podrá leerla y confirmar que la recibió."><textarea maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></Field>
    </FormModal>
  );
}

function CriterionModal({ criterion, onClose, onSaved }: { criterion: Criterion | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(criterion?.name ?? '');
  const [description, setDescription] = useState(criterion?.description ?? '');
  const [weight, setWeight] = useState(criterion?.weight ?? 1);
  const [active, setActive] = useState(criterion?.active ?? true);
  async function save() {
    const body = { name, description, weight, active };
    if (criterion) await api('PATCH', `/api/argos/quality/criteria/${criterion.id}`, body);
    else await api('POST', '/api/argos/quality/criteria', body);
    await onSaved();
  }
  return (
    <FormModal title={criterion ? `Editar criterio · ${criterion.name}` : 'Nuevo criterio'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre"><input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Descripción" hint="Qué se espera para una buena nota."><input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Peso (1 a 10)" hint="Cuánto cuenta este criterio en el resultado final."><input type="number" required min={1} max={10} value={weight} onChange={(e) => setWeight(Number(e.target.value))} /></Field>
      {criterion && <div className="checks"><label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Criterio activo</label></div>}
      <p className="small muted">Cambiar o desactivar un criterio no altera las evaluaciones ya hechas.</p>
    </FormModal>
  );
}
