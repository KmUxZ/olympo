import { useMemo, useState } from 'react';
import { useApi } from '../lib/api';
import { connectedPct, pctTone, dayEndIso, dayStartIso, downloadCsv, fmtMinutes, fmtSeconds, isoDay } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, Loading, PageHero } from '../components/ui';
import { Composition, StackedBars } from '../components/charts';

/** % conectada: tiempo clasificado menos «sin datos». */
const pctOf = (r: Pick<Totals, 'observedMinutes' | 'noActivityMinutes' | 'breakMinutes' | 'noDataMinutes'>) =>
  connectedPct(r.observedMinutes + r.noActivityMinutes + r.breakMinutes + r.noDataMinutes, r.noDataMinutes);

const parts = (r: Totals) => [
  { key: 'observada', value: r.observedMinutes },
  { key: 'sin_actividad', value: r.noActivityMinutes },
  { key: 'pausa', value: r.breakMinutes },
  { key: 'sin_datos', value: r.noDataMinutes },
];

interface Totals { shifts: number; openShifts: number; durationMinutes: number; observedMinutes: number; noActivityMinutes: number; breakMinutes: number; noDataMinutes: number; incidents: number }
interface UserRow extends Totals { userId: string; userName: string; teamName: string | null; inbox: number | null; avgResponseSeconds: number | null }
interface DayRow extends Totals { day: string }
interface Report { byUser: UserRow[]; byDay: DayRow[]; hasChannelData: boolean; generatedAt: string }

const hours = (min: number) => (min / 60).toFixed(1).replace('.', ',');

