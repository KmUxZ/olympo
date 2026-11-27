// Hermes · en oficina: bandeja de pedidos que esperan en una oficina de la transportadora.
// Es la lista de trabajo de quien les hace seguimiento para que no terminen en devolución.
import { useMemo, useState } from 'react';
import { api, useApi } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHero } from '../../components/ui';
import { money, OrderDetailModal } from './shared';

interface Row {
  id: string; code: string; customerName: string; phone: string; city: string; carrier: string; trackingNumber: string; total: number; payment: string; status: string;
  attention: boolean; attentionReason: string; reminders: number; sellerName: string | null; operatorName: string | null;
  since: string | null; lastAnswer: string | null; noteAt: string | null; note: string | null; noteBy: string | null;
}

const prettyPhone = (phone: string) => (phone.startsWith('57') && phone.length === 12 ? `${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}` : phone);
const daysIn = (since: string | null, now: number) => (since ? Math.max(0, Math.floor((now - new Date(since).getTime()) / 86_400_000)) : 0);
const sameDay = (a: string | null, now: number) => Boolean(a) && new Date(a!).toDateString() === new Date(now).toDateString();
/** Qué tan urgente es: la transportadora suele devolver tras varios días sin reclamar. */
const urgency = (days: number): { tone: string; label: string } => (days >= 4 ? { tone: 'danger', label: 'Urgente' } : days >= 2 ? { tone: 'warn', label: 'Insistir' } : { tone: 'info', label: 'Reciente' });
const answerTone = (a: string | null) => (!a ? 'plain' : /no puede/i.test(a) ? 'danger' : /recogi/i.test(a) ? 'ok' : 'info');

type Filter = 'todos' | 'hoy' | 'urgentes' | 'no_puede' | 'sin_respuesta';

