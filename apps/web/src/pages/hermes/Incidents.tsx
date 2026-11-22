import { useState } from 'react';
import { api, useApi, useNow } from '../../lib/api';
import { ago, fmtDateTime } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHero } from '../../components/ui';
import { CUSTOMER_CHOICE, INCIDENT_STATUS, INCIDENT_TYPE, OrderDetailModal } from './shared';

interface Incident { id: string; type: string; description: string; status: string; customerChoice: string; resolution: string; createdAt: string; resolvedAt: string | null; orderId: string; code: string; customerName: string; city: string; carrier: string; trackingNumber: string; address: string }

export function HermesIncidents() {
  const list = useApi<{ incidents: Incident[] }>('/api/hermes/incidents', 20_000);
  const now = useNow(30_000);
  const [open, setOpen] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Incident | null>(null);
  const all = list.data?.incidents ?? [];
  const openOnes = all.filter((i) => i.status === 'esperando_cliente' || i.status === 'por_gestionar');
  const closed = all.filter((i) => i.status === 'resuelta' || i.status === 'devolucion');
  const solved = closed.length ? Math.round((closed.filter((i) => i.status === 'resuelta').length / closed.length) * 100) : null;

  return (
    <>
      <PageHero
        tone="hermes"
        title="Novedades de entrega"
        subtitle="Lo que reporta la transportadora. Hermes le escribe al cliente el mismo día; aquí queda lo que hay que gestionar con la transportadora."
        kpis={[
          { label: 'Por gestionar', value: all.filter((i) => i.status === 'por_gestionar').length },
          { label: 'Esperando al cliente', value: all.filter((i) => i.status === 'esperando_cliente').length },
          { label: 'Resueltas sin devolución', value: solved === null ? '—' : `${solved} %` },
        ]}
      >
        <Freshness updatedAt={list.updatedAt} error={list.error} staleAfterMs={60_000} />
      </PageHero>

      <div className="card">
        <div className="card-head"><h2>Abiertas</h2></div>
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : openOnes.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pedido</th><th>Novedad</th><th>Qué dijo el cliente</th><th>Estado</th><th>Guía</th><th></th></tr></thead>
              <tbody>
                {openOnes.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.code}</strong><span className="sub">{i.customerName} · {i.city}</span></td>
                    <td>{INCIDENT_TYPE[i.type]}{i.description && <span className="sub">{i.description}</span>}<span className="sub">{ago(i.createdAt, now)}</span></td>
                    <td>{i.customerChoice ? <>{CUSTOMER_CHOICE[i.customerChoice]}{i.customerChoice === 'corrige_direccion' && <span className="sub">Nueva: {i.address}</span>}</> : <span className="muted">Aún no responde</span>}</td>
                    <td><Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge></td>
                    <td><span className="mono">{i.trackingNumber}</span><span className="sub">{i.carrier}</span></td>
                    <td className="nowrap">
                      <button className="btn sm" onClick={() => setOpen(i.orderId)}>Abrir pedido</button>{' '}
                      <button className="btn sm primary" onClick={() => setResolving(i)}>Ya la gestioné</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay novedades abiertas.</Empty>
        )}
      </div>

      {closed.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Cerradas</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pedido</th><th>Novedad</th><th>Resultado</th><th>Gestión</th><th>Cierre</th><th></th></tr></thead>
              <tbody>
                {closed.slice(0, 50).map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.code}</strong><span className="sub">{i.customerName}</span></td>
                    <td>{INCIDENT_TYPE[i.type]}</td>
                    <td><Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge></td>
                    <td>{i.resolution || '—'}</td>
                    <td className="nowrap">{fmtDateTime(i.resolvedAt)}</td>
                    <td><button className="btn sm" onClick={() => setOpen(i.orderId)}>Abrir pedido</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {resolving && (
        <ResolveModal
          incident={resolving}
          onClose={() => setResolving(null)}
          onSaved={async () => {
            setResolving(null);
            await list.reload();
          }}
        />
      )}
      {open && <OrderDetailModal orderId={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </>
  );
}

function ResolveModal({ incident, onClose, onSaved }: { incident: Incident; onClose: () => void; onSaved: () => Promise<void> }) {
  const [resolution, setResolution] = useState(incident.customerChoice === 'corrige_direccion' ? 'Dirección corregida enviada a la transportadora' : incident.customerChoice === 'reprogramar' ? 'Entrega reprogramada con la transportadora' : '');
  async function save() {
    await api('POST', `/api/hermes/incidents/${incident.id}/resolve`, { resolution });
    await onSaved();
  }
  return (
    <FormModal title={`Novedad del pedido ${incident.code}`} submitLabel="Marcar gestionada" onClose={onClose} onSubmit={save}>
      <p><strong>{INCIDENT_TYPE[incident.type]}</strong>{incident.customerChoice && <> · Cliente: {CUSTOMER_CHOICE[incident.customerChoice]}</>}</p>
      <Field label="Qué se hizo con la transportadora" hint="Queda en el historial del pedido. Cuando salga de nuevo a reparto, márcalo en el pedido.">
        <input required minLength={2} maxLength={300} value={resolution} onChange={(e) => setResolution(e.target.value)} />
      </Field>
    </FormModal>
  );
}
