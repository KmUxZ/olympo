// Zeus · clientes: todos los que han pedido, con su segmento, sus cifras y su ficha.
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../lib/api';
import { downloadCsv, fmtDate } from '../../lib/format';
import { Empty, ErrorNote, Loading, PageHero } from '../../components/ui';
import { money } from '../hermes/shared';
import { CustomerModal, SEGMENT, SegmentBadge, WhatsLink } from './shared';
import type { Customer } from './shared';

interface Summary {
  repurchaseDays: number;
  totals: { customers: number; buyers: number; repeat: number; value: number; averageTicket: number; repeatRate: number };
  segments: { segment: string; customers: number; value: number }[];
  opportunities: number;
  followups: { pending: number; overdue: number; done30: number; bought30: number };
}
interface Page { total: number; page: number; size: number; customers: Customer[] }

export function ZeusCustomers() {
  const summary = useApi<Summary>('/api/zeus/summary', 120_000);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [sort, setSort] = useState('reciente');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // La búsqueda espera a que se deje de escribir.
  useEffect(() => {
    const id = setTimeout(() => { setQ(search.trim()); setPage(1); }, 350);
    return () => clearTimeout(id);
  }, [search]);
  const query = useMemo(() => {
    const p = new URLSearchParams({ sort, page: String(page) });
    if (q) p.set('q', q);
    if (segment) p.set('segment', segment);
    return p;
  }, [q, segment, sort, page]);
  const list = useApi<Page>(`/api/zeus/customers?${query}`);
  const s = summary.data;
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  async function exportCsv() {
    setExporting(true);
    try {
      const p = new URLSearchParams(query);
      p.set('page', '1');
      p.set('size', '5000');
      const all = await api<Page>('GET', `/api/zeus/customers?${p}`);
      downloadCsv('clientes-zeus.csv', ['Nombre', 'WhatsApp', 'Ciudad', 'Segmento', 'Pedidos', 'Entregados', 'Devueltos', 'Cancelados', 'Valor entregado', 'Último pedido', 'Última entrega', 'Vendió', 'Etiquetas'],
        all.customers.map((c) => [c.name, c.phone, c.city, SEGMENT[c.segment]?.label ?? c.segment, c.orders, c.delivered, c.returned, c.cancelled, c.value, fmtDate(c.lastAt), c.lastDeliveredAt ? fmtDate(c.lastDeliveredAt) : '', c.sellerName ?? '', c.tags.join(', ')]));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHero
        tone="zeus"
        title="Clientes"
        subtitle="Cada cliente con todo lo que ha pedido. Las cifras salen de los pedidos de Hermes."
        kpis={[
          { label: 'Clientes', value: s?.totals.customers ?? '—' },
          { label: 'Ya recibieron un pedido', value: s?.totals.buyers ?? '—' },
          { label: 'Vuelven a comprar', value: s ? `${s.totals.repeatRate}%` : '—' },
          { label: 'Promedio por entrega', value: s ? money(s.totals.averageTicket) : '—' },
        ]}
      />
      <ErrorNote error={summary.error} />

      <div className="card card-pad stack">
        <div className="row" role="group" aria-label="Segmento">
          <button className={`btn sm ${segment === '' ? 'primary' : ''}`} onClick={() => { setSegment(''); setPage(1); }}>Todos{s ? ` · ${s.totals.customers}` : ''}</button>
          {(s?.segments ?? []).map((x) => (
            <button key={x.segment} className={`btn sm ${segment === x.segment ? 'primary' : ''}`} title={SEGMENT[x.segment]?.help} onClick={() => { setSegment(x.segment); setPage(1); }}>
              {SEGMENT[x.segment]?.label} · {x.customers}
            </button>
          ))}
        </div>
        <div className="row">
          <input className="grow" type="search" aria-label="Buscar cliente" placeholder="Buscar por nombre, ciudad o WhatsApp" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="Orden" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} style={{ width: 220 }}>
            <option value="reciente">Pedido más reciente</option>
            <option value="valor">Mayor valor entregado</option>
            <option value="pedidos">Más pedidos</option>
          </select>
          <button className="btn sm" disabled={exporting || !data?.total} onClick={() => void exportCsv()}>{exporting ? 'Preparando…' : 'Descargar CSV'}</button>
        </div>
      </div>

      <div className="card">
        <ErrorNote error={list.error} />
        {!data ? <Loading /> : data.customers.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>WhatsApp</th><th>Segmento</th><th>Pedidos</th><th>Valor entregado</th><th>Último pedido</th><th>Vendió</th><th></th></tr></thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.phone}>
                    <td><strong>{c.name}</strong><span className="sub">{c.city}{c.tags.length ? ` · ${c.tags.join(', ')}` : ''}</span></td>
                    <td><WhatsLink phone={c.phone} /></td>
                    <td><SegmentBadge segment={c.segment} />{c.pendingFollowups > 0 && <span className="sub">Seguimiento pendiente</span>}</td>
                    <td className="nowrap">{c.delivered} de {c.orders}<span className="sub">{[c.open && `${c.open} en curso`, c.returned && `${c.returned} devuelto${c.returned > 1 ? 's' : ''}`, c.cancelled && `${c.cancelled} cancelado${c.cancelled > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || 'entregados'}</span></td>
                    <td className="nowrap">{money(c.value)}</td>
                    <td className="nowrap">{fmtDate(c.lastAt)}</td>
                    <td className="small">{c.sellerName ?? '—'}</td>
                    <td><button className="btn sm" onClick={() => setOpen(c.phone)}>Ver ficha</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{q || segment ? 'Ningún cliente coincide con el filtro.' : 'Todavía no hay clientes: aparecen cuando se crea el primer pedido en Hermes.'}</Empty>
        )}
        {data && data.total > data.size && (
          <div className="card-pad row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--color-border)' }}>
            <span className="small muted">{data.total} clientes · página {page} de {pages}</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Siguiente</button>
            </div>
          </div>
        )}
      </div>
      {open && <CustomerModal phone={open} onClose={() => setOpen(null)} onChanged={() => { void list.reload(); void summary.reload(); }} />}
    </>
  );
}
