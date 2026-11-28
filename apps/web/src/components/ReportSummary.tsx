// Argos · tablas de reporte para el dashboard: % conectada y reparto del tiempo por persona y por día.
// Usa el mismo reporte de la página «Reportes», con periodos rápidos en lugar de fechas a mano.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { connectedPct, dayEndIso, dayStartIso, fmtMinutes, isoDay, pctTone } from '../lib/format';
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
type PeriodKey = (typeof PERIODS)[number]['key'];

const classified = (r: Totals) => r.observedMinutes + r.noActivityMinutes + r.breakMinutes + r.noDataMinutes;
const share = (part: number, r: Totals) => (classified(r) > 0 ? Math.round((part / classified(r)) * 100) : null);
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
  const [period, setPeriod] = useState<PeriodKey>('7');
  const [tab, setTab] = useState<'persona' | 'dia'>('persona');
  const path = useMemo(() => {
    const p = PERIODS.find((x) => x.key === period)!;
    const from = isoDay(new Date(Date.now() - p.from * 86_400_000));
    const to = isoDay(new Date(Date.now() - p.to * 86_400_000));
    return `/api/argos/reports?${new URLSearchParams({ from: dayStartIso(from), to: dayEndIso(to) })}`;
  }, [period]);
  const report = useApi<Report>(path, 120_000);
  const data = report.data;
  // Por persona: primero quien menos tiempo estuvo conectada, que es a quien hay que mirar.
  const users = useMemo(() => [...(data?.byUser ?? [])].sort((a, b) => (connectedPct(classified(a), a.noDataMinutes) ?? 101) - (connectedPct(classified(b), b.noDataMinutes) ?? 101)), [data]);
  const days = useMemo(() => [...(data?.byDay ?? [])].reverse(), [data]);
  const rows: (UserRow | DayRow)[] = tab === 'persona' ? users : days;
  const all = sum(rows);

  const line = (r: Totals, first: React.ReactNode, key: string, strong = false) => {
    const connected = connectedPct(classified(r), r.noDataMinutes);
    const cell = (content: React.ReactNode) => (strong ? <strong>{content}</strong> : content);
    return (
      <tr key={key}>
        <td>{first}</td>
        <td>{cell(r.shifts)}</td>
        <td className="nowrap">{cell(fmtMinutes(r.durationMinutes))}</td>
        <td>{connected === null ? '—' : <Badge tone={pctTone(connected)}>{connected} %</Badge>}</td>
        <td>{cell(pct(share(r.observedMinutes, r)))}</td>
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
          {PERIODS.map((p) => <button key={p.key} className={`btn sm ${period === p.key ? 'primary' : ''}`} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
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
                <th title="Parte del tiempo en turno con señal de la extensión">% conectada</th>
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
        <Empty>{period === 'hoy' ? 'Aún no hay turnos cerrados hoy. Los turnos en curso se suman al cerrarse.' : 'No hay turnos en este periodo.'}</Empty>
      )}
      <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
        {all.openShifts > 0 && <><strong>{all.openShifts} turno(s) siguen en curso</strong> y aún no suman: se incluyen al cerrarse. </>}
        Los porcentajes son sobre el tiempo en turno. «Sin actividad observada» no equivale a no trabajar.
      </div>
    </div>
  );
}
