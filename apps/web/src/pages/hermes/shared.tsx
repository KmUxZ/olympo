// Hermes · piezas compartidas: etiquetas de estado y el detalle de un pedido con su conversación.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { Badge, ErrorNote, Field, Loading, Modal } from '../../components/ui';

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  por_confirmar: { label: 'Por confirmar', tone: 'warn' },
  confirmado: { label: 'Confirmado', tone: 'info' },
  despachado: { label: 'Despachado', tone: 'info' },
  en_reparto: { label: 'En reparto', tone: 'info' },
  novedad: { label: 'Con novedad', tone: 'danger' },
  entregado: { label: 'Entregado', tone: 'ok' },
  devuelto: { label: 'Devuelto', tone: '' },
  cancelado: { label: 'Cancelado', tone: '' },
};
export const INCIDENT_TYPE: Record<string, string> = {
  direccion: 'Dirección errada o incompleta', ausente: 'Cliente ausente', rehusado: 'Pedido rehusado',
  telefono: 'Teléfono no contesta o errado', zona: 'Zona de difícil acceso', otro: 'Otra novedad',
};
export const INCIDENT_STATUS: Record<string, { label: string; tone: string }> = {
  esperando_cliente: { label: 'Esperando al cliente', tone: 'warn' },
  por_gestionar: { label: 'Por gestionar con la transportadora', tone: 'danger' },
  resuelta: { label: 'Gestionada', tone: 'ok' },
  devolucion: { label: 'Terminó en devolución', tone: '' },
};
export const CUSTOMER_CHOICE: Record<string, string> = { reprogramar: 'Pide reprogramar la entrega', corrige_direccion: 'Corrigió la dirección', rechaza: 'Ya no quiere el pedido' };
/** Texto de los productos de un pedido. Los escritos como texto libre se muestran tal cual. */
export const itemsLabel = (items: { name: string; qty: number; free?: boolean }[]) => items.map((i) => (i.free ? i.name : `${i.qty} × ${i.name}`)).join(', ');
export const money = (n: number) => `$${Number(n ?? 0).toLocaleString('es-CO')}`;

const STEPS = ['por_confirmar', 'confirmado', 'despachado', 'en_reparto', 'entregado'];
const EVENT_LABEL: Record<string, string> = {
  creado: 'Pedido creado', confirmacion_enviada: 'Confirmación enviada', recordatorio: 'Recordatorio', confirmado: 'Confirmado', cancelado: 'Cancelado',
  despachado: 'Despachado', en_reparto: 'En reparto', novedad: 'Novedad', novedad_gestionada: 'Novedad gestionada', entregado: 'Entregado', devuelto: 'Devuelto',
  atencion: 'Requiere atención', atendido: 'Atendido', direccion_corregida: 'Dirección corregida',
};

interface Message { id: string; direction: 'in' | 'out'; kind: string; template: string; body: string; buttons: { label: string; payload: string }[]; status: string; sender: string; createdAt: string }

