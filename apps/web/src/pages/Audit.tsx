import { useState } from 'react';
import { useApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Empty, ErrorNote, Loading, PageHead } from '../components/ui';

const CATEGORIES: [string, string][] = [
  ['', 'Todo'],
  ['acceso.', 'Accesos'],
  ['usuario.', 'Usuarios'],
  ['equipo.', 'Equipos'],
  ['linea.', 'Líneas'],
  ['turno.', 'Turnos'],
  ['herramienta.', 'Herramientas'],
  ['novedad.', 'Novedades'],
  ['ajustes.', 'Ajustes'],
  ['datos.', 'Datos'],
];

interface Entry { id: string; actorName: string | null; action: string; summary: string; metadata: Record<string, unknown>; ip: string | null; createdAt: string }

export function Audit() {
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const log = useApi<{ entries: Entry[] }>(`/api/audit?limit=300${category ? `&action=${encodeURIComponent(category)}` : ''}`);
  return (
    <>
      <PageHead title="Auditoría" subtitle="Accesos, cambios administrativos y acciones relevantes. El registro no se puede editar." />
      <div className="tabs" role="tablist">
        {CATEGORIES.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={category === v} onClick={() => setCategory(v)}>{label}</button>
        ))}
      </div>
      <div className="card">
        {!log.data ? (log.error ? <ErrorNote error={log.error} /> : <Loading />) : log.data.entries.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Quién</th><th>Qué hizo</th><th>Acción</th><th>IP</th><th></th></tr></thead>
              <tbody>
                {log.data.entries.map((e) => {
                  const hasDetail = Object.keys(e.metadata ?? {}).length > 0;
                  return (
                    <tr key={e.id}>
                      <td className="nowrap">{fmtDateTime(e.createdAt)}</td>
                      <td>{e.actorName ?? '—'}</td>
                      <td>
                        {e.summary}
                        {expanded === e.id && <pre className="json" style={{ marginTop: 6 }}>{JSON.stringify(e.metadata, null, 2)}</pre>}
                      </td>
                      <td className="mono">{e.action}</td>
                      <td className="mono">{e.ip ?? '—'}</td>
                      <td>{hasDetail && <button className="btn sm" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>{expanded === e.id ? 'Ocultar' : 'Detalle'}</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sin registros en esta categoría.</Empty>
        )}
      </div>
    </>
  );
}
