// Zeus · recompra: clientes que ya recibieron, llevan un tiempo sin pedir y a los que conviene volver a ofrecerles.
import { useState } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Empty, ErrorNote, Loading, PageHero } from '../../components/ui';
import { money } from '../hermes/shared';
import { CustomerModal, daysSince, FollowupModal, SegmentBadge, WhatsLink } from './shared';
import type { Customer } from './shared';

export function ZeusRepurchase() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const list = useApi<{ repurchaseDays: number; customers: Customer[] }>('/api/zeus/opportunities');
  const [chosen, setChosen] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = list.data?.customers ?? [];
  const all = rows.length > 0 && chosen.length === rows.length;
  const toggle = (phone: string) => setChosen(chosen.includes(phone) ? chosen.filter((p) => p !== phone) : [...chosen, phone]);

  async function saveDays() {
    setError(null);
    try {
      await api('PUT', '/api/zeus/settings', { repurchaseDays: Number(days) });
      setDays('');
      setChosen([]);
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero
        tone="zeus"
        title="Recompra"
        subtitle="Clientes que ya recibieron un pedido, no tienen otro en curso y llevan un tiempo sin comprar."
        kpis={[
          { label: 'Clientes para volver a ofrecer', value: list.data ? rows.length : '—' },
          { label: 'Valor que ya compraron', value: list.data ? money(rows.reduce((n, c) => n + c.value, 0)) : '—' },
          { label: 'Días desde la última entrega', value: list.data ? `${list.data.repurchaseDays}+` : '—' },
        ]}
      />
      <ErrorNote error={error ?? list.error} />
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>A quién ofrecerle hoy</h2>
            <span className="xs muted">No aparecen clientes riesgosos, bloqueados ni los que ya tienen un seguimiento pendiente.</span>
          </div>
          <button className="btn primary sm" disabled={!chosen.length} onClick={() => setCreating(true)}>Crear seguimiento{chosen.length > 1 ? `s (${chosen.length})` : chosen.length ? ' (1)' : ''}</button>
        </div>
        {!list.data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Elegir todos" checked={all} onChange={() => setChosen(all ? [] : rows.map((c) => c.phone))} /></th>
                  <th>Cliente</th><th>WhatsApp</th><th>Segmento</th><th>Entregados</th><th>Valor entregado</th><th>Última entrega</th><th>Vendió</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.phone}>
                    <td><input type="checkbox" aria-label={`Elegir a ${c.name}`} checked={chosen.includes(c.phone)} onChange={() => toggle(c.phone)} /></td>
                    <td><strong>{c.name}</strong><span className="sub">{c.city}</span></td>
                    <td><WhatsLink phone={c.phone} /></td>
                    <td><SegmentBadge segment={c.segment} /></td>
                    <td>{c.delivered}</td>
                    <td className="nowrap">{money(c.value)}</td>
                    <td className="nowrap">{c.lastDeliveredAt ? fmtDate(c.lastDeliveredAt) : '—'}<span className="sub">hace {daysSince(c.lastDeliveredAt)} días</span></td>
                    <td className="small">{c.sellerName ?? '—'}</td>
                    <td><button className="btn sm" onClick={() => setOpen(c.phone)}>Ver ficha</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nadie cumple todavía. Aparecerán cuando un cliente lleve {list.data.repurchaseDays} días o más desde su última entrega.</Empty>
        )}
      </div>

      {isAdmin && list.data && (
        <form className="card card-pad row" onSubmit={(e) => { e.preventDefault(); void saveDays(); }}>
          <label className="field" style={{ maxWidth: 340 }}>
            Proponer recompra a los cuántos días de la última entrega
            <input type="number" min={1} max={365} required value={days || list.data.repurchaseDays} onChange={(e) => setDays(e.target.value)} />
            <span className="hint">Depende de cuánto dura tu producto. Para algo que se consume en un mes, 25 a 30 días.</span>
          </label>
          <button className="btn sm" disabled={!days || Number(days) === list.data.repurchaseDays}>Guardar</button>
        </form>
      )}

      {creating && (
        <FollowupModal
          phones={chosen}
          label={chosen.length === 1 ? rows.find((c) => c.phone === chosen[0])?.name ?? '1 cliente' : `${chosen.length} clientes`}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setNotice(`Se crearon ${chosen.length} seguimiento${chosen.length === 1 ? '' : 's'}. Están en «Seguimientos».`);
            setCreating(false);
            setChosen([]);
            await list.reload();
            window.dispatchEvent(new Event('olympo:notifications'));
          }}
        />
      )}
      {open && <CustomerModal phone={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </>
  );
}
