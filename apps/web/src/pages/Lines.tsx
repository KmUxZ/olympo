import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { CHANNEL_LABEL } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHead } from '../components/ui';

interface Line { id: string; label: string; channel: string; identifier: string; active: boolean; assignedUserId: string | null; assignedUserName: string | null }

export function Lines() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const lines = useApi<{ lines: Line[] }>('/api/argos/lines');
  const users = useApi<{ users: { id: string; name: string; role: string; status: string }[] }>(isAdmin ? '/api/users' : null);
  const [editing, setEditing] = useState<Line | 'new' | null>(null);

  if (!lines.data) return lines.error ? <ErrorNote error={lines.error} /> : <Loading />;
  const sellers = (users.data?.users ?? []).filter((u) => u.role === 'seller' && u.status === 'active');

  return (
    <>
      <PageHead title="Líneas" subtitle="Números o canales comerciales y a quién está asignado cada uno.">
        {isAdmin && <button className="btn primary" onClick={() => setEditing('new')}>Nueva línea</button>}
      </PageHead>
      <div className="card">
        {lines.data.lines.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Línea</th><th>Canal</th><th>Número o identificador</th><th>Asignada a</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {lines.data.lines.map((l) => (
                  <tr key={l.id}>
                    <td><strong>{l.label}</strong></td>
                    <td>{CHANNEL_LABEL[l.channel] ?? l.channel}</td>
                    <td className="mono">{l.identifier || '—'}</td>
                    <td>{l.assignedUserName ?? <span className="muted">Sin asignar</span>}</td>
                    <td>{l.active ? <Badge tone="ok">Activa</Badge> : <Badge>Inactiva</Badge>}</td>
                    <td>{isAdmin && <button className="btn sm" onClick={() => setEditing(l)}>Editar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{isAdmin ? 'Aún no hay líneas. Crea la primera y asígnala a una vendedora.' : 'Tu equipo no tiene líneas asignadas.'}</Empty>
        )}
      </div>
      {editing && (
        <LineModal
          line={editing === 'new' ? null : editing}
          sellers={sellers}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await lines.reload();
          }}
        />
      )}
    </>
  );
}

function LineModal({ line, sellers, onClose, onSaved }: { line: Line | null; sellers: { id: string; name: string }[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [label, setLabel] = useState(line?.label ?? '');
  const [channel, setChannel] = useState(line?.channel ?? 'whatsapp');
  const [identifier, setIdentifier] = useState(line?.identifier ?? '');
  const [assignedUserId, setAssignedUserId] = useState(line?.assignedUserId ?? '');
  const [active, setActive] = useState(line?.active ?? true);
  async function save() {
    const body = { label, channel, identifier, assignedUserId: assignedUserId || null, active };
    if (line) await api('PATCH', `/api/argos/lines/${line.id}`, body);
    else await api('POST', '/api/argos/lines', body);
    await onSaved();
  }
  return (
    <FormModal title={line ? `Editar línea · ${line.label}` : 'Nueva línea'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre de la línea"><input required minLength={2} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej.: Ventas 1" /></Field>
      <div className="row">
        <div className="grow">
          <Field label="Canal">
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Número o identificador"><input value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></Field>
        </div>
      </div>
      <Field label="Asignada a">
        <select value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value)}>
          <option value="">Sin asignar</option>
          {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      {line && (
        <div className="checks"><label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Línea activa</label></div>
      )}
    </FormModal>
  );
}
