// Hermes · vista de la vendedora: solo los pedidos que subió y las correcciones que le pidieron.
// A propósito no muestra estado del envío, guía, entregas, devoluciones ni la conversación con el cliente.
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHero } from '../../components/ui';
import { itemsLabel, money, ValidationBox } from './shared';
import type { Validation } from './shared';
import { CreateOrderModal } from './Orders';

interface MyOrder { id: string; code: string; customerName: string; phone: string; address: string; city: string; notes: string; items: { name: string; qty: number; free?: boolean }[]; total: number; payment: string; createdAt: string; needsCorrection: boolean; correctionNote: string; correctedAt: string | null }

export function MyOrders() {
  const [onlyFix, setOnlyFix] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [fixing, setFixing] = useState<MyOrder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (onlyFix) q.set('attention', '1');
    if (search.trim()) q.set('q', search.trim());
    return `/api/hermes/orders?${q}`;
  }, [onlyFix, search]);
  const list = useApi<{ orders: MyOrder[]; mine: { total: number; toFix: number } }>(path, 20_000);
  const toFix = list.data?.mine.toFix ?? 0;

  return (
    <>
      <PageHero
        tone="hermes"
        title="Mis pedidos"
        subtitle="Los pedidos que subiste. Si logística te pide corregir un dato, aparece aquí."
        kpis={[{ label: 'Pedidos subidos', value: list.data?.mine.total ?? 0 }, { label: 'Por corregir', value: toFix }]}
      >
        <button className="btn primary" onClick={() => setCreating(true)}>Nuevo pedido</button>
        <Freshness updatedAt={list.updatedAt} error={list.error} />
      </PageHero>
      {notice && <div className="alert ok" role="status">{notice}</div>}
      {toFix > 0 && <div className="alert warn" role="status"><strong>Tienes {toFix} pedido(s) por corregir.</strong> Mientras no los corrijas, no pueden seguir su camino.</div>}

      <div className="row">
        <div className="tabs grow" role="tablist">
          <button role="tab" aria-selected={!onlyFix} onClick={() => setOnlyFix(false)}>Todos</button>
          <button role="tab" aria-selected={onlyFix} onClick={() => setOnlyFix(true)}>Por corregir{toFix > 0 && <> <Badge tone="danger">{toFix}</Badge></>}</button>
        </div>
        <input aria-label="Buscar pedido" placeholder="Buscar por nombre, teléfono o pedido" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
      </div>

      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : list.data.orders.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pedido</th><th>Cliente</th><th>Dirección</th><th>Productos</th><th>Valor</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {list.data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap"><strong>{o.code}</strong><span className="sub">{fmtDateTime(o.createdAt)}</span></td>
                    <td>{o.customerName}<span className="sub">{o.phone}</span></td>
                    <td style={{ maxWidth: 260 }}>{o.address}<span className="sub">{o.city}{o.notes ? ` · ${o.notes}` : ''}</span></td>
                    <td style={{ maxWidth: 220 }}>{itemsLabel(o.items)}</td>
                    <td className="nowrap">{money(o.total)}{o.payment === 'pagado' && <span className="sub">Ya pagado</span>}</td>
                    <td style={{ maxWidth: 280 }}>
                      {o.needsCorrection ? (
                        <><Badge tone="danger">Por corregir</Badge><span className="sub" style={{ color: 'var(--color-danger)' }}>{o.correctionNote}</span></>
                      ) : (
                        <><Badge tone="ok">Recibido</Badge>{o.correctedAt && <span className="sub">Corregido {fmtDateTime(o.correctedAt)}</span>}</>
                      )}
                    </td>
                    <td>{o.needsCorrection && <button className="btn primary sm" onClick={() => setFixing(o)}>Corregir</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{onlyFix ? 'No tienes pedidos por corregir.' : search ? 'No hay pedidos con esa búsqueda.' : 'Aún no has subido pedidos. Crea el primero con «Nuevo pedido».'}</Empty>
        )}
      </div>

      {creating && (
        <CreateOrderModal
          canAssign={false}
          onClose={() => setCreating(false)}
          onSaved={async (res) => {
            setCreating(false);
            setNotice(`Pedido ${res.code} subido. Logística sigue con él desde aquí.`);
            await list.reload();
          }}
        />
      )}
      {fixing && (
        <CorrectionModal
          order={fixing}
          onClose={() => setFixing(null)}
          onSaved={async () => {
            setNotice(`Pedido ${fixing.code} corregido. Logística ya fue avisada.`);
            setFixing(null);
            await list.reload();
          }}
        />
      )}
    </>
  );
}

function CorrectionModal({ order, onClose, onSaved }: { order: MyOrder; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ customerName: order.customerName, phone: order.phone, address: order.address, city: order.city, notes: order.notes });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const [validation, setValidation] = useState<Validation | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      api('POST', '/api/hermes/validate', { address: f.address, city: f.city, phone: f.phone, customerName: f.customerName }).then(setValidation).catch(() => {});
    }, 450);
    return () => clearTimeout(id);
  }, [f.address, f.city, f.phone, f.customerName]);
  const incomplete = Boolean(validation?.address?.issues.some((i) => i.severity === 'error'));

  async function save() {
    await api('PUT', `/api/hermes/orders/${order.id}/correction`, f);
    await onSaved();
  }

  return (
    <FormModal title={`Corregir pedido ${order.code}`} submitLabel="Guardar corrección" onClose={onClose} onSubmit={save} wide>
      <div className="alert warn" role="status"><strong>Te pidieron corregir:</strong> {order.correctionNote}</div>
      <div className="row">
        <div className="grow"><Field label="Nombre del cliente"><input required minLength={2} maxLength={120} value={f.customerName} onChange={set('customerName')} /></Field></div>
        <div className="grow"><Field label="WhatsApp del cliente"><input required inputMode="tel" value={f.phone} onChange={set('phone')} /></Field></div>
      </div>
      <div className="row">
        <div className="grow" style={{ flex: 3 }}><Field label="Dirección con barrio" hint="Ej.: Calle 10 # 5-20 apto 201, barrio Centro"><input required minLength={5} maxLength={300} value={f.address} onChange={set('address')} /></Field></div>
        <div className="grow"><Field label="Ciudad"><input required minLength={2} maxLength={80} value={f.city} onChange={set('city')} /></Field></div>
      </div>
      <ValidationBox value={validation} />
      {incomplete && <div className="alert danger" role="alert">Completa la dirección para poder guardar la corrección.</div>}
      <Field label="Indicaciones para la entrega (opcional)"><input maxLength={300} value={f.notes} onChange={set('notes')} /></Field>
      <p className="small muted">Productos y valor no se cambian aquí: {itemsLabel(order.items)} · {money(order.total)}. Si hay un error en eso, avísale a tu supervisor.</p>
    </FormModal>
  );
}
