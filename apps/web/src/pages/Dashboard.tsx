import { useState } from 'react';
import { useAuth } from '../auth';
import { Link } from 'react-router-dom';
import { useApi, useNow } from '../lib/api';
import { ago, BREAK_LABEL, fmtLongDay, fmtSeconds, fmtMinutes, fmtTime, INCIDENT_LABEL, INCIDENT_STATUS, LIVE_STATE, scheduleText } from '../lib/format';
import { Badge, Empty, ErrorNote, Freshness, Loading, StatePill } from '../components/ui';
import { ShiftDetailModal } from '../components/ShiftDetail';
import { Donut, TeamTimeline } from '../components/charts';

const LIVE_KEYS = ['actividad_observada', 'sin_actividad_observada', 'en_pausa', 'sin_senal', 'fuera_de_turno'] as const;

const FEED_TEXT: Record<string, (detail: string) => string> = {
  turno_inicio: () => 'inició su turno',
  turno_fin: (d) => (d === 'automatico' ? 'turno cerrado automáticamente (sin señal)' : d === 'supervision' ? 'turno cerrado por supervisión' : 'finalizó su turno'),
  pausa_inicio: (d) => `inició una pausa (${BREAK_LABEL[d] ?? d})`,
  pausa_fin: () => 'reanudó tras la pausa',
  novedad: (d) => `reportó una novedad (${INCIDENT_LABEL[d] ?? d})`,
};