export function Reports() {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 6 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [lineId, setLineId] = useState('');
  const [tab, setTab] = useState<'persona' | 'dia'>('persona');
  const users = useApi<{ users: { id: string; name: string; role: string }[] }>('/api/users');
  const teams = useApi<{ teams: { id: string; name: string }[] }>('/api/teams');
  const lines = useApi<{ lines: { id: string; label: string }[] }>('/api/argos/lines');

  const path = useMemo(() => {
    const q = new URLSearchParams({ from: dayStartIso(from), to: dayEndIso(to) });
    if (userId) q.set('userId', userId);
    if (teamId) q.set('teamId', teamId);
    if (lineId) q.set('lineId', lineId);
    return `/api/argos/reports?${q}`;
  }, [from, to, userId, teamId, lineId]);
  const report = useApi<Report>(path);
  const data = report.data;

  const total = (rows: Totals[], key: keyof Totals) => rows.reduce((n, r) => n + r[key], 0);

  function exportCsv() {
    if (!data) return;
    if (tab === 'persona') {
      downloadCsv(`reporte-por-persona_${from}_${to}.csv`,
        ['Persona', 'Equipo', 'Turnos', '% conectada', 'Horas en turno', 'Horas con actividad observada', 'Horas sin actividad observada', 'Horas en pausa', 'Horas sin datos', 'Novedades', 'Mensajes atendidos (Pancake)', 'Respuesta media en segundos (Pancake)'],
        data.byUser.map((r) => [r.userName, r.teamName, r.shifts, pctOf(r), hours(r.durationMinutes), hours(r.observedMinutes), hours(r.noActivityMinutes), hours(r.breakMinutes), hours(r.noDataMinutes), r.incidents, r.inbox, r.avgResponseSeconds]));
    } else {
      downloadCsv(`reporte-por-dia_${from}_${to}.csv`,
        ['Día', 'Turnos', '% conectada', 'Horas en turno', 'Horas con actividad observada', 'Horas sin actividad observada', 'Horas en pausa', 'Horas sin datos', 'Novedades'],
        data.byDay.map((r) => [r.day, r.shifts, pctOf(r), hours(r.durationMinutes), hours(r.observedMinutes), hours(r.noActivityMinutes), hours(r.breakMinutes), hours(r.noDataMinutes), r.incidents]));
    }
  }

  const rows: (UserRow | DayRow)[] = data ? (tab === 'persona' ? data.byUser : data.byDay) : [];
  const open = data ? total(rows, 'openShifts') : 0;

  return (
    <>
      <PageHero kpis={[{ label: 'Turnos', value: data ? total(data.byUser, 'shifts') : '—' }, { label: 'En turno', value: data ? fmtMinutes(total(data.byUser, 'durationMinutes')) : '—' }, { label: 'Con actividad observada', value: data ? fmtMinutes(total(data.byUser, 'observedMinutes')) : '—' }]} title="Reportes" subtitle="Totales del periodo a partir de los turnos cerrados y de los datos de Pancake.">
        <button className="btn" disabled={!data || !rows.length} onClick={exportCsv}>Exportar a Excel (CSV)</button>
      </PageHero>

      <div className="card card-pad row">
        <div className="grow"><Field label="Desde"><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Hasta"><input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field></div>
        <div className="grow">
          <Field label="Persona">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todas</option>
              {(users.data?.users ?? []).filter((u) => u.role === 'seller').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Equipo">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Todos</option>
              {(teams.data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Línea">
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">Todas</option>
              {(lines.data?.lines ?? []).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {data && data.byDay.some((d) => d.durationMinutes > 0) && (
        <div className="card">
          <div className="card-head"><h2>Cómo se repartió el tiempo, por día</h2><span className="xs muted">Turnos cerrados del periodo</span></div>
          <StackedBars data={data.byDay.map((d) => ({ label: d.day.slice(8) + '/' + d.day.slice(5, 7), parts: parts(d) }))} />
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'persona'} onClick={() => setTab('persona')}>Por persona</button>
        <button role="tab" aria-selected={tab === 'dia'} onClick={() => setTab('dia')}>Por día</button>
      </div>

      <div className="card">
        <ErrorNote error={report.error} />
        {!data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tab === 'persona' ? 'Persona' : 'Día'}</th><th>Turnos</th><th>En turno</th><th title="Parte del tiempo en turno con señal de la extensión">Conectada</th><th>Reparto del tiempo</th><th>Con actividad observada</th><th>Sin actividad observada</th><th>En pausa</th><th>Sin datos</th><th>Novedades</th>
                  {tab === 'persona' && data.hasChannelData && <><th>Mensajes atendidos</th><th>Respuesta media</th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={'userId' in r ? r.userId : r.day}>
                    <td>{'userId' in r ? <><strong>{r.userName}</strong><span className="sub">{r.teamName ?? 'Sin equipo'}</span></> : <strong>{r.day}</strong>}</td>
                    <td>{r.shifts}</td>
                    <td>{fmtMinutes(r.durationMinutes)}</td>
                    <td>{pctOf(r) === null ? '—' : <Badge tone={pctTone(pctOf(r)!)}>{pctOf(r)}%</Badge>}</td>
                    <td style={{ minWidth: 150, verticalAlign: 'middle' }}><Composition parts={parts(r)} /></td>
                    <td>{fmtMinutes(r.observedMinutes)}</td>
                    <td>{fmtMinutes(r.noActivityMinutes)}</td>
                    <td>{fmtMinutes(r.breakMinutes)}</td>
                    <td>{fmtMinutes(r.noDataMinutes)}</td>
                    <td>{r.incidents}</td>
                    {tab === 'persona' && data.hasChannelData && 'userId' in r && <><td>{r.inbox ?? '—'}</td><td>{fmtSeconds(r.avgResponseSeconds)}</td></>}
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td><strong>{total(rows, 'shifts')}</strong></td>
                  <td><strong>{fmtMinutes(total(rows, 'durationMinutes'))}</strong></td>
                  <td><strong>{pctOf({ observedMinutes: total(rows, 'observedMinutes'), noActivityMinutes: total(rows, 'noActivityMinutes'), breakMinutes: total(rows, 'breakMinutes'), noDataMinutes: total(rows, 'noDataMinutes') }) === null ? '—' : `${pctOf({ observedMinutes: total(rows, 'observedMinutes'), noActivityMinutes: total(rows, 'noActivityMinutes'), breakMinutes: total(rows, 'breakMinutes'), noDataMinutes: total(rows, 'noDataMinutes') })}%`}</strong></td>
                  <td></td>
                  <td><strong>{fmtMinutes(total(rows, 'observedMinutes'))}</strong></td>
                  <td><strong>{fmtMinutes(total(rows, 'noActivityMinutes'))}</strong></td>
                  <td><strong>{fmtMinutes(total(rows, 'breakMinutes'))}</strong></td>
                  <td><strong>{fmtMinutes(total(rows, 'noDataMinutes'))}</strong></td>
                  <td><strong>{total(rows, 'incidents')}</strong></td>
                  {tab === 'persona' && data.hasChannelData && <><td><strong>{data.byUser.reduce((n, r) => n + (r.inbox ?? 0), 0)}</strong></td><td></td></>}
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay turnos en el periodo y filtros elegidos.</Empty>
        )}
        <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
          {open > 0 && <><strong>{open} turno(s) siguen en curso</strong> y aún no suman horas: se incluyen al cerrarse. </>}
          «Sin actividad observada» no equivale a no trabajar. Los reportes no incluyen conteos de teclas ni clics.
          {data?.hasChannelData ? ' Los mensajes y tiempos de respuesta provienen de Pancake.' : ' Conecta Pancake en Configuración para incluir mensajes atendidos y tiempos de respuesta.'}
        </div>
      </div>
    </>
  );
}
