import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading } from '../components/ui';

interface LineConn { lineId: string; label: string; identifier: string; active: boolean; connected: boolean; pageId: string | null; status: string | null; lastSyncAt: string | null; lastError: string | null }
interface Staff { externalId: string; name: string; userId: string | null; userName: string | null }

/** Integración con Pancake: cada línea se conecta a una página y cada usuario de Pancake se empareja con una cuenta de Argos. */
export function PancakeSettings() {
  const state = useApi<{ lines: LineConn[]; staff: Staff[] }>('/api/argos/integrations/pancake');
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>('/api/users');
  const [connecting, setConnecting] = useState<LineConn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await state.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const syncNow = () =>
    run(async () => {
      const res = await api('POST', '/api/argos/integrations/pancake/sync');
      return res.failed ? `Sincronización terminada con ${res.failed} línea(s) con error.` : `Sincronización correcta (${res.ok} línea(s)).`;
    });
  const disconnect = (line: LineConn) => {
    if (!window.confirm(`¿Desconectar la línea ${line.label} de Pancake? Se borra el token guardado; las estadísticas ya traídas se conservan.`)) return;
    void run(async () => void (await api('DELETE', `/api/argos/lines/${line.lineId}/pancake`)));
  };
  const pair = (staff: Staff, userId: string) => run(async () => void (await api('PUT', '/api/argos/integrations/pancake/staff', { externalId: staff.externalId, userId: userId || null })));

  const people = (users.data?.users ?? []).filter((u) => u.status === 'active');
  const anyConnected = state.data?.lines.some((l) => l.connected);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Integración con Pancake</h2>
        <button className="btn sm" disabled={busy || !anyConnected} onClick={() => void syncNow()}>Sincronizar ahora</button>
      </div>
      <div className="card-pad stack">
        <p className="small muted">
          Trae de Pancake los mensajes atendidos y el tiempo de respuesta de cada persona, por hora. Son datos de la plataforma, no del teclado.
          Se actualizan cada 5 minutos. El token de cada página se guarda cifrado y no vuelve a mostrarse.
        </p>
        <ErrorNote error={error ?? state.error} />
        {notice && <div className="alert ok" role="status">{notice}</div>}
      </div>

      {!state.data ? <Loading /> : state.data.lines.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Línea</th><th>Página de Pancake</th><th>Estado</th><th>Última sincronización</th><th></th></tr></thead>
            <tbody>
              {state.data.lines.map((l) => (
                <tr key={l.lineId}>
                  <td><strong>{l.label}</strong><span className="sub">{l.identifier}</span></td>
                  <td className="mono">{l.pageId ?? '—'}</td>
                  <td>
                    {!l.connected ? <Badge tone="plain">Sin conectar</Badge> : l.status === 'error' ? <Badge tone="danger">Con error</Badge> : <Badge tone="ok">Conectada</Badge>}
                    {l.lastError && <span className="sub">{l.lastError}</span>}
                  </td>
                  <td>{l.lastSyncAt ? ago(l.lastSyncAt) : '—'}</td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => setConnecting(l)}>{l.connected ? 'Cambiar token' : 'Conectar'}</button>{' '}
                    {l.connected && <button className="btn sm danger" disabled={busy} onClick={() => disconnect(l)}>Desconectar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Primero crea las líneas en «Líneas»; después conecta cada una con su página de Pancake.</Empty>
      )}

      {state.data && state.data.staff.length > 0 && (
        <>
          <div className="card-head" style={{ borderTop: '1px solid var(--color-border)' }}><h3>Usuarios de Pancake</h3></div>
          <table>
            <thead><tr><th>Usuario en Pancake</th><th>Cuenta en Argos</th></tr></thead>
            <tbody>
              {state.data.staff.map((s) => (
                <tr key={s.externalId}>
                  <td><strong>{s.name}</strong></td>
                  <td>
                    <select aria-label={`Cuenta de Argos para ${s.name}`} value={s.userId ?? ''} disabled={busy} onChange={(e) => void pair(s, e.target.value)} style={{ maxWidth: 320 }}>
                      <option value="">Sin emparejar (no aparece en el dashboard)</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {connecting && (
        <ConnectModal
          line={connecting}
          onClose={() => setConnecting(null)}
          onSaved={async () => {
            setConnecting(null);
            setNotice('Línea conectada. Empareja abajo cada usuario de Pancake con su cuenta de Argos.');
            await state.reload();
          }}
        />
      )}
    </div>
  );
}

function ConnectModal({ line, onClose, onSaved }: { line: LineConn; onClose: () => void; onSaved: () => Promise<void> }) {
  const [pageId, setPageId] = useState(line.pageId ?? '');
  const [token, setToken] = useState('');
  async function save() {
    await api('PUT', `/api/argos/lines/${line.lineId}/pancake`, { pageId: pageId.trim(), token: token.trim() });
    await onSaved();
  }
  return (
    <FormModal title={`Conectar ${line.label} con Pancake`} submitLabel="Validar y conectar" onClose={onClose} onSubmit={save}>
      <Field label="Identificador de la página" hint="En Pancake: Configuración de la página. Para WhatsApp oficial empieza por waba_.">
        <input required value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="waba_1234567890" className="mono" autoComplete="off" />
      </Field>
      <Field label="Token de acceso de la página" hint="En Pancake: Configuración de la página → Herramientas → Token de acceso. Se valida al guardar y se almacena cifrado.">
        <input required type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </Field>
      <p className="small muted">Si ya usas ese token en otra integración, copia el existente: generar uno nuevo en Pancake invalida el anterior.</p>
    </FormModal>
  );
}
