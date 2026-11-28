// Argos · tablas de reporte para el dashboard: % con actividad y reparto del tiempo por persona y por día.
// Usa el mismo reporte de la página «Reportes», con periodos rápidos en lugar de fechas a mano.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { dayEndIso, dayStartIso, fmtMinutes, isoDay } from '../lib/format';
import { Badge, Empty, ErrorNote, Loading } from './ui';
import { Composition } from './charts';

interface Totals { shifts: number; openShifts: number; durationMinutes: number; observedMinutes: number; noActivityMinutes: number; breakMinutes: number; noDataMinutes: number; incidents: number }
interface UserRow extends Totals { userId: string; userName: string; teamName: string | null }
interface DayRow extends Totals { day: string }
interface Report { byUser: UserRow[]; byDay: DayRow[] }

const PERIODS = [
  { key: 'hoy', label: 'Hoy', from: 0, to: 0 },
  { key: 'ayer', label: 'Ayer', from: 1, to: 1 },
  { key: '7', label: '7 días', from: 6, to: 0 },
  { key: '30', label: '30 días', from: 29, to: 0 },
] as const;
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

const classified = (r: Totals) => r.observedMinutes + r.noActivityMinutes + r.breakMinutes + r.noDataMinutes;
const share = (part: number, r: Totals) => (classified(r) > 0 ? Math.round((part / classified(r)) * 100) : null);
/** Color del % con actividad: verde desde 70 %, amarillo desde 50 %, rojo por debajo. */
const activeTone = (n: number) => (n >= 70 ? 'ok' : n >= 50 ? 'warn' : 'danger');
const pct = (n: number | null) => (n === null ? '—' : `${n} %`);
const parts = (r: Totals) => [
  { key: 'observada', value: r.observedMinutes },
  { key: 'sin_actividad', value: r.noActivityMinutes },
  { key: 'pausa', value: r.breakMinutes },
  { key: 'sin_datos', value: r.noDataMinutes },
];
const KEYS = ['shifts', 'openShifts', 'durationMinutes', 'observedMinutes', 'noActivityMinutes', 'breakMinutes', 'noDataMinutes', 'incidents'] as const;
const sum = (rows: Totals[]): Totals => Object.fromEntries(KEYS.map((k) => [k, rows.reduce((n, r) => n + r[k], 0)])) as unknown as Totals;
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

export function ReportSummary() {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(daysAgo(0));
  // El atajo queda marcado solo mientras las fechas coincidan con él.
  const period = PERIODS.find((p) => daysAgo(p.from) === from && daysAgo(p.to) === to)?.key ?? '';
  const [tab, setTab] = useState<'persona' | 'dia'>('persona');
  const path = useMemo(() => `/api/argos/reports?${new URLSearchParams({ from: dayStartIso(from), to: dayEndIso(to) })}`, [from, to]);
  const report = useApi<Report>(path, 120_000);
  const data = report.data;
  // Por persona: primero quien menos actividad tuvo, que es a quien hay que mirar.
  const users = useMemo(() => [...(data?.byUser ?? [])].sort((a, b) => (share(a.observedMinutes, a) ?? 101) - (share(b.observedMinutes, b) ?? 101)), [data]);
  const days = useMemo(() => [...(data?.byDay ?? [])].reverse(), [data]);
  const rows: (UserRow | DayRow)[] = tab === 'persona' ? users : days;
  const all = sum(rows);

  const line = (r: Totals, first: React.ReactNode, key: string, strong = false) => {
    const active = share(r.observedMinutes, r);
    const cell = (content: React.ReactNode) => (strong ? <strong>{content}</strong> : content);
    return (
      <tr key={key}>
        <td>{first}</td>
        <td>{cell(r.shifts)}</td>
        <td className="nowrap">{cell(fmtMinutes(r.durationMinutes))}</td>
        <td>{active === null ? '—' : <Badge tone={activeTone(active)}>{active} %</Badge>}</td>
        <td>{cell(pct(share(r.noActivityMinutes, r)))}</td>
        <td>{cell(pct(share(r.breakMinutes, r)))}</td>
        <td>{cell(pct(share(r.noDataMinutes, r)))}</td>
        <td style={{ minWidth: 140, verticalAlign: 'middle' }}>{strong ? null : <Composition parts={parts(r)} />}</td>
        <td>{cell(r.incidents)}</td>
      </tr>
    );
  };

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>Reporte de conexión</h2>
        <div className="row" role="group" aria-label="Periodo" style={{ flexWrap: 'wrap' }}>
          {PERIODS.map((p) => <button key={p.key} className={`btn sm ${period === p.key ? 'primary' : ''}`} aria-pressed={period === p.key} onClick={() => { setFrom(daysAgo(p.from)); setTo(daysAgo(p.to)); }}>{p.label}</button>)}
          <label className="row small" style={{ gap: 6 }}>Desde <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={{ width: 150 }} /></label>
          <label className="row small" style={{ gap: 6 }}>Hasta <input type="date" value={to} min={from} max={daysAgo(0)} onChange={(e) => e.target.value && setTo(e.target.value)} style={{ width: 150 }} /></label>
          <Link to="/reportes" className="small">Ver reporte completo</Link>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ padding: '0 16px' }}>
        <button role="tab" aria-selected={tab === 'persona'} onClick={() => setTab('persona')}>Por persona</button>
        <button role="tab" aria-selected={tab === 'dia'} onClick={() => setTab('dia')}>Por día</button>
      </div>
      <ErrorNote error={report.error} />
      {!data ? <Loading /> : rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tab === 'persona' ? 'Persona' : 'Día'}</th><th>Turnos</th><th>En turno</th>
                <th title="Tiempo con actividad observada en las herramientas de trabajo">% con actividad</th>
                <th title="Conectada, pero sin actividad observada">% sin actividad</th>
                <th>% en pausa</th>
                <th title="Sin señal de la extensión">% sin datos</th>
                <th>Reparto del tiempo</th><th>Novedades</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => ('userId' in r
                ? line(r, <><strong>{r.userName}</strong><span className="sub">{r.teamName ?? 'Sin equipo'}</span></>, r.userId)
                : line(r, <strong style={{ textTransform: 'capitalize' }}>{dayLabel(r.day)}</strong>, r.day)))}
              {rows.length > 1 && line(all, <strong>Total</strong>, 'total', true)}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{from === daysAgo(0) ? 'Aún no hay turnos cerrados hoy. Los turnos en curso se suman al cerrarse.' : 'No hay turnos en este periodo.'}</Empty>
      )}
      <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
        {all.openShifts > 0 && <><strong>{all.openShifts} turno(s) siguen en curso</strong> y aún no suman: se incluyen al cerrarse. </>}
        Los porcentajes son sobre el tiempo en turno. «Sin actividad observada» no equivale a no trabajar.
      </div>
    </div>
  );
}
