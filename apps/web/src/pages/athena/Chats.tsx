// Athena · conversaciones: qué atiende Athena sola, cuáles esperan a una persona y un probador para hacer de cliente.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Freshness, Loading } from '../../components/ui';
import { Icon } from '../../components/Icon';

interface Row { id: string; phone: string; customerName: string; isTest: boolean; status: 'bot' | 'humano' | 'cerrada'; attention: boolean; handoffReason: string; takenBy: string; orderCode: string; lastMessageAt: string; lastBody: string | null; lastRole: string | null }
interface Counts { persona: number; attention: number; bot: number; orders: number; total: number; tests: number }
interface Msg { id: string; role: 'cliente' | 'athena' | 'persona' | 'sistema'; body: string; sender: string; meta: { mode?: 'ia' | 'guion' }; createdAt: string }
interface Detail {
  conversation: { id: string; phone: string; customerName: string; isTest: boolean; status: 'bot' | 'humano' | 'cerrada'; attention: boolean; handoffReason: string; takenBy: string; orderCode: string; draft: Record<string, string | number> };
  messages: Msg[];
}

const TABS: [string, string][] = [['', 'Todas'], ['persona', 'Con una persona'], ['bot', 'Con Athena'], ['cerrada', 'Cerradas'], ['prueba', 'Pruebas']];
const STATUS: Record<string, { label: string; tone: string }> = { bot: { label: 'La lleva Athena', tone: 'ok' }, humano: { label: 'La lleva una persona', tone: 'warn' }, cerrada: { label: 'Cerrada', tone: '' } };
const DRAFT_LABEL: [string, string][] = [['nombre', 'Nombre'], ['productos', 'Productos'], ['total', 'Valor'], ['direccion', 'Dirección'], ['barrio', 'Barrio'], ['ciudad', 'Ciudad'], ['indicaciones', 'Indicaciones']];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