export function HermesOffice() {
  const list = useApi<{ orders: Row[]; now: string }>('/api/hermes/office', 30_000);
  const [filter, setFilter] = useState<Filter>('todos');
  const [open, setOpen] = useState<string | null>(null);
  const [noting, setNoting] = useState<Row | null>(null);
  const now = list.data ? new Date(list.data.now).getTime() : Date.now();
  const all = list.data?.orders ?? [];

  const groups = useMemo(() => ({
    todos: all,
    hoy: all.filter((r) => !sameDay(r.noteAt, now)),
    urgentes: all.filter((r) => daysIn(r.since, now) >= 4),
    no_puede: all.filter((r) => /no puede/i.test(r.lastAnswer ?? '')),
    sin_respuesta: all.filter((r) => !r.lastAnswer && r.reminders > 0),
  }), [all, now]);
  const rows = groups[filter];
  const tabs: [Filter, string][] = [['todos', 'Todos'], ['hoy', 'Sin gestionar hoy'], ['urgentes', '4 días o más'], ['no_puede', 'No puede ir'], ['sin_respuesta', 'No responde']];

  return (
    <>
      <PageHero
        tone="hermes"
        title="En oficina"
        subtitle="Pedidos que esperan a que el cliente los reclame. Si nadie va, la transportadora los devuelve: aquí se les hace seguimiento."
        kpis={[
          { label: 'Esperando en oficina', value: list.data ? all.length : '—' },
          { label: '4 días o más', value: list.data ? groups.urgentes.length : '—' },
          { label: 'Sin gestionar hoy', value: list.data ? groups.hoy.length : '—' },
          { label: 'Valor por recaudar', value: list.data ? money(all.filter((r) => r.payment !== 'pagado').reduce((n, r) => n + r.total, 0)) : '—' },
        ]}
      >
        <Freshness updatedAt={list.updatedAt} error={list.error} />
      </PageHero>

      <div className="tabs" role="tablist" style={{ flexWrap: 'wrap' }}>
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>
            {label}{list.data && key !== 'todos' && groups[key].length > 0 && <> <Badge tone={key === 'urgentes' || key === 'no_puede' ? 'danger' : 'plain'}>{groups[key].length}</Badge></>}
          </button>
        ))}
      </div>

      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>En oficina</th><th>Cliente</th><th>Guía</th><th>Por recaudar</th><th>Qué dijo el cliente</th><th>Última gestión</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const days = daysIn(r.since, now);
                  const u = urgency(days);
                  return (
                    <tr key={r.id}>
                      <td className="nowrap">
                        <strong style={{ fontSize: 'var(--text-lg)' }}>{days === 0 ? 'Hoy' : `${days} día${days === 1 ? '' : 's'}`}</strong>
                        <span className="sub"><Badge tone={u.tone}>{u.label}</Badge></span>
                        <span className="sub">desde {r.since ? fmtDateTime(r.since) : '—'}</span>
                      </td>
                      <td style={{ minWidth: 190 }}>
                        <strong>{r.customerName}</strong>
                        <span className="sub"><a href={`https://wa.me/${r.phone}`} target="_blank" rel="noopener noreferrer">{prettyPhone(r.phone)}</a> · {r.city}</span>
                        <span className="sub">Pedido {r.code}{r.sellerName ? ` · vendió ${r.sellerName}` : ''}</span>
                      </td>
                      <td><span className="mono">{r.trackingNumber || '—'}</span><span className="sub">{[r.carrier, r.operatorName].filter(Boolean).join(' · ')}</span></td>
                      <td className="nowrap">{r.payment === 'pagado' ? <span className="muted">Ya pagado</span> : money(r.total)}</td>
                      <td style={{ maxWidth: 220 }}>
                        {r.lastAnswer ? <Badge tone={answerTone(r.lastAnswer)}>{r.lastAnswer.replace(/^El cliente dice que /, '').replace(/^./, (c) => c.toUpperCase())}</Badge> : <span className="muted">Sin respuesta</span>}
                        <span className="sub">{r.reminders === 0 ? 'Aún sin recordatorios' : `${Math.min(r.reminders, 2)} recordatorio${r.reminders === 1 ? '' : 's'} enviado${r.reminders === 1 ? '' : 's'}`}</span>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        {r.note ? <>{r.note}<span className="sub">{r.noteBy} · {r.noteAt ? fmtDateTime(r.noteAt) : ''}</span></> : <span className="muted">Sin gestión todavía</span>}
                      </td>
                      <td className="nowrap">
                        <button className="btn sm primary" onClick={() => setNoting(r)}>Registrar gestión</button>{' '}
                        <button className="btn sm" onClick={() => setOpen(r.id)}>Abrir</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{all.length ? 'Ningún pedido en este filtro.' : 'No hay pedidos esperando en oficina. Aparecen aquí cuando la transportadora informa que el paquete quedó para reclamar.'}</Empty>
        )}
      </div>

      {noting && <NoteModal row={noting} onClose={() => setNoting(null)} onSaved={async () => { setNoting(null); await list.reload(); window.dispatchEvent(new Event('olympo:notifications')); }} />}
      {open && <OrderDetailModal orderId={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </>
  );
}

const QUICK = ['Lo llamé: va a pasar hoy', 'Lo llamé: va a pasar mañana', 'No contesta', 'Número equivocado o apagado', 'Pide que se lo lleven a la casa', 'Ya no lo quiere'];

function NoteModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState('');
  async function save() {
    await api('POST', `/api/hermes/orders/${row.id}/office-note`, { note: note.trim() });
    await onSaved();
  }
  return (
    <FormModal title={`${row.customerName} · pedido ${row.code}`} submitLabel="Guardar gestión" onClose={onClose} onSubmit={save}>
      <p className="small muted">Deja constancia de lo que hablaste con el cliente. Queda en el historial del pedido con tu nombre y la hora.</p>
      <div className="row" role="group" aria-label="Respuestas frecuentes" style={{ flexWrap: 'wrap' }}>
        {QUICK.map((q) => <button type="button" key={q} className="btn sm" onClick={() => setNote(q)}>{q}</button>)}
      </div>
      <Field label="Qué pasó">
        <textarea required minLength={2} maxLength={300} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: lo llamé y dice que pasa el sábado en la mañana" />
      </Field>
      <p className="xs muted">Para marcarlo como entregado o devuelto, usa «Abrir» en la lista.</p>
    </FormModal>
  );
}
