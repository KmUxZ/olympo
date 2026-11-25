// Zeus · piezas comunes: segmentos, ficha del cliente y creación de seguimientos.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, useApi } from '../../lib/api';
import { fmtDate, fmtDateTime, isoDay } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, Modal } from '../../components/ui';
import { itemsLabel, money, ORDER_STATUS } from '../hermes/shared';

export const SEGMENT: Record<string, { label: string; tone: string; help: string }> = {
  vip: { label: 'VIP', tone: 'ok', help: '3 o más pedidos entregados' },
  recurrente: { label: 'Recurrente', tone: 'ok', help: '2 pedidos entregados' },
  una_vez: { label: 'Compró una vez', tone: 'info', help: '1 pedido entregado' },
  en_proceso: { label: 'En proceso', tone: 'info', help: 'Aún no recibe, tiene un pedido en curso' },
  sin_entrega: { label: 'Sin entrega', tone: 'plain', help: 'Pidió, pero nunca recibió un pedido' },
  riesgoso: { label: 'Riesgoso', tone: 'warn', help: '2 o más pedidos devueltos o cancelados, y no menos que los entregados' },
  bloqueado: { label: 'Bloqueado', tone: 'danger', help: 'Está en la lista de clientes bloqueados de Hermes' },
};
export const OUTCOME: Record<string, { label: string; tone: string }> = {
  compro: { label: 'Compró', tone: 'ok' },
  interesado: { label: 'Interesado', tone: 'info' },
  no_interesado: { label: 'No le interesa', tone: 'plain' },
  no_contesta: { label: 'No contesta', tone: 'warn' },
};

export interface Customer {
  phone: string; name: string; city: string; orders: number; delivered: number; returned: number; cancelled: number; open: number; value: number;
  firstAt: string; lastAt: string; lastDeliveredAt: string | null; segment: string; blocked: boolean; tags: string[]; sellerId: string | null; sellerName: string | null; pendingFollowups: number;
}
export interface Followup { id: string; phone: string; customerName: string; title: string; dueOn: string; status: string; outcome: string; result: string; assignedUserId: string | null; assignedName: string | null; doneAt: string | null }
interface User { id: string; name: string; role: string; status: string }

export const SegmentBadge = ({ segment }: { segment: string }) => <span title={SEGMENT[segment]?.help}><Badge tone={SEGMENT[segment]?.tone ?? ''}>{SEGMENT[segment]?.label ?? segment}</Badge></span>;
export const prettyPhone = (phone: string) => (phone.startsWith('57') && phone.length === 12 ? `${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}` : phone);
export const WhatsLink = ({ phone }: { phone: string }) => <a href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer" className="nowrap">{prettyPhone(phone)}</a>;
export const daysSince = (when: string | null) => (when ? Math.floor((Date.now() - new Date(when).getTime()) / 86400_000) : null);
export const fmtDay = (key: string) => fmtDate(`${key}T12:00:00`);