export function AthenaChats() {
  const { me } = useAuth();
  const [view, setView] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (view) q.set('view', view);
    if (search.trim()) q.set('q', search.trim());
    return `/api/athena/conversations?${q}`;
  }, [view, search]);
  const list = useApi<{ conversations: Row[]; counts: Counts; aiReady: boolean }>(path, 8000);
  const rows = list.data?.conversations ?? [];
  const counts = list.data?.counts;

  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === selected)) setSelected(rows[0].id);
  }, [rows, selected]);

  /** Empieza una conversación de prueba: tú haces de cliente. */
  async function newTest() {
    setBusy(true);
    setError(null);
    try {
      const res = await api('POST', '/api/athena/simulate', { text: 'Hola' });
      setView('prueba');
      setSelected(res.conversationId);
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="inbox-head">
        <div>
          <h1>Conversaciones</h1>
          <p className="muted small">Athena atiende a los clientes y te pasa las que necesitan a una persona. Esas van primero.</p>
        </div>
        <div className="inbox-counts">
          <div className={`inbox-count ${counts?.attention ? 'alert' : ''}`}><b>{counts?.attention ?? 0}</b><span>Te esperan</span></div>
          <div className="inbox-count"><b>{counts?.bot ?? 0}</b><span>Con Athena</span></div>
          <div className="inbox-count"><b>{counts?.orders ?? 0}</b><span>Con pedido creado</span></div>
          <button className="btn primary" disabled={busy} onClick={() => void newTest()}>{busy ? 'Abriendo…' : 'Probar Athena'}</button>
          <Freshness updatedAt={list.updatedAt} error={list.error} staleAfterMs={30_000} />
        </div>
      </div>
      {list.data && !list.data.aiReady && (
        <div className="alert warn" role="status">
          <strong>La IA aún no está conectada.</strong> Athena funciona en modo básico: solo repite lo que está escrito en el catálogo y las políticas, y pasa todo lo demás a una persona. No toma pedidos sola. Se conecta al final, con las credenciales.
        </div>
      )}
      <ErrorNote error={error} />

      <div className="inbox card">
        <aside className="inbox-list" aria-label="Conversaciones">
          <div className="inbox-filters">
            <input aria-label="Buscar conversación" placeholder="Buscar cliente o teléfono" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="chips" role="tablist">
              {TABS.map(([v, label]) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>
                  {label}{v === 'persona' && counts?.persona ? <em> {counts.persona}</em> : v === 'prueba' && counts?.tests ? <em> {counts.tests}</em> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="inbox-items">
            {!list.data ? <Loading /> : rows.length ? rows.map((c) => (
              <button key={c.id} className={`inbox-item ${selected === c.id ? 'active' : ''} ${c.attention ? 'unread' : ''}`} onClick={() => setSelected(c.id)}>
                <span className={`chat-avatar ${c.attention ? 'ball-persona' : c.status === 'bot' ? 'ball-proceso' : 'ball-cliente'}`} aria-hidden="true">{initials(c.customerName || c.phone)}</span>
                <span className="inbox-item-body">
                  <span className="inbox-item-top"><strong>{c.customerName || c.phone}</strong><time>{fmtTime(c.lastMessageAt)}</time></span>
                  <span className="inbox-item-snippet">{c.lastBody ? <>{c.lastRole === 'athena' ? 'Athena: ' : c.lastRole === 'persona' ? 'Equipo: ' : ''}{c.lastBody}</> : 'Sin mensajes'}</span>
                  <span className="inbox-item-tags">
                    <span className={`badge ${c.attention ? 'danger' : STATUS[c.status].tone}`}>{c.attention ? 'Te espera' : STATUS[c.status].label}</span>
                    {c.orderCode && <span className="xs muted">Pedido {c.orderCode}</span>}
                    {c.isTest && <span className="xs muted">· prueba</span>}
                  </span>
                </span>
              </button>
            )) : (
              <Empty>
                {view === 'prueba' ? 'Aún no hay pruebas. Pulsa «Probar Athena» y escribe como si fueras un cliente.' : search ? 'Ninguna conversación coincide.' : 'Aún no hay conversaciones con clientes. Llegarán aquí cuando se conecte el número de WhatsApp; mientras tanto puedes probar Athena.'}
              </Empty>
            )}
          </div>
        </aside>

        {selected ? <Thread key={selected} id={selected} agent={me!.user.name} onChanged={() => void list.reload()} /> : (
          <div className="inbox-empty"><Empty>Elige una conversación, o pulsa «Probar Athena» para hacer de cliente.</Empty></div>
        )}
      </div>
    </>
  );
}

function Thread({ id, agent, onChanged }: { id: string; agent: string; onChanged: () => void }) {
  const detail = useApi<Detail>(`/api/athena/conversations/${id}`, 4000);
  const [text, setText] = useState('');
  const [simText, setSimText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const count = detail.data?.messages.length ?? 0;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [count]);

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
  const { conversation: c, messages } = detail.data;
  const draft = DRAFT_LABEL.filter(([k]) => c.draft[k] !== undefined && c.draft[k] !== '');

  return (
    <>
      <section className="inbox-thread" aria-label={`Conversación con ${c.customerName || c.phone}`}>
        <header className="thread-head">
          <div>
            <strong>{c.customerName || 'Cliente sin nombre'}</strong>
            <div className="xs muted">{c.phone}{c.isTest ? ' · conversación de prueba' : ''}</div>
          </div>
          <div className="actions">
            <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}{c.takenBy ? ` · ${c.takenBy}` : ''}</Badge>
            {c.status === 'bot' && <button className="btn sm" disabled={busy} onClick={() => void run(() => api('POST', `/api/athena/conversations/${id}/takeover`, { human: true }))} title="Athena dejará de responder aquí hasta que se la devuelvas">Tomar la conversación</button>}
            {c.status === 'humano' && <button className="btn sm primary" disabled={busy} onClick={() => void run(() => api('POST', `/api/athena/conversations/${id}/takeover`, { human: false }))} title="Athena volverá a responder en esta conversación">Devolver a Athena</button>}
            {c.status !== 'cerrada' && <button className="btn sm" disabled={busy} onClick={() => void run(() => api('POST', `/api/athena/conversations/${id}/close`))}>Cerrar</button>}
          </div>
        </header>

        {c.attention && <div className="thread-alert" role="status"><Icon name="alert" size={16} /> <span><strong>Te espera.</strong> {c.handoffReason}</span></div>}
        {c.status === 'humano' && !c.attention && <div className="thread-note">La lleva una persona: Athena no responde aquí hasta que se la devuelvas.</div>}
        <ErrorNote error={error} />

        <div className="chat thread-scroll" ref={scroller} aria-live="polite">
          {messages.map((m) => m.role === 'sistema' ? (
            <div key={m.id} className="stream-event"><span>{m.body}</span><time>{fmtTime(m.createdAt)}</time></div>
          ) : (
            <div key={m.id} className={`bubble ${m.role === 'cliente' ? 'in' : 'out'} ${m.role === 'persona' ? 'human' : ''}`}>
              <div className="bubble-meta">
                {m.role === 'cliente' ? 'Cliente' : m.role === 'athena' ? `${m.sender || 'Athena'}${m.meta.mode === 'guion' ? ' · modo básico, sin IA' : ' · IA'}` : m.sender} · {fmtTime(m.createdAt)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); if (text.trim()) void run(() => api('POST', `/api/athena/conversations/${id}/message`, { body: text.trim() })).then(() => setText('')); }}>
          <textarea aria-label="Escribir al cliente" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Escribe como ${agent.split(' ')[0]}. Al enviar tomas la conversación y Athena deja de responder aquí.`} maxLength={1500} rows={2} />
          <button className="btn primary" disabled={busy || !text.trim()}>Enviar</button>
        </form>
        {c.isTest && (
          <div className="sim">
            <strong className="xs">Prueba · escribe lo que diría el cliente</strong>
            <form className="chat-form" onSubmit={(e: FormEvent) => { e.preventDefault(); const t = simText.trim(); if (t) { setSimText(''); void run(() => api('POST', '/api/athena/simulate', { conversationId: id, text: t })); } }}>
              <input aria-label="Texto que escribiría el cliente" value={simText} onChange={(e) => setSimText(e.target.value)} placeholder="Ej.: ¿cuánto vale y cuánto demora el envío?" maxLength={1000} />
              <button className="btn sm" disabled={busy || !simText.trim()}>{busy ? 'Athena responde…' : 'Enviar como cliente'}</button>
            </form>
          </div>
        )}
      </section>

      <aside className="inbox-context" aria-label="Datos reunidos">
        <div className="context-block">
          <h3>Pedido en esta conversación</h3>
          {c.orderCode ? (
            <p className="small">
              {c.orderCode === 'PRUEBA' ? <>En una conversación real, Athena habría creado aquí el pedido en Hermes. Las pruebas no crean pedidos.</> : <>Athena creó el pedido <strong>{c.orderCode}</strong>. <Link to="/hermes/pedidos">Verlo en Hermes</Link></>}
            </p>
          ) : <p className="small muted">Aún no hay pedido creado.</p>}
          {draft.length > 0 ? (
            <dl className="context-data">
              {draft.flatMap(([k, label]) => [<dt key={`t${k}`}>{label}</dt>, <dd key={`d${k}`}>{k === 'total' ? `$${Number(c.draft[k]).toLocaleString('es-CO')}` : String(c.draft[k])}</dd>])}
            </dl>
          ) : <p className="small muted">Athena todavía no ha reunido datos del cliente.</p>}
        </div>
        <div className="context-block">
          <h3>Cómo decide Athena</h3>
          <p className="small muted">Responde solo con lo que está en <Link to="/athena/catalogo">Catálogo y respuestas</Link> y en los <Link to="/athena/ajustes">ajustes</Link>. Si el dato no está, pasa la conversación a una persona en vez de suponerlo.</p>
        </div>
      </aside>
    </>
  );
}
