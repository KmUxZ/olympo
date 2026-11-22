import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHero } from '../../components/ui';
import { itemsLabel, money, OrderDetailModal, ORDER_STATUS, ValidationBox } from './shared';
import type { Validation } from './shared';
import { ImportModal } from './Import';
import { MyOrders } from './MyOrders';

interface Order { id: string; code: string; customerName: string; phone: string; city: string; items: { name: string; qty: number; free?: boolean }[]; total: number; payment: string; status: string; attention: boolean; attentionReason: string; addressCheck: { level: string } | null; customerRisk: string; sellerName: string | null; carrier: string; trackingNumber: string; createdAt: string }

const TABS: [string, string][] = [['', 'Todos'], ['atencion', 'Por atender'], ['por_confirmar', 'Por confirmar'], ['confirmado', 'Por despachar'], ['despachado', 'Despachados'], ['en_reparto', 'En reparto'], ['novedad', 'Con novedad'], ['entregado', 'Entregados'], ['devuelto', 'Devueltos'], ['cancelado', 'Cancelados']];

/** La vendedora tiene su propia pantalla: solo lo que subió y lo que debe corregir. */
export function HermesOrders() {
  const { me } = useAuth();
  return me!.user.role === 'seller' ? <MyOrders /> : <ManageOrders />;
}

