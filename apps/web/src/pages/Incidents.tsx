import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { fmtDateTime, INCIDENT_LABEL, INCIDENT_STATUS } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, PageHead } from '../components/ui';
import { IncidentForm } from '../components/IncidentForm';

interface Incident { id: string; userId: string; userName: string; reportedByName: string; type: string; description: string; status: string; resolutionNote: string; lineLabel: string | null; createdAt: string; resolvedAt: string | null }

export function Incidents() {
  const { me } = useAuth();
  const canManage = me?.user.role !== 'seller';
  const [status, setStatus] = useState('');
  const list = useApi<{ incidents: Incident[] }>(`/api/argos/incidents${status ? `?status=${status}` : ''}`, 30_000);
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>(canManage ? '/api/users' : null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<Incident | null>(null);

  return (
    <>
      <PageHead title="Novedades" subtitle="Problemas operativos, ausencias, fallas de conexión y dificultades con las líneas.">
        <Freshness updatedAt={list.updatedAt} error={list.error} staleAfterMs={90_000} />
        <button className="btn primary" onClick={() => setCreating(true)}>Registrar novedad</button>
      </PageHead>
      <div className="tabs" role="tablist">
        {[['', 'Todas'], ['abierta', 'Abiertas'], ['en_curso', 'En curso'], ['resuelta', 'Resueltas']].map(([v, label]) => (
          <button key={v} role="tab" aria-selected={status === v} onClick={() => setStatus(v)}>{label}</button>
        ))}
      </div>
      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : list.data.incidents.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Persona</th><th>Tipo</th><th>Descripción</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {list.data.incidents.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap">{fmtDateTime(i.createdAt)}</td>
                    <td><strong>{i.userName}</strong>{i.reportedByName !== i.userName && <span className="sub">Registró: {i.reportedByName}</span>}</td>
                    <td>{INCIDENT_LABEL[i.type] ?? i.type}{i.lineLabel && <span className="sub">{i.lineLabel}</span>}</td>
                    <td style={{ maxWidth: 420 }}>
                      {i.description}
                      {i.resolutionNote && <span className="sub">Seguimiento: {i.resolutionNote}</span>}
                    </td>
                    <td>
                      <Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label ?? i.status}</Badge>
                      {i.resolvedAt && <span className="sub">{fmtDateTime(i.resolvedAt)}</span>}
                    </td>
                    <td>{canManage && <button className="btn sm" onClick={() => setManaging(i)}>Gestionar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay novedades{status ? ' con este estado' : ''}.</Empty>
        )}
      </div>

      {creating && (
        <IncidentForm
          people={canManage ? (users.data?.users ?? []).filter((u) => u.role === 'seller' && u.status === 'active') : undefined}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await list.reload();
          }}
        />
      )}
      {managing && (
        <ManageModal
          incident={managing}
          onClose={() => setManaging(null)}
          onSaved={async () => {
            setManaging(null);
            await list.reload();
          }}
        />
      )}
    </>
  );
}

function ManageModal({ incident, onClose, onSaved }: { incident: Incident; onClose: () => void; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState(incident.status);
  const [note, setNote] = useState(incident.resolutionNote);
  async function save() {
    await api('PATCH', `/api/argos/incidents/${incident.id}`, { status, resolutionNote: note });
    await onSaved();
  }
  return (
    <FormModal title={`Novedad de ${incident.userName}`} onClose={onClose} onSubmit={save}>
      <p className="small"><strong>{INCIDENT_LABEL[incident.type]}</strong> · {fmtDateTime(incident.createdAt)}</p>
      <p>{incident.description}</p>
      <Field label="Estado">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(INCIDENT_STATUS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="Seguimiento o solución" hint="Visible para la persona que reportó.">
        <textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormModal>
  );
}