export function Dashboard() {
  const { me } = useAuth();
  const { data, error, loading, updatedAt, reload } = useApi('/api/argos/dashboard', 15_000);
  const alerts = useApi<{ alerts: { id: string; message: string; ackAt: string | null }[] }>('/api/argos/alerts', 20_000);
  const counts = useApi<{ pendingToday: number }>('/api/argos/notifications', 60_000);
  const localNow = useNow(5000);
  const [openShift, setOpenShift] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote error={error} />;

  // "Hace X" se calcula con el reloj del servidor para que no dependa del reloj de este equipo.
  const now = localNow + (new Date(data.serverTime).getTime() - (updatedAt ?? localNow));
  const c = data.counts;
  const hasChannel = data.channel?.connectedLines > 0;
  const timelineRows = (data.sellers as Row[]).map((s) => {
    const mine = (data.timelines as { userId: string; shiftId: string; status: string; segments: { start: string; end: string; state: string }[] }[]).filter((t) => t.userId === s.user.id);
    return {
      key: s.user.id,
      name: s.user.name,
      note: LIVE_STATE[s.state]?.label ?? '',
      segments: mine.flatMap((t) => t.segments),
      shiftId: (mine.find((t) => t.status === 'active') ?? mine[mine.length - 1])?.shiftId,
    };
  });

  return (
    <>
      <section className="hero" aria-label="Resumen del equipo">
        <div className="hero-main">
          <span className="live"><i />En vivo · <Freshness updatedAt={updatedAt} error={error} /></span>
          <h1>Hola, {me?.user.name.split(' ')[0]}</h1>
          <p>{fmtLongDay(new Date(now))} · {c.enTurno === 0 ? 'nadie en turno todavía' : c.enTurno === 1 ? '1 persona en turno' : `${c.enTurno} personas en turno`} de {c.total}</p>
          <div className="hero-kpis">
            <Link to="/novedades" className="hero-kpi"><b>{c.novedadesAbiertas}</b><span>Novedades abiertas</span></Link>
            <Link to="/alarmas" className="hero-kpi"><b>{alerts.data?.alerts.length ?? '—'}</b><span>Alertas abiertas</span></Link>
            <Link to="/agenda" className="hero-kpi"><b>{counts.data?.pendingToday ?? '—'}</b><span>Tareas para hoy</span></Link>
          </div>
        </div>
        <div className="hero-viz">
          <Donut centerValue={c.enTurno} centerLabel="en turno" segments={LIVE_KEYS.map((k) => ({ key: k, label: LIVE_STATE[k].label, value: c[k] }))} />
          <ul className="hero-legend">
            {LIVE_KEYS.map((k) => (
              <li key={k}><i className={`seg-${k}`} /><span>{LIVE_STATE[k].label}</span><strong>{c[k]}</strong></li>
            ))}
          </ul>
        </div>
      </section>

      {alerts.data && alerts.data.alerts.length > 0 && (
        <div className="alert danger" role="status">
          <strong>{alerts.data.alerts.length === 1 ? '1 alerta abierta' : `${alerts.data.alerts.length} alertas abiertas`}.</strong>{' '}
          {alerts.data.alerts.slice(0, 3).map((a) => a.message).join(' · ')}
          {alerts.data.alerts.length > 3 && ' · …'} <Link to="/alarmas">Ver alarmas</Link>
        </div>
      )}

      {c.sinIniciarProgramadas > 0 && !alerts.data?.alerts.length && (
        <div className="alert warn">
          {c.sinIniciarProgramadas === 1 ? '1 persona tiene' : `${c.sinIniciarProgramadas} personas tienen`} turno programado a esta hora y aún no lo {c.sinIniciarProgramadas === 1 ? 'ha' : 'han'} iniciado.
        </div>
      )}

      <div className="card rise">
        <div className="card-head">
          <h2>Línea del día</h2>
          <span className="xs muted">El turno de hoy de cada persona, sobre el mismo eje de horas</span>
        </div>
        {timelineRows.some((r) => r.segments.length) ? (
          <div className="card-pad"><TeamTimeline rows={timelineRows} now={now} onOpen={setOpenShift} /></div>
        ) : (
          <Empty>Hoy todavía no hay turnos. Aquí verás el día de cada persona: actividad, pausas y huecos sin datos.</Empty>
        )}
      </div>

      <div className="card rise">
        <div className="card-head">
          <h2>Vendedoras</h2>
          {hasChannel && (
            <span className={`xs ${data.channel.errors ? 'fresh stale' : 'muted'}`}>
              Pancake: {data.channel.errors ? `${data.channel.errors} línea(s) con error · ` : ''}{data.channel.lastSyncAt ? `datos de ${ago(data.channel.lastSyncAt, now)}` : 'pendiente de primera sincronización'}
            </span>
          )}
        </div>
        {data.sellers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Vendedora</th><th>Estado</th><th>Herramienta reciente</th><th>Último dato</th><th>Turno de hoy</th>{hasChannel && <th>Atención hoy · Pancake</th>}<th>Línea</th><th>Novedades</th><th></th></tr>
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
                    {hasChannel && (
                      <td className="nowrap">
                        {s.channel ? (
                          <>
                            {s.channel.inbox} mensajes atendidos
                            <span className="sub">Respuesta media {fmtSeconds(s.channel.avgResponseSeconds)}</span>
                          </>
                        ) : <span className="muted">Sin datos hoy</span>}
                      </td>
                    )}
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

      <HourlyChart hourly={data.hourly} now={new Date(now)} />

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

/**
 * Actividad observada del equipo por hora (hoy). Una sola serie: no necesita leyenda.
 * Cada barra admite foco y muestra su valor; debajo hay una tabla equivalente para lectores de pantalla.
 */
function HourlyChart({ hourly, now }: { hourly: { hour: number; observedMinutes: number }[]; now: Date }) {
  const withData = hourly.filter((h) => h.observedMinutes > 0);
  if (!withData.length) {
    return (
      <div className="card">
        <div className="card-head"><h2>Actividad observada por hora</h2><span className="xs muted">Hoy</span></div>
        <div className="empty">Aún no hay actividad registrada hoy. Aparecerá cuando alguien trabaje en sus herramientas con el turno iniciado.</div>
      </div>
    );
  }
  // Se muestra desde la primera hora con datos (mínimo 2 h antes) hasta la hora actual.
  const first = Math.max(0, Math.min(...withData.map((h) => h.hour)) - 1);
  const last = Math.max(now.getHours(), Math.max(...withData.map((h) => h.hour)));
  const shown = hourly.filter((h) => h.hour >= first && h.hour <= last);
  const max = Math.max(...shown.map((h) => h.observedMinutes));
  const top = Math.max(10, Math.ceil(max / 10) * 10);
  const label = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Actividad observada por hora</h2>
        <span className="xs muted">Hoy · minutos-persona con teclado o ratón en herramientas autorizadas</span>
      </div>
      <div className="chart">
        <div className="chart-scale"><span>{top} min</span></div>
        <div className="chart-plot" role="img" aria-label={`Minutos con actividad observada por hora, de ${label(first)} a ${label(last)}`}>
          {shown.map((h) => (
            <div className="chart-col" key={h.hour} tabIndex={0} aria-label={`${label(h.hour)}: ${h.observedMinutes} minutos`}>
              <span className="chart-tip">{label(h.hour)} · {h.observedMinutes} min</span>
              <div className="chart-bar" style={{ height: `${(h.observedMinutes / top) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="chart-axis" aria-hidden="true">{shown.map((h) => <span key={h.hour}>{shown.length > 14 && h.hour % 2 ? '' : String(h.hour).padStart(2, '0')}</span>)}</div>
        <table className="sr-only">
          <caption>Minutos con actividad observada por hora</caption>
          <thead><tr><th>Hora</th><th>Minutos</th></tr></thead>
          <tbody>{shown.map((h) => <tr key={h.hour}><td>{label(h.hour)}</td><td>{h.observedMinutes}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
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
  channel: { inbox: number; conversations: number; avgResponseSeconds: number | null; fetchedAt: string } | null;
}
