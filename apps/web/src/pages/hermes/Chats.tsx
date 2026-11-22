// Hermes · Chats: centro de control de las conversaciones del bot.
// Cada conversación dice quién "tiene la pelota" (una persona, el cliente o nadie) y cuánto lleva esperando.
// En el hilo se mezclan los mensajes con los hitos del pedido, para leer la historia completa de arriba abajo.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../auth';
import { api, useApi, useNow } from '../../lib/api';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Freshness, Loading } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { CUSTOMER_CHOICE, EVENT_LABEL, INCIDENT_STATUS, INCIDENT_TYPE, itemsLabel, money, OrderDetailModal, ORDER_STATUS, STEPS, ValidationBox } from './shared';
import type { Message } from './shared';
import { BlockCustomerModal } from './Blocked';

interface Chat {
  id: string; code: string; customerName: string; phone: string; city: string; status: string; awaiting: string | null;
  attention: boolean; attentionReason: string; botPaused: boolean; ball: 'persona' | 'cliente' | 'proceso' | 'cerrado';
  waitingSince: string | null; unread: boolean; lastBody: string | null; lastDirection: 'in' | 'out' | null; lastSender: string | null; lastAt: string;
}

const BALL: Record<string, { label: string; tone: string; help: string }> = {
  persona: { label: 'Te toca', tone: 'danger', help: 'Necesita que alguien del equipo responda o gestione.' },
  cliente: { label: 'Esperando al cliente', tone: 'warn', help: 'Se le preguntó algo y aún no responde.' },
  proceso: { label: 'En curso', tone: 'info', help: 'Nadie debe responder: el pedido sigue su camino.' },
  cerrado: { label: 'Cerrado', tone: 'plain', help: 'Entregado, devuelto o cancelado.' },
};
const TABS: [string, string][] = [['persona', 'Te toca'], ['cliente', 'Esperando al cliente'], ['proceso', 'En curso'], ['cerrado', 'Cerrados'], ['', 'Todos']];
// Hitos del pedido que se intercalan en la conversación.
const STREAM_EVENTS = new Set(['creado', 'confirmado', 'cancelado', 'despachado', 'en_reparto', 'novedad', 'novedad_gestionada', 'entregado', 'devuelto', 'atencion', 'atendido', 'direccion_corregida', 'direccion_incompleta', 'bot_pausado', 'bot_reanudado']);
const EVENT_TONE: Record<string, string> = { entregado: 'ok', confirmado: 'ok', novedad: 'danger', atencion: 'danger', devuelto: 'warn', cancelado: 'warn', bot_pausado: 'info', bot_reanudado: 'info' };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
/** Tiempo de espera compacto: 45 s, 12 min, 2 h 05, 3 d. */
function waited(since: string | null, now: number): string {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 86400)} d`;
}
/** Qué tan urgente es la espera, para colorear el cronómetro. */
const urgency = (since: string | null, now: number, ball: string) => {
  if (!since || ball !== 'persona') return '';
  const min = (now - new Date(since).getTime()) / 60000;
  return min >= 30 ? 'late' : min >= 10 ? 'soon' : '';
};

/** Respuestas sugeridas según el momento del pedido. Rellenan el cuadro de texto; la persona decide si enviarlas. */
function quickReplies(o: { status: string; awaiting: string | null; customerName: string; code: string; trackingNumber: string; carrier: string; total: number; payment: string }, agent: string): string[] {
  const name = o.customerName.split(' ')[0];
  const hello = `Hola ${name}, te escribe ${agent.split(' ')[0]}.`;
  if (o.status === 'por_confirmar') return [`${hello} ¿Te ayudo con alguna duda para confirmar tu pedido ${o.code}?`, '¿Te podemos llamar ahora para confirmar la entrega?', 'Tu pedido sigue reservado. Cuando quieras lo confirmamos y lo despachamos hoy mismo.'];
  if (o.status === 'confirmado') return [`${hello} Tu pedido ${o.code} ya está confirmado y lo estamos alistando.`, 'Te avisamos por aquí apenas salga con el número de guía.'];
  if (o.status === 'despachado' || o.status === 'en_reparto') return [`${hello} Tu pedido va en camino con ${o.carrier}, guía ${o.trackingNumber}.`, o.payment === 'pagado' ? 'Recuerda que ya está pago, solo debes recibirlo.' : `Recuerda tener listos ${money(o.total)} para recibirlo.`, '¿En qué horario hay alguien para recibir?'];
  if (o.status === 'novedad') return [`${hello} Vimos la novedad con tu entrega y ya la estamos resolviendo con la transportadora.`, '¿Nos confirmas la dirección completa con barrio y un punto de referencia?', 'Reprogramamos la entrega. ¿Mañana hay alguien para recibir?'];
  return [`${hello} ¿En qué te podemos ayudar?`];
}

export function HermesChats() {
  const { me } = useAuth();
  const [ball, setBall] = useState('persona');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (ball) q.set('ball', ball);
    if (search.trim()) q.set('q', search.trim());
    return `/api/hermes/chats?${q}`;
  }, [ball, search]);
  const list = useApi<{ chats: Chat[]; counts: Record<string, number> }>(path, 8000);
  const now = useNow(5000);
  const chats = list.data?.chats ?? [];
  const counts = list.data?.counts ?? {};

  // Si "Te toca" está vacío al entrar, se muestra todo para no abrir una bandeja en blanco.
  const autoSwitched = useRef(false);
  useEffect(() => {
    if (!autoSwitched.current && list.data && ball === 'persona' && !list.data.chats.length) {
      autoSwitched.current = true;
      setBall('');
    } else if (list.data) autoSwitched.current = true;
  }, [list.data, ball]);
  // Se abre la primera conversación de la lista si no hay ninguna elegida.
  useEffect(() => {
    if (!selected && chats.length) setSelected(chats[0].id);
  }, [chats, selected]);

  return (
    <>
      <div className="inbox-head">
        <div>
          <h1>Chats</h1>
          <p className="muted small">Las conversaciones del bot con cada cliente. Primero, las que llevan más tiempo esperándote.</p>
        </div>
        <div className="inbox-counts">
          <div className={`inbox-count ${counts.persona ? 'alert' : ''}`}><b>{counts.persona ?? 0}</b><span>Te toca</span></div>
          <div className="inbox-count"><b>{counts.cliente ?? 0}</b><span>Esperando al cliente</span></div>
          <div className="inbox-count"><b>{counts.proceso ?? 0}</b><span>En curso</span></div>
          <Freshness updatedAt={list.updatedAt} error={list.error} staleAfterMs={30_000} />
        </div>
      </div>

      <div className="inbox card">
        {/* ── Lista de conversaciones ── */}
        <aside className="inbox-list" aria-label="Conversaciones">
          <div className="inbox-filters">
            <input aria-label="Buscar conversación" placeholder="Buscar cliente, teléfono, pedido o guía" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="chips" role="tablist">
              {TABS.map(([v, label]) => (
                <button key={v} role="tab" aria-selected={ball === v} onClick={() => setBall(v)}>
                  {label}{v && counts[v] ? <em>{counts[v]}</em> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="inbox-items">
            {!list.data ? <Loading /> : chats.length ? chats.map((c) => (
              <button key={c.id} className={`inbox-item ${selected === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => setSelected(c.id)}>
                <span className={`chat-avatar ball-${c.ball}`} aria-hidden="true">{initials(c.customerName)}</span>
                <span className="inbox-item-body">
                  <span className="inbox-item-top">
                    <strong>{c.customerName}</strong>
                    <time className={urgency(c.waitingSince, now, c.ball)}>{c.waitingSince && c.ball !== 'cerrado' && c.ball !== 'proceso' ? waited(c.waitingSince, now) : fmtTime(c.lastAt)}</time>
                  </span>
                  <span className="inbox-item-snippet">
                    {c.lastBody ? <>{c.lastDirection === 'out' ? (c.lastSender === 'Hermes' ? 'Bot: ' : `${c.lastSender?.split(' ')[0]}: `) : ''}{c.lastBody}</> : 'Sin mensajes'}
                  </span>
                  <span className="inbox-item-tags">
                    <span className={`badge ${BALL[c.ball].tone}`}>{BALL[c.ball].label}</span>
                    <span className="xs muted">{c.code} · {ORDER_STATUS[c.status]?.label}</span>
                    {c.botPaused && <span className="xs" title="Una persona tomó esta conversación">· bot en pausa</span>}
                  </span>
                </span>
              </button>
            )) : <Empty>{search ? 'Ninguna conversación coincide.' : ball === 'persona' ? 'Nada pendiente: ninguna conversación te espera.' : 'No hay conversaciones aquí.'}</Empty>}
          </div>
        </aside>

        {selected ? <Conversation key={selected} orderId={selected} agent={me!.user.name} onChanged={() => void list.reload()} /> : (
          <div className="inbox-empty"><Empty>Elige una conversación de la lista. Cuando se cree un pedido en Hermes, su chat aparece aquí.</Empty></div>
        )}
      </div>
    </>
  );
}

