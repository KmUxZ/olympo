// Hermes · clientes bloqueados: números a los que no se les despacha más.
import { useState } from 'react';
import { api, useApi } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Empty, ErrorNote, Field, FormModal, Loading, PageHero } from '../../components/ui';

interface Blocked { phone: string; name: string; reason: string; createdAt: string; createdByName: string | null; orders: number; delivered: number; returned: number }

/** Bloquear un número. Se usa desde esta pantalla y desde un pedido o un chat. */
export function BlockCustomerModal({ phone = '', name = '', onClose, onSaved }: { phone?: string; name?: string; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const [number, setNumber] = useState(phone);
  const [who, setWho] = useState(name);
  const [reason, setReason] = useState('');
  async function save() {
    await api('POST', '/api/hermes/blocked', { phone: number, name: who, reason });
    await onSaved();
  }
  return (
    <FormModal title="Bloquear cliente" submitLabel="Bloquear" onClose={onClose} onSubmit={save}>
      <div className="row">
        <div className="grow"><Field label="WhatsApp del cliente"><input required inputMode="tel" value={number} disabled={Boolean(phone)} onChange={(e) => setNumber(e.target.value)} placeholder="300 123 4567" /></Field></div>
        <div className="grow"><Field label="Nombre (opcional)"><input maxLength={120} value={who} onChange={(e) => setWho(e.target.value)} /></Field></div>
      </div>
      <Field label="Motivo" hint="Lo verá quien intente crearle un pedido.">
        <input required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: rechazó tres pedidos seguidos" />
      </Field>
      <p className="small muted">No se le podrán crear pedidos nuevos, ni a mano ni por importación. Sus pedidos en curso no cambian. Se puede desbloquear cuando quieras.</p>
    </FormModal>
  );
}

export function HermesBlocked() {
  const list = useApi<{ blocked: Blocked[] }>('/api/hermes/blocked');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.blocked ?? [];

  async function unblock(b: Blocked) {
    if (!window.confirm(`¿Desbloquear a ${b.name || b.phone}? Se le podrán crear pedidos de nuevo.`)) return;
    setError(null);
    try {
      await api('DELETE', `/api/hermes/blocked/${b.phone}`);
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero
        tone="hermes"
        title="Clientes bloqueados"
        subtitle="Números a los que decidiste no despacharles más. Hermes impide crearles pedidos."
        kpis={[{ label: 'Bloqueados', value: rows.length }, { label: 'Devoluciones que acumulan', value: rows.reduce((n, b) => n + b.returned, 0) }]}
      >
        <button className="btn primary" onClick={() => setAdding(true)}>Bloquear un cliente</button>
      </PageHero>
      <ErrorNote error={error ?? list.error} />
      <div className="card">
        {!list.data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>Motivo</th><th>Historial</th><th>Bloqueado</th><th></th></tr></thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.phone}>
                    <td><strong>{b.name || 'Sin nombre'}</strong><span className="sub mono">{b.phone}</span></td>
                    <td style={{ maxWidth: 340 }}>{b.reason}</td>
                    <td>{b.orders} pedido(s)<span className="sub">{b.delivered} entregados · {b.returned} devueltos</span></td>
                    <td className="nowrap">{fmtDate(b.createdAt)}<span className="sub">{b.createdByName ?? ''}</span></td>
                    <td><button className="btn sm" onClick={() => void unblock(b)}>Desbloquear</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay clientes bloqueados. Puedes bloquear uno aquí, o desde su pedido o su chat cuando veas que rechaza repetidamente.</Empty>
        )}
      </div>
      {adding && (
        <BlockCustomerModal
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await list.reload();
          }}
        />
      )}
    </>
  );
}
