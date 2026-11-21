import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, useApi } from '../lib/api';
import { fmtDateTime, ROLE_LABEL } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, Loading, PageHead } from '../components/ui';

interface Message { id: string; body: string; createdAt: string; senderId: string; senderName: string; toUserId: string | null; toUserName: string | null; toTeamId: string | null; toTeamName: string | null; toAll: boolean; mine: boolean; read: boolean }
interface Recipients { users: { id: string; name: string; role: string }[]; teams: { id: string; name: string }[]; canAll: boolean }

export function Messages() {
  const list = useApi<{ messages: Message[] }>('/api/argos/messages', 30_000);
  const recipients = useApi<Recipients>('/api/argos/messages/recipients');
  const [target, setTarget] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Qué mensajes estaban sin leer al abrir la pantalla (para resaltarlos aunque ya se hayan marcado como leídos).
  const [fresh, setFresh] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!list.data || fresh) return;
    const unread = list.data.messages.filter((m) => !m.read).map((m) => m.id);
    setFresh(new Set(unread));
    if (unread.length) void api('POST', '/api/argos/messages/read').then(() => window.dispatchEvent(new Event('olympo:notifications')));
  }, [list.data, fresh]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!target) return setError('Elige a quién va el mensaje.');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/argos/messages', {
        body,
        toUserId: target.startsWith('u:') ? target.slice(2) : null,
        toTeamId: target.startsWith('t:') ? target.slice(2) : null,
        toAll: target === 'all',
      });
      setBody('');
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const r = recipients.data;
  const canReplyTo = (id: string) => r?.users.some((u) => u.id === id);

  return (
    <>
      <PageHead title="Mensajes" subtitle="Comunicación interna entre administración, supervisión y vendedoras." />

      <form className="card card-pad stack" onSubmit={send}>
        <ErrorNote error={error ?? recipients.error} />
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow" style={{ maxWidth: 360 }}>
            <Field label="Para">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Elige destinatario…</option>
                {r?.canAll && <option value="all">Toda la empresa</option>}
                {r && r.teams.length > 0 && <optgroup label="Equipos">{r.teams.map((t) => <option key={t.id} value={`t:${t.id}`}>Equipo {t.name}</option>)}</optgroup>}
                {r && <optgroup label="Personas">{r.users.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name} · {ROLE_LABEL[u.role]}</option>)}</optgroup>}
              </select>
            </Field>
          </div>
        </div>
        <Field label="Mensaje">
          <textarea id="message-body" required maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escribe tu mensaje" />
        </Field>
        <div><button className="btn primary" disabled={busy || !body.trim()}>{busy ? 'Enviando…' : 'Enviar'}</button></div>
      </form>

      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : list.data.messages.length ? (
          <ul className="feed">
            {list.data.messages.map((m) => (
              <li key={m.id} style={fresh?.has(m.id) ? { background: 'var(--color-info-bg)' } : undefined}>
                <time>{fmtDateTime(m.createdAt)}</time>
                <div style={{ flex: 1 }}>
                  <div>
                    <strong>{m.mine ? 'Tú' : m.senderName}</strong>
                    <span className="muted"> → {m.toAll ? 'toda la empresa' : m.toTeamName ? `equipo ${m.toTeamName}` : m.mine ? m.toUserName : 'ti'}</span>
                    {fresh?.has(m.id) && <> <Badge tone="info">Nuevo</Badge></>}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
                {!m.mine && canReplyTo(m.senderId) && (
                  <button className="btn sm" onClick={() => { setTarget(`u:${m.senderId}`); document.getElementById('message-body')?.focus(); }}>Responder</button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Aún no hay mensajes.</Empty>
        )}
      </div>
    </>
  );
}