/** Crea el mismo seguimiento para uno o varios clientes. */
export function FollowupModal({ phones, label, defaultTitle = 'Ofrecer recompra', onClose, onSaved }: { phones: string[]; label: string; defaultTitle?: string; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const users = useApi<{ users: User[] }>('/api/users');
  const [title, setTitle] = useState(defaultTitle);
  const [dueOn, setDueOn] = useState(isoDay(new Date()));
  const [who, setWho] = useState('auto');
  async function save() {
    await api('POST', '/api/zeus/followups', { phones, title, dueOn, ...(who === 'auto' ? {} : { assignedUserId: who || null }) });
    await onSaved();
  }
  return (
    <FormModal title={`Nuevo seguimiento · ${label}`} submitLabel={phones.length > 1 ? `Crear ${phones.length} seguimientos` : 'Crear seguimiento'} onClose={onClose} onSubmit={save}>
      <Field label="Qué hay que hacer" hint="Lo verá la persona encargada. Ej.: Ofrecer recompra con 10 % de descuento.">
        <input required minLength={3} maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="row">
        <div className="grow"><Field label="Para cuándo"><input type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field></div>
        <div className="grow">
          <Field label="Quién lo hace">
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="auto">Quien le vendió la última vez</option>
              <option value="">Sin asignar</option>
              {(users.data?.users ?? []).filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <p className="small muted">La vendedora encargada lo verá en «Seguimientos» con el nombre y el WhatsApp del cliente, sin su historial de pedidos.</p>
    </FormModal>
  );
}

interface Detail {
  customer: Customer & { blockedReason: string };
  orders: { id: string; code: string; status: string; total: number; items: { name: string; qty: number; free?: boolean }[]; city: string; source: string; createdAt: string; sellerName: string | null }[];
  notes: { id: string; body: string; authorName: string; createdAt: string }[];
  followups: (Omit<Followup, 'phone' | 'customerName'> & { createdAt: string })[];
  today: string;
}

export function CustomerModal({ phone, onClose, onChanged }: { phone: string; onClose: () => void; onChanged?: () => void }) {
  const detail = useApi<Detail>(`/api/zeus/customers/${phone}`);
  const [note, setNote] = useState('');
  const [tag, setTag] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      await detail.reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const d = detail.data;
  const c = d?.customer;
  const setTags = (tags: string[]) => run(() => api('PUT', `/api/zeus/customers/${phone}`, { tags }));
  const closed = c ? c.delivered + c.returned + c.cancelled : 0;

  return (
    <Modal title={c ? c.name : 'Cliente'} onClose={onClose} wide>
      <div className="modal-body stack">
        <ErrorNote error={error ?? detail.error} />
        {!d || !c ? <Loading /> : (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <SegmentBadge segment={c.segment} /> <span className="small"><WhatsLink phone={c.phone} /> · {c.city}</span>
                <div className="xs muted">Cliente desde {fmtDate(c.firstAt)}{c.sellerName ? ` · última venta: ${c.sellerName}` : ''}</div>
              </div>
              <button className="btn sm primary" onClick={() => setAdding(true)} disabled={c.blocked}>Nuevo seguimiento</button>
            </div>
            {c.blocked && <div className="alert danger">Cliente bloqueado en Hermes{c.blockedReason ? `: ${c.blockedReason}` : ''}. No se le pueden crear pedidos.</div>}

            <div className="grid cols-4">
              <div className="card stat"><b>{c.delivered}</b><span>Entregados</span></div>
              <div className="card stat"><b>{money(c.value)}</b><span>Valor entregado</span></div>
              <div className="card stat"><b>{closed ? `${Math.round((c.delivered / closed) * 100)}%` : '—'}</b><span>Recibe lo que pide</span></div>
              <div className="card stat"><b>{c.lastDeliveredAt ? `${daysSince(c.lastDeliveredAt)} d` : '—'}</b><span>Desde la última entrega</span></div>
            </div>

            <div>
              <h3>Etiquetas</h3>
              <div className="row" style={{ gap: 6 }}>
                {c.tags.map((t) => (
                  <span key={t} className="badge plain">{t} <button type="button" className="link" aria-label={`Quitar ${t}`} disabled={busy} onClick={() => void setTags(c.tags.filter((x) => x !== t))}>×</button></span>
                ))}
                <form className="row" style={{ gap: 6 }} onSubmit={(e: FormEvent) => { e.preventDefault(); if (tag.trim()) void setTags([...c.tags, tag]).then(() => setTag('')); }}>
                  <input aria-label="Nueva etiqueta" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={30} placeholder="Añadir etiqueta" style={{ width: 160 }} />
                  <button className="btn sm" disabled={busy || !tag.trim()}>Añadir</button>
                </form>
              </div>
            </div>

            <div>
              <h3>Seguimientos</h3>
              {d.followups.length ? (
                <ul className="plain-list">
                  {d.followups.map((f) => (
                    <li key={f.id}>
                      {f.status === 'pendiente' ? <Badge tone={f.dueOn < d.today ? 'danger' : 'warn'}>{f.dueOn < d.today ? 'Vencido' : 'Pendiente'}</Badge> : f.status === 'hecho' ? <Badge tone={OUTCOME[f.outcome]?.tone ?? 'ok'}>{OUTCOME[f.outcome]?.label ?? 'Hecho'}</Badge> : <Badge tone="plain">Descartado</Badge>}{' '}
                      <strong>{f.title}</strong> <span className="muted small">· {fmtDay(f.dueOn)} · {f.assignedName ?? 'sin asignar'}</span>
                      {f.result && <div className="small muted">{f.result}</div>}
                    </li>
                  ))}
                </ul>
              ) : <p className="small muted">Sin seguimientos.</p>}
            </div>

            <div>
              <h3>Pedidos ({c.orders})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Pedido</th><th>Fecha</th><th>Productos</th><th>Total</th><th>Estado</th><th>Vendió</th></tr></thead>
                  <tbody>
                    {d.orders.map((o) => (
                      <tr key={o.id}>
                        <td className="mono nowrap">{o.code}</td>
                        <td className="nowrap">{fmtDate(o.createdAt)}</td>
                        <td className="small">{itemsLabel(o.items)}</td>
                        <td className="nowrap">{money(o.total)}</td>
                        <td><Badge tone={ORDER_STATUS[o.status]?.tone ?? ''}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge></td>
                        <td className="small">{o.sellerName ?? (o.source === 'athena' ? 'Athena' : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3>Notas</h3>
              <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); if (note.trim().length >= 2) void run(() => api('POST', `/api/zeus/customers/${phone}/notes`, { body: note.trim() })).then(() => setNote('')); }}>
                <input className="grow" aria-label="Nueva nota" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Ej.: prefiere que le escriban en la tarde" />
                <button className="btn sm" disabled={busy || note.trim().length < 2}>Guardar nota</button>
              </form>
              {d.notes.length ? (
                <ul className="plain-list" style={{ marginTop: 8 }}>
                  {d.notes.map((n) => <li key={n.id}>{n.body}<div className="xs muted">{n.authorName} · {fmtDateTime(n.createdAt)}</div></li>)}
                </ul>
              ) : <Empty>Sin notas todavía.</Empty>}
            </div>
          </>
        )}
      </div>
      {adding && c && <FollowupModal phones={[phone]} label={c.name} onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await detail.reload(); onChanged?.(); }} />}
    </Modal>
  );
}