function Conversation({ orderId, agent, onChanged }: { orderId: string; agent: string; onChanged: () => void }) {
  const detail = useApi(`/api/hermes/orders/${orderId}`, 4000);
  const now = useNow(5000);
  const [text, setText] = useState('');
  const [simText, setSimText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const messageCount = detail.data?.messages.length ?? 0;
  const lastInbound = detail.data?.messages.filter((m: Message) => m.direction === 'in').length ?? 0;

  // Al abrir (y cada vez que llega un mensaje del cliente) la conversación queda como vista.
  useEffect(() => {
    void api('POST', `/api/hermes/orders/${orderId}/seen`).then(onChanged).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, lastInbound]);
  // El hilo baja solo al último mensaje.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messageCount, orderId]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await detail.reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!detail.data) return <div className="inbox-empty">{detail.error ? <ErrorNote error={detail.error} /> : <Loading />}</div>;

  const { order: o, events, incidents, driver } = detail.data;
  const messages: Message[] = detail.data.messages;
  const final = ['entregado', 'devuelto', 'cancelado'].includes(o.status);
  const ball = o.attention ? 'persona' : final ? 'cerrado' : o.awaiting ? 'cliente' : 'proceso';
  const waitingSince = o.attention ? o.attentionAt : null;
  const stepIndex = STEPS.indexOf(o.status === 'novedad' ? 'en_reparto' : o.status);
  const lastButtons = [...messages].reverse().find((m) => m.direction === 'out' && m.buttons.length)?.buttons ?? [];
  // Mensajes e hitos del pedido en una sola línea de tiempo.
  const stream = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt, message: m })),
    ...(events as { id: string; at: string; type: string; detail: string; actor: string }[]).filter((e) => STREAM_EVENTS.has(e.type)).map((e) => ({ kind: 'event' as const, at: e.at, event: e })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const sendText = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    void run(() => api('POST', `/api/hermes/orders/${orderId}/message`, { body })).then(() => setText(''));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  };
  const act = (body: Record<string, unknown>) => run(() => api('POST', `/api/hermes/orders/${orderId}/action`, body));
  const simulate = (body: { text?: string; payload?: string }) => run(() => api('POST', `/api/hermes/orders/${orderId}/simulate-reply`, body));

  return (
    <>
      {/* ── Hilo ── */}
      <section className="inbox-thread" aria-label={`Conversación con ${o.customerName}`}>
        <header className="thread-head">
          <div>
            <strong>{o.customerName}</strong>
            <div className="xs muted">{o.phone} · {o.city} · Pedido {o.code}</div>
          </div>
          <div className="actions">
            <span className={`badge ${BALL[ball].tone}`} title={BALL[ball].help}>{BALL[ball].label}{waitingSince ? ` · ${waited(waitingSince, now)}` : ''}</span>
            {!final && (
              <button className={`btn sm ${o.botPaused ? 'primary' : ''}`} disabled={busy} onClick={() => void run(() => api('POST', `/api/hermes/orders/${orderId}/takeover`, { paused: !o.botPaused }))}
                title={o.botPaused ? 'El bot volverá a responder en esta conversación' : 'El bot dejará de responder aquí hasta que se la devuelvas'}>
                {o.botPaused ? 'Devolver al bot' : 'Tomar la conversación'}
              </button>
            )}
          </div>
        </header>

        {o.attention && (
          <div className="thread-alert" role="status">
            <Icon name="alert" size={16} /> <span><strong>Te toca.</strong> {o.attentionReason}</span>
            <button className="btn sm" disabled={busy} onClick={() => void act({ action: 'atendido' })}>Marcar atendido</button>
          </div>
        )}
        {o.botPaused && <div className="thread-note">El bot está en pausa en esta conversación{o.takenBy ? ` (la tomó ${o.takenBy})` : ''}. Los mensajes del cliente no reciben respuesta automática.</div>}
        <ErrorNote error={error} />

        <div className="chat thread-scroll" ref={scroller} aria-live="polite">
          {stream.map((item) => item.kind === 'event' ? (
            <div key={`e${item.event.id}`} className={`stream-event ${EVENT_TONE[item.event.type] ?? ''}`}>
              <span><strong>{EVENT_LABEL[item.event.type] ?? item.event.type}</strong>{item.event.detail && item.event.type !== 'creado' ? ` · ${item.event.detail}` : ''}</span>
              <time>{fmtTime(item.at)}</time>
            </div>
          ) : (
            <div key={item.message.id} className={`bubble ${item.message.direction} ${item.message.direction === 'out' && item.message.sender !== 'Hermes' ? 'human' : ''}`}>
              <div className="bubble-meta">{item.message.direction === 'in' ? 'Cliente' : item.message.sender === 'Hermes' ? 'Bot' : item.message.sender} · {fmtTime(item.message.createdAt)}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{item.message.body}</div>
              {item.message.buttons.length > 0 && <div className="bubble-buttons">{item.message.buttons.map((b) => <span key={b.payload}>{b.label}</span>)}</div>}
            </div>
          ))}
        </div>

        <div className="quick" aria-label="Respuestas sugeridas">
          {quickReplies(o, agent).map((r) => <button key={r} type="button" onClick={() => setText(r)} title="Rellena el cuadro de texto; revisa antes de enviar">{r}</button>)}
          {o.status === 'por_confirmar' && <button type="button" className="quick-action" disabled={busy} onClick={() => void run(() => api('POST', `/api/hermes/orders/${orderId}/resend-confirmation`))}>↻ Reenviar confirmación con botones</button>}
        </div>
        <form className="composer" onSubmit={sendText}>
          <textarea aria-label="Escribir al cliente" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Escribe como persona… (Enter envía, Mayús+Enter salta de línea)" maxLength={1000} rows={2} />
          <button className="btn primary" disabled={busy || !text.trim()}>Enviar</button>
        </form>
        {driver === 'simulado' && (
          <div className="sim">
            <strong className="xs">Modo simulado · haz de cliente para probar</strong>
            <div className="actions">
              {!final && lastButtons.map((b) => <button key={b.payload} className="btn sm" disabled={busy} onClick={() => void simulate({ payload: b.payload })}>{b.label}</button>)}
            </div>
            <form className="chat-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (simText.trim()) void simulate({ text: simText.trim() }).then(() => setSimText('')); }}>
              <input aria-label="Texto que escribiría el cliente" value={simText} onChange={(e) => setSimText(e.target.value)} placeholder="…o escribe lo que diría el cliente" maxLength={500} />
              <button className="btn sm" disabled={busy || !simText.trim()}>Simular</button>
            </form>
          </div>
        )}
      </section>

      {/* ── Contexto del pedido ── */}
      <aside className="inbox-context" aria-label="Datos del pedido">
        <div className="context-block">
          <div className="row"><h3 className="grow">Pedido {o.code}</h3><Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label}</Badge></div>
          {!['cancelado', 'devuelto'].includes(o.status) && (
            <ol className="steps compact" aria-label="Avance del pedido">
              {STEPS.map((s, i) => <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? (o.status === 'novedad' ? 'current problem' : 'current') : ''} title={ORDER_STATUS[s].label} />)}
            </ol>
          )}
          <dl className="context-data">
            <dt>Productos</dt><dd>{itemsLabel(o.items)}</dd>
            <dt>Valor</dt><dd><strong>{money(o.total)}</strong> {o.payment === 'pagado' ? '· ya pagado' : '· contraentrega'}</dd>
            <dt>Dirección</dt><dd>{o.address}, {o.city}{o.notes ? ` · ${o.notes}` : ''}</dd>
            {o.trackingNumber && <><dt>Guía</dt><dd><span className="mono">{o.trackingNumber}</span> · {o.carrier}{o.trackingUrl && <> · <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer">Rastrear</a></>}</dd></>}
            {o.sellerName && <><dt>Venta de</dt><dd>{o.sellerName}</dd></>}
            <dt>Creado</dt><dd>{fmtDateTime(o.createdAt)}</dd>
          </dl>
          {notice && <div className="alert ok" role="status">{notice}</div>}
          <div><button className="btn sm danger" onClick={() => setBlocking(true)}>Bloquear cliente</button></div>
        </div>

        {(o.addressCheck?.level !== 'completa' || o.customerRisk === 'alto' || o.customerRisk === 'medio') && !final && (
          <div className="context-block">
            <ValidationBox compact value={{ address: o.addressCheck ?? null, history: o.customerRisk && o.customerRisk !== 'nuevo' ? { risk: o.customerRisk, message: '' } : null }} />
          </div>
        )}

        {!final && (
          <div className="context-block">
            <h3>Qué sigue</h3>
            <div className="actions">
              {o.status === 'por_confirmar' && <button className="btn sm primary" disabled={busy} onClick={() => void act({ action: 'confirmar' })}>Confirmar manualmente</button>}
              {['despachado', 'novedad'].includes(o.status) && <button className="btn sm primary" disabled={busy} onClick={() => void act({ action: 'en_reparto' })}>{o.status === 'novedad' ? 'Sale de nuevo a reparto' : 'Sale a reparto'}</button>}
              {['despachado', 'en_reparto', 'novedad'].includes(o.status) && <button className="btn sm" disabled={busy} onClick={() => void act({ action: 'entregado' })}>Entregado</button>}
              <button className="btn sm" onClick={() => setManage(true)}>{o.status === 'confirmado' ? 'Despachar y enviar guía…' : 'Más acciones…'}</button>
            </div>
          </div>
        )}

        {incidents.length > 0 && (
          <div className="context-block">
            <h3>Novedades</h3>
            {incidents.map((i: { id: string; type: string; description: string; status: string; customerChoice: string; resolution: string }) => (
              <div key={i.id} className="context-incident">
                <strong>{INCIDENT_TYPE[i.type]}</strong> <Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge>
                {i.description && <div className="muted">{i.description}</div>}
                {i.customerChoice && <div>Cliente: {CUSTOMER_CHOICE[i.customerChoice]}</div>}
                {i.resolution && <div className="muted">Gestión: {i.resolution}</div>}
              </div>
            ))}
          </div>
        )}
      </aside>

      {blocking && <BlockCustomerModal phone={o.phone} name={o.customerName} onClose={() => setBlocking(false)} onSaved={() => { setBlocking(false); setNotice('Cliente bloqueado: no se le podrán crear pedidos nuevos.'); }} />}
      {manage && <OrderDetailModal orderId={orderId} onClose={() => { setManage(false); void detail.reload(); onChanged(); }} onChanged={() => { void detail.reload(); onChanged(); }} />}
    </>
  );
}