/** Detalle de un pedido: datos, avance, acciones, novedades, historial y la conversación con el cliente. */
export function OrderDetailModal({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged?: () => void }) {
  const { me } = useAuth();
  const canManage = me!.user.role !== 'seller';
  const detail = useApi(`/api/hermes/orders/${orderId}`, 5000);
  const [panel, setPanel] = useState<'despachar' | 'novedad' | 'cancelar' | null>(null);
  const [form, setForm] = useState({ carrier: '', trackingNumber: '', trackingUrl: '', type: 'ausente', description: '', reason: '' });
  const [text, setText] = useState('');
  const [simText, setSimText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPanel(null);
      await detail.reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const act = (body: Record<string, unknown>) => run(() => api('POST', `/api/hermes/orders/${orderId}/action`, body));
  const simulate = (body: { text?: string; payload?: string }) => run(() => api('POST', `/api/hermes/orders/${orderId}/simulate-reply`, body));

  if (!detail.data) return <Modal title="Pedido" onClose={onClose} wide><div className="modal-body">{detail.error ? <ErrorNote error={detail.error} /> : <Loading />}</div></Modal>;
  const { order: o, events, incidents, driver } = detail.data;
  const messages: Message[] = detail.data.messages;
  const st = ORDER_STATUS[o.status];
  const stepIndex = STEPS.indexOf(o.status === 'novedad' ? 'en_reparto' : o.status);
  const lastButtons = [...messages].reverse().find((m) => m.direction === 'out' && m.buttons.length)?.buttons ?? [];
  const is = (...s: string[]) => s.includes(o.status);

  return (
    <Modal title={`Pedido ${o.code}`} onClose={onClose} wide>
      <div className="modal-body">
        <ErrorNote error={error} />
        <div className="row">
          <div className="grow">
            <strong style={{ fontSize: 'var(--text-lg)' }}>{o.customerName}</strong>
            <div className="small muted">{o.phone} · {o.address}, {o.city}{o.notes ? ` · ${o.notes}` : ''}</div>
            <div className="small muted">{itemsLabel(o.items)} · <strong>{money(o.total)}</strong> {o.payment === 'pagado' ? '(ya pagado)' : 'contraentrega'}{o.sellerName ? ` · Venta de ${o.sellerName}` : ''}</div>
            {o.trackingNumber && <div className="small">Guía <span className="mono">{o.trackingNumber}</span> · {o.carrier}{o.trackingUrl && <> · <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer">Rastrear</a></>}</div>}
          </div>
          <Badge tone={st?.tone}>{st?.label ?? o.status}</Badge>
        </div>

        {!is('cancelado', 'devuelto') && (
          <ol className="steps" aria-label="Avance del pedido">
            {STEPS.map((s, i) => (
              <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? (o.status === 'novedad' ? 'current problem' : 'current') : ''}>
                <span>{ORDER_STATUS[s].label}</span>
              </li>
            ))}
          </ol>
        )}

        {(o.addressCheck?.level !== 'completa' || o.customerRisk === 'alto' || o.customerRisk === 'medio') && !is('entregado', 'cancelado') && (
          <ValidationBox compact value={{ address: o.addressCheck ?? null, history: o.customerRisk && o.customerRisk !== 'nuevo' ? { risk: o.customerRisk, message: '' } : null }} />
        )}

        {o.attention && (
          <div className="alert danger row" role="status">
            <span className="grow"><strong>Necesita a una persona.</strong> {o.attentionReason}</span>
            {canManage && <button className="btn sm" disabled={busy} onClick={() => void act({ action: 'atendido' })}>Marcar atendido</button>}
          </div>
        )}

        <div className="grid cols-2">
          {/* Conversación */}
          <div className="card chat-card">
            <div className="card-head">
              <h3>Conversación con el cliente</h3>
              {driver === 'simulado' ? <Badge tone="warn">Modo simulado · no se envía nada</Badge> : <Badge tone="ok">WhatsApp</Badge>}
            </div>
            <div className="chat" aria-live="polite">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.direction}`}>
                  <div className="bubble-meta">{m.direction === 'in' ? 'Cliente' : m.sender} · {fmtTime(m.createdAt)}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  {m.buttons.length > 0 && <div className="bubble-buttons">{m.buttons.map((b) => <span key={b.payload}>{b.label}</span>)}</div>}
                </div>
              ))}
            </div>
            {canManage && (
              <form className="chat-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (text.trim()) void run(() => api('POST', `/api/hermes/orders/${orderId}/message`, { body: text.trim() })).then(() => setText('')); }}>
                <input aria-label="Responder al cliente" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe una respuesta como persona…" maxLength={1000} />
                <button className="btn primary sm" disabled={busy || !text.trim()}>Enviar</button>
              </form>
            )}
            {canManage && driver === 'simulado' && (
              <div className="sim">
                <strong className="xs">Simular la respuesta del cliente</strong>
                <div className="actions">
                  {!is('entregado', 'devuelto', 'cancelado') && lastButtons.map((b) => <button key={b.payload} className="btn sm" disabled={busy} onClick={() => void simulate({ payload: b.payload })}>{b.label}</button>)}
                </div>
                <form className="chat-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (simText.trim()) void simulate({ text: simText.trim() }).then(() => setSimText('')); }}>
                  <input aria-label="Texto que escribiría el cliente" value={simText} onChange={(e) => setSimText(e.target.value)} placeholder="…o escribe lo que diría el cliente" maxLength={500} />
                  <button className="btn sm" disabled={busy || !simText.trim()}>Simular</button>
                </form>
              </div>
            )}
          </div>

          {/* Gestión */}
          <div className="stack">
            {canManage && !is('entregado', 'devuelto', 'cancelado') && (
              <div className="card card-pad stack">
                <h3>Qué sigue</h3>
                {panel === null && (
                  <div className="actions">
                    {is('por_confirmar') && <button className="btn primary sm" disabled={busy} onClick={() => void act({ action: 'confirmar' })}>Confirmar manualmente</button>}
                    {is('confirmado') && <button className="btn primary sm" onClick={() => setPanel('despachar')}>Despachar y enviar guía</button>}
                    {is('despachado', 'novedad') && <button className="btn primary sm" disabled={busy} onClick={() => void act({ action: 'en_reparto' })}>{is('novedad') ? 'Sale de nuevo a reparto' : 'Sale a reparto'}</button>}
                    {is('despachado', 'en_reparto') && <button className="btn sm" onClick={() => setPanel('novedad')}>Reportar novedad</button>}
                    {is('despachado', 'en_reparto', 'novedad') && <button className="btn sm" disabled={busy} onClick={() => void act({ action: 'entregado' })}>Entregado</button>}
                    {is('despachado', 'en_reparto', 'novedad') && <button className="btn sm" disabled={busy} onClick={() => window.confirm('¿Marcar el pedido como devuelto?') && void act({ action: 'devuelto' })}>Devuelto</button>}
                    {is('por_confirmar', 'confirmado', 'novedad') && <button className="btn sm danger" onClick={() => setPanel('cancelar')}>Cancelar pedido</button>}
                  </div>
                )}
                {panel === 'despachar' && (
                  <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void act({ action: 'despachar', carrier: form.carrier, trackingNumber: form.trackingNumber, trackingUrl: form.trackingUrl }); }}>
                    <div className="row">
                      <div className="grow"><Field label="Transportadora"><input required minLength={2} value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} placeholder="Ej.: Interrapidísimo" /></Field></div>
                      <div className="grow"><Field label="Número de guía"><input required minLength={3} value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} /></Field></div>
                    </div>
                    <Field label="Enlace de rastreo (opcional)"><input type="url" value={form.trackingUrl} onChange={(e) => setForm({ ...form, trackingUrl: e.target.value })} placeholder="https://…" /></Field>
                    <div className="actions"><button type="button" className="btn sm" onClick={() => setPanel(null)}>Volver</button><button className="btn primary sm" disabled={busy}>Despachar y avisar al cliente</button></div>
                  </form>
                )}
                {panel === 'novedad' && (
                  <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void act({ action: 'novedad', type: form.type, description: form.description }); }}>
                    <Field label="Qué reportó la transportadora">
                      <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(INCIDENT_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    </Field>
                    <Field label="Detalle (opcional)"><input maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
                    <p className="small muted">El bot le escribirá al cliente de inmediato con opciones para resolverla.</p>
                    <div className="actions"><button type="button" className="btn sm" onClick={() => setPanel(null)}>Volver</button><button className="btn primary sm" disabled={busy}>Reportar y avisar al cliente</button></div>
                  </form>
                )}
                {panel === 'cancelar' && (
                  <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void act({ action: 'cancelar', reason: form.reason }); }}>
                    <Field label="Motivo de la cancelación"><input required minLength={2} maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
                    <div className="actions"><button type="button" className="btn sm" onClick={() => setPanel(null)}>Volver</button><button className="btn danger sm" disabled={busy}>Cancelar pedido</button></div>
                  </form>
                )}
              </div>
            )}

            {incidents.length > 0 && (
              <div className="card">
                <div className="card-head"><h3>Novedades</h3></div>
                <ul className="feed">
                  {incidents.map((i: { id: string; type: string; description: string; status: string; customerChoice: string; resolution: string; createdAt: string }) => (
                    <li key={i.id}>
                      <time>{fmtDateTime(i.createdAt)}</time>
                      <div>
                        <strong>{INCIDENT_TYPE[i.type]}</strong> <Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge>
                        {i.description && <div className="muted">{i.description}</div>}
                        {i.customerChoice && <div>Cliente: {CUSTOMER_CHOICE[i.customerChoice]}</div>}
                        {i.resolution && <div className="muted">Gestión: {i.resolution}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="card">
              <div className="card-head"><h3>Historial</h3></div>
              <ul className="feed">
                {events.map((e: { id: string; at: string; type: string; detail: string; actor: string }) => (
                  <li key={e.id}>
                    <time>{fmtDateTime(e.at)}</time>
                    <div><strong>{EVENT_LABEL[e.type] ?? e.type}</strong> <span className="muted">· {e.actor}</span>{e.detail && <div className="muted">{e.detail}</div>}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export interface Validation {
  address: { level: 'completa' | 'revisar' | 'incompleta'; issues: { code: string; message: string; severity: string }[]; normalizedAddress: string; city: { name: string; department: string } | null } | null;
  contact?: { code: string; message: string; severity: string }[];
  history?: { risk: 'alto' | 'medio' | 'bueno' | 'nuevo'; message: string } | null;
}
const LEVEL: Record<string, { label: string; tone: string }> = {
  completa: { label: 'Dirección completa', tone: 'ok' },
  revisar: { label: 'Dirección por revisar', tone: 'warn' },
  incompleta: { label: 'Dirección incompleta', tone: 'danger' },
};
const RISK_TONE: Record<string, string> = { alto: 'danger', medio: 'warn', bueno: 'ok', nuevo: 'plain' };
const RISK_LABEL: Record<string, string> = { alto: 'Riesgo alto de devolución', medio: 'Historial mixto', bueno: 'Cliente cumplido', nuevo: 'Cliente nuevo' };

/** Resultado del validador de datos de entrega: qué falta en la dirección y cómo le ha ido a este cliente antes. */
export function ValidationBox({ value, compact }: { value: Validation | null; compact?: boolean }) {
  if (!value || (!value.address && !value.contact?.length && !value.history)) return null;
  const issues = [...(value.contact ?? []), ...(value.address?.issues ?? [])];
  return (
    <div className="check-box" role="status">
      <div className="actions">
        {value.address && <Badge tone={LEVEL[value.address.level].tone}>{LEVEL[value.address.level].label}</Badge>}
        {value.address?.city && <span className="xs muted">{value.address.city.name}, {value.address.city.department}</span>}
        {value.history && <Badge tone={RISK_TONE[value.history.risk]}>{RISK_LABEL[value.history.risk]}</Badge>}
      </div>
      {issues.length > 0 && (
        <ul>
          {issues.map((i) => <li key={i.code} className={i.severity === 'error' ? 'is-error' : ''}>{i.message}</li>)}
        </ul>
      )}
      {value.history && value.history.risk !== 'nuevo' && <p className="small">{value.history.message}</p>}
      {!compact && value.address && value.address.level === 'completa' && value.address.normalizedAddress && (
        <p className="xs muted">Se entiende como: {value.address.normalizedAddress}</p>
      )}
      {!compact && <p className="xs muted">Revisa la forma de la dirección, no si existe en el mapa ni la cobertura de la transportadora.</p>}
    </div>
  );
}
