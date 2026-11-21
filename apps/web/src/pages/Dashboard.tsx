import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useNow } from '../lib/api';
import { ago, BREAK_LABEL, fmtMinutes, fmtTime, INCIDENT_LABEL, INCIDENT_STATUS, LIVE_STATE, scheduleText } from '../lib/format';
import { Badge, Empty, ErrorNote, Freshness, Loading, PageHead, StatePill } from '../components/ui';
import { ShiftDetailModal } from '../components/ShiftDetail';

const FEED_TEXT: Record<string, (detail: string) => string> = {
  turno_inicio: () => 'inició su turno',
  turno_fin: (d) => (d === 'automatico' ? 'turno cerrado automáticamente (sin señal)' : d === 'supervision' ? 'turno cerrado por supervisión' : 'finalizó su turno'),
  pausa_inicio: (d) => `inició una pausa (${BREAK_LABEL[d] ?? d})`,
  pausa_fin: () => 'reanudó tras la pausa',
  novedad: (d) => `reportó una novedad (${INCIDENT_LABEL[d] ?? d})`,
};

export function Dashboard() {
  const { data, error, loading, updatedAt, reload } = useApi('/api/argos/dashboard', 15_000);
  const localNow = useNow(5000);
  const [openShift, setOpenShift] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote error={error} />;

  // "Hace X" se calcula con el reloj del servidor para que no dependa del reloj de este equipo.
  const now = localNow + (new Date(data.serverTime).getTime() - (updatedAt ?? localNow));
  const c = data.counts;

  return (
    <>
      <PageHead title="Dashboard" subtitle="Estado del equipo en este momento. Se actualiza cada 15 segundos.">
        <Freshness updatedAt={updatedAt} error={error} />
        <button className="btn sm" onClick={() => void reload()}>Actualizar</button>
      </PageHead>

      <div className="stats">
        <div className="card stat"><b>{c.enTurno} <span className="small muted">de {c.total}</span></b><span>En turno</span></div>
        <div className="card stat"><b>{c.actividad_observada}</b><span>Actividad observada</span></div>
        <div className="card stat"><b>{c.sin_actividad_observada}</b><span>Sin actividad observada</span></div>
        <div className="card stat"><b>{c.en_pausa}</b><span>En pausa</span></div>
        <div className="card stat"><b>{c.sin_senal}</b><span>Sin señal</span></div>
        <div className="card stat"><b>{c.novedadesAbiertas}</b><span>Novedades abiertas</span></div>
      </div>

      {c.sinIniciarProgramadas > 0 && (
        <div className="alert warn">
          {c.sinIniciarProgramadas === 1 ? '1 persona tiene' : `${c.sinIniciarProgramadas} personas tienen`} turno programado a esta hora y aún no lo {c.sinIniciarProgramadas === 1 ? 'ha' : 'han'} iniciado.
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Vendedoras</h2></div>
        {data.sellers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Vendedora</th><th>Estado</th><th>Herramienta reciente</th><th>Último dato</th><th>Turno de hoy</th><th>Línea</th><th>Novedades</th><th></th></tr>
              </thead>
              <tbody>
                {data.sellers.map((s: Row) => (
                  <tr key={s.user.id}>
                    <td>
                      <strong>{s.user.name}</strong>
                      <span className="sub">{s.user.teamName ?? 'Sin equipo'}</span>
                    </td>
                    <td>
                      <StatePill state={s.state} />
                      <span className="sub">
                        {s.state === 'fuera_de_turno'
                          ? s.scheduledNow ? 'Programada ahora · no ha iniciado' : scheduleText(s.schedule)
                          : s.state === 'en_pausa' ? `${BREAK_LABEL[s.break?.reason ?? ''] ?? ''} · desde ${fmtTime(s.since)}`
                          : s.state === 'actividad_observada' ? `última ${ago(s.lastActivityAt, now)}`
                          : `desde ${fmtTime(s.since)} (${ago(s.since, now)})`}
                      </span>
                    </td>
                    <td>{s.lastTool ?? '—'}{s.lastActivityAt && <span className="sub">{fmtTime(s.lastActivityAt)}</span>}</td>
                    <td className="nowrap">
                      {s.shift ? (
                        <span className={s.state === 'sin_senal' ? 'fresh stale' : ''}>{ago(s.lastDataAt, now)}</span>
                      ) : '—'}
                    </td>
                    <td className="nowrap">
                      {s.shift ? (
                        <>
                          Inicio {fmtTime(s.shift.startedAt)}
                          <span className="sub">{fmtMinutes(s.observedMinutes)} con actividad · {fmtMinutes(s.breakMinutes)} en pausa</span>
                        </>
                      ) : '—'}
                    </td>
                    <td>{s.lines.length ? s.lines.map((l) => l.label).join(', ') : <span className="muted">Sin línea</span>}</td>
                    <td>{s.openIncidents > 0 ? <Badge tone="danger">{s.openIncidents} abierta{s.openIncidents > 1 ? 's' : ''}</Badge> : '—'}</td>
                    <td>{s.shift && <button className="btn sm" onClick={() => setOpenShift(s.shift!.id)}>Ver turno</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay vendedoras asignadas a tu equipo.</Empty>
        )}
        <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
          <strong>Cómo leer los estados.</strong> {LIVE_STATE.sin_actividad_observada.help} {LIVE_STATE.sin_senal.label}: {LIVE_STATE.sin_senal.help.toLowerCase()} Las ventas, mensajes y tiempos de respuesta no se infieren de estos datos.
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Novedades abiertas</h2><Link to="/novedades" className="small">Ver todas</Link></div>
          {data.openIncidents.length ? (
            <ul className="feed">
              {data.openIncidents.map((i: { id: string; userName: string; type: string; description: string; status: string; createdAt: string }) => (
                <li key={i.id}>
                  <time>{fmtTime(i.createdAt)}</time>
                  <div>
                    <strong>{i.userName}</strong> · {INCIDENT_LABEL[i.type] ?? i.type} <Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge>
                    <div className="muted">{i.description}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Sin novedades abiertas.</Empty>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h2>Actividad reciente</h2><span className="xs muted">Últimas 24 h</span></div>
          {data.feed.length ? (
            <ul className="feed">
              {data.feed.map((f: { at: string; type: string; userName: string; detail: string }, i: number) => (
                <li key={i}>
                  <time>{fmtTime(f.at)}</time>
                  <div><strong>{f.userName}</strong> {FEED_TEXT[f.type]?.(f.detail) ?? f.type}</div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Aún no hay eventos. Aparecerán cuando alguien inicie su turno desde la extensión.</Empty>
          )}
        </div>
      </div>

      {openShift && <ShiftDetailModal shiftId={openShift} onClose={() => setOpenShift(null)} onChanged={() => void reload()} />}
    </>
  );
}

interface Row {
  user: { id: string; name: string; teamName: string | null };
  state: string;
  since: string | null;
  scheduledNow: boolean;
  schedule: { weekdays: number[]; startTime: string; endTime: string } | null;
  shift: { id: string; startedAt: string } | null;
  break: { reason: string } | null;
  lastActivityAt: string | null;
  lastTool: string | null;
  lastDataAt: string | null;
  observedMinutes: number;
  breakMinutes: number;
  lines: { id: string; label: string }[];
  openIncidents: number;
}