function ManageOrders() {
  const { me } = useAuth();
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (tab === 'atencion') q.set('attention', '1');
    else if (tab) q.set('status', tab);
    if (search.trim()) q.set('q', search.trim());
    return `/api/hermes/orders?${q}`;
  }, [tab, search]);
  const list = useApi<{ orders: Order[]; counts: { status: string; n: number; attention: number }[] }>(path, 15_000);
  const count = (...statuses: string[]) => (list.data?.counts ?? []).filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
  const attention = (list.data?.counts ?? []).reduce((n, c) => n + c.attention, 0);

  return (
    <>
      <PageHero
        tone="hermes"
        title="Pedidos"
        subtitle="Hermes confirma cada pedido con el cliente, envía la guía y acompaña la entrega."
        kpis={[
          { label: 'Por confirmar', value: count('por_confirmar') },
          { label: 'Por atender', value: attention },
          { label: 'En camino', value: count('despachado', 'en_reparto', 'novedad') },
          { label: 'Entregados', value: count('entregado') },
        ]}
      >
        <button className="btn primary" onClick={() => setCreating(true)}>Nuevo pedido</button>
        {me!.user.role !== 'seller' && <button className="btn" onClick={() => setImporting(true)}>Importar en lote</button>}
        <Freshness updatedAt={list.updatedAt} error={list.error} />
      </PageHero>
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <div className="row">
        <div className="tabs grow" role="tablist" style={{ flexWrap: 'wrap' }}>
          {TABS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} onClick={() => setTab(v)}>
              {label}{v === 'atencion' && attention > 0 && <> <Badge tone="danger">{attention}</Badge></>}
            </button>
          ))}
        </div>
        <input aria-label="Buscar pedido" placeholder="Buscar por nombre, teléfono, pedido o guía" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
      </div>

      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : list.data.orders.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Valor</th><th>Estado</th><th>Guía</th><th>Venta de</th><th></th></tr></thead>
              <tbody>
                {list.data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap"><strong>{o.code}</strong><span className="sub">{fmtDateTime(o.createdAt)}</span></td>
                    <td>
                      {o.customerName}<span className="sub">{o.phone} · {o.city}</span>
                      {o.addressCheck && o.addressCheck.level !== 'completa' && <span className="sub" style={{ color: 'var(--color-warn)' }}>Dirección {o.addressCheck.level === 'incompleta' ? 'incompleta' : 'por revisar'}</span>}
                      {o.customerRisk === 'alto' && <span className="sub" style={{ color: 'var(--color-danger)' }}>Riesgo alto de devolución</span>}
                    </td>
                    <td style={{ maxWidth: 240 }}>{itemsLabel(o.items)}</td>
                    <td className="nowrap">{money(o.total)}{o.payment === 'pagado' && <span className="sub">Ya pagado</span>}</td>
                    <td>
                      <Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>
                      {o.attention && <span className="sub" style={{ color: 'var(--color-danger)' }}>Necesita atención: {o.attentionReason}</span>}
                    </td>
                    <td>{o.trackingNumber ? <><span className="mono">{o.trackingNumber}</span><span className="sub">{o.carrier}</span></> : '—'}</td>
                    <td>{o.sellerName ?? <span className="muted">—</span>}</td>
                    <td><button className="btn sm" onClick={() => setOpen(o.id)}>Abrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{tab || search ? 'No hay pedidos con ese filtro.' : 'Aún no hay pedidos. Crea el primero con «Nuevo pedido» y Hermes le pedirá la confirmación al cliente.'}</Empty>
        )}
      </div>

      {creating && (
        <CreateOrderModal
          canAssign={me!.user.role !== 'seller'}
          onClose={() => setCreating(false)}
          onSaved={async (res) => {
            setCreating(false);
            setNotice(res.possibleDuplicateOf ? `Pedido ${res.code} creado. Ojo: ese teléfono ya tenía abierto el pedido ${res.possibleDuplicateOf}.` : `Pedido ${res.code} creado. Hermes ya le pidió la confirmación al cliente.`);
            await list.reload();
            setOpen(res.id);
          }}
        />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onImported={() => void list.reload()} />}
      {open && <OrderDetailModal orderId={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </>
  );
}

export function CreateOrderModal({ canAssign, onClose, onSaved }: { canAssign: boolean; onClose: () => void; onSaved: (r: { id: string; code: string; possibleDuplicateOf?: string | null }) => Promise<void> }) {
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>(canAssign ? '/api/users' : null);
  const [f, setF] = useState({ customerName: '', phone: '', address: '', neighborhood: '', city: '', notes: '', payment: 'contraentrega', sellerUserId: '', externalRef: '' });
  const [items, setItems] = useState([{ name: '', qty: '1', price: '' }]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const setItem = (i: number, k: 'name' | 'qty' | 'price', v: string) => setItems(items.map((it, n) => (n === i ? { ...it, [k]: v } : it)));
  const valid = items.filter((i) => i.name.trim());
  const total = valid.reduce((n, i) => n + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);

  // Validación en vivo de los datos de entrega, un momento después de dejar de escribir.
  const [validation, setValidation] = useState<Validation | null>(null);
  useEffect(() => {
    if (!f.address.trim() && !f.phone.trim()) return setValidation(null);
    const id = setTimeout(() => {
      api('POST', '/api/hermes/validate', { address: f.address, neighborhood: f.neighborhood, city: f.city, phone: f.phone, customerName: f.customerName }).then(setValidation).catch(() => {});
    }, 450);
    return () => clearTimeout(id);
  }, [f.address, f.neighborhood, f.city, f.phone, f.customerName]);
  const blocked = Boolean(validation?.address?.issues.some((i) => i.severity === 'error'));
  const customerBlocked = Boolean(validation?.blocked);

  async function save() {
    if (!valid.length) throw new Error('Añade al menos un producto.');
    const res = await api('POST', '/api/hermes/orders', {
      ...f,
      sellerUserId: f.sellerUserId || null,
      items: valid.map((i) => ({ name: i.name.trim(), qty: Math.max(1, Math.round(Number(i.qty) || 1)), price: Math.max(0, Math.round(Number(i.price) || 0)) })),
    });
    await onSaved(res);
  }

  return (
    <FormModal title="Nuevo pedido" submitLabel="Crear y pedir confirmación" onClose={onClose} onSubmit={save} wide>
      <div className="row">
        <div className="grow"><Field label="Nombre del cliente"><input required minLength={2} value={f.customerName} onChange={set('customerName')} /></Field></div>
        <div className="grow"><Field label="WhatsApp del cliente" hint="Celular de 10 dígitos o con indicativo."><input required inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="300 123 4567" /></Field></div>
      </div>
      <div className="row">
        <div className="grow" style={{ flex: 2 }}><Field label="Dirección" hint="Calle o carrera, número y, si aplica, torre y apartamento. Ej.: Calle 10 # 5-20 apto 201"><input required minLength={5} value={f.address} onChange={set('address')} /></Field></div>
        <div className="grow"><Field label="Barrio"><input required minLength={2} maxLength={80} value={f.neighborhood} onChange={set('neighborhood')} /></Field></div>
        <div className="grow"><Field label="Ciudad"><input required minLength={2} value={f.city} onChange={set('city')} /></Field></div>
      </div>
      <ValidationBox value={validation} />
      {customerBlocked && <div className="alert danger" role="alert">Este cliente está en la lista de bloqueados: no se le puede crear el pedido. Un supervisor puede desbloquearlo en «Clientes bloqueados».</div>}
      {blocked && <div className="alert danger" role="alert">Completa la dirección para poder crear el pedido. Una dirección incompleta es la causa más frecuente de devolución.</div>}
      <Field label="Indicaciones para la entrega (opcional)"><input maxLength={300} value={f.notes} onChange={set('notes')} placeholder="Ej.: portería, dejar con el vecino, llamar antes" /></Field>

      <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <legend className="small muted">Productos</legend>
        {items.map((it, i) => (
          <div className="row" key={i}>
            <div className="grow" style={{ flex: 3 }}><input aria-label={`Producto ${i + 1}`} placeholder="Producto" value={it.name} onChange={(e) => setItem(i, 'name', e.target.value)} /></div>
            <input aria-label={`Cantidad del producto ${i + 1}`} type="number" min={1} value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} style={{ width: 80 }} />
            <input aria-label={`Precio unitario del producto ${i + 1}`} type="number" min={0} placeholder="Precio unitario" value={it.price} onChange={(e) => setItem(i, 'price', e.target.value)} style={{ width: 150 }} />
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setItems([...items, { name: '', qty: '1', price: '' }])}>Añadir producto</button>
          <strong className="grow" style={{ textAlign: 'right' }}>Total: {money(total)}</strong>
        </div>
      </fieldset>

      <div className="row">
        <div className="grow">
          <Field label="Pago">
            <select value={f.payment} onChange={set('payment')}><option value="contraentrega">Contraentrega</option><option value="pagado">Ya pagado</option></select>
          </Field>
        </div>
        {canAssign && (
          <div className="grow">
            <Field label="Venta de (opcional)">
              <select value={f.sellerUserId} onChange={set('sellerUserId')}>
                <option value="">Sin atribuir</option>
                {(users.data?.users ?? []).filter((u) => u.status === 'active' && u.role === 'seller').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          </div>
        )}
        <div className="grow"><Field label="Referencia externa (opcional)" hint="Número en tu otro sistema."><input maxLength={120} value={f.externalRef} onChange={set('externalRef')} /></Field></div>
      </div>
    </FormModal>
  );
}
