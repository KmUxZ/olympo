// Visualizaciones propias de Argos. Reglas comunes:
//  - el color nunca es el único canal: siempre hay leyenda con texto y cifras, y un texto alternativo;
//  - los colores salen de las variables --viz-* (tokens.css), validadas para distinguirse también con daltonismo;
//  - las animaciones se desactivan si la persona pidió menos movimiento.
import type { ReactNode } from 'react';
import { fmtMinutes, fmtTime, MINUTE_STATE } from '../lib/format';

export const STATE_ORDER = ['observada', 'sin_actividad', 'pausa', 'sin_datos'] as const;

export function Legend({ items }: { items: { key: string; label: string; value?: ReactNode }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.key}>
          <i className={`seg-${i.key}`} />
          {i.label}
          {i.value !== undefined && <strong>{i.value}</strong>}
        </span>
      ))}
    </div>
  );
}

/** Anillo de reparto (parte de un todo, pocas categorías) con la cifra principal en el centro. */
export function Donut({ segments, centerValue, centerLabel, size = 148 }: { segments: { key: string; label: string; value: number }[]; centerValue: ReactNode; centerLabel: string; size?: number }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 42, c = 2 * Math.PI * r, gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? 2.5 : 0;
  let offset = 0;
  return (
    <svg className="donut" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${centerLabel}: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
      <circle cx="50" cy="50" r={r} fill="none" className="donut-track" strokeWidth="11" />
      {total > 0 &&
        segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={s.key} cx="50" cy="50" r={r} fill="none" className={`donut-seg stroke-${s.key}`} strokeWidth="11"
              strokeDasharray={`${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)">
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      <text x="50" y="49" textAnchor="middle" className="donut-value">{centerValue}</text>
      <text x="50" y="62" textAnchor="middle" className="donut-label">{centerLabel}</text>
    </svg>
  );
}

interface Segment { start: string; end: string; state: string }

/**
 * Línea del día: una fila por persona con su turno de hoy sobre un eje de horas compartido.
 * Deja ver de un vistazo quién empezó cuándo, las pausas, los huecos sin datos y el momento actual.
 */
export interface TimelineMarker { at: string; label: string }
export function TeamTimeline({ rows, now, onOpen, showNow = true, single = false }: {
  rows: { key: string; name: string; note: string; segments: Segment[]; shiftId?: string; markers?: TimelineMarker[] }[];
  now: number; onOpen?: (shiftId: string) => void;
  /** false para un turno ya cerrado: no se dibuja la línea de "ahora". */
  showNow?: boolean;
  /** true para una sola fila sin columna de nombres (detalle de un turno). */
  single?: boolean;
}) {
  const starts = rows.flatMap((r) => r.segments.map((s) => new Date(s.start).getTime()));
  if (!starts.length) return null;
  const HOUR = 3600_000;
  const ends = rows.flatMap((r) => r.segments.map((s) => new Date(s.end).getTime()));
  const from = Math.floor(Math.min(...starts) / HOUR) * HOUR;
  const to = Math.max(from + (single ? HOUR : 2 * HOUR), Math.ceil(Math.max(showNow ? now : 0, ...ends) / HOUR) * HOUR);
  const pct = (t: number) => `${(Math.min(Math.max(t, from), to) - from) / (to - from) * 100}%`;
  const hours: number[] = [];
  for (let t = from; t <= to; t += HOUR) hours.push(t);
  const step = hours.length > 13 ? 2 : 1;
  return (
    <div className={`tl ${single ? 'single' : ''}`}>
      <div className="tl-row tl-axis" aria-hidden="true">
        <div className="tl-name" />
        <div className="tl-track">
          {hours.filter((_, i) => i % step === 0).map((t) => <span key={t} className="tl-tick" style={{ left: pct(t) }}>{fmtTime(t).slice(0, 5)}</span>)}
        </div>
      </div>
      {rows.map((r) => {
        const totals = STATE_ORDER.map((st) => [st, r.segments.filter((s) => s.state === st).reduce((n, s) => n + (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000, 0)] as const).filter(([, m]) => m > 0);
        const summary = totals.length ? totals.map(([st, m]) => `${MINUTE_STATE[st]} ${fmtMinutes(m)}`).join(', ') : r.note;
        return (
          <div className="tl-row" key={r.key}>
            <div className="tl-name">
              {r.shiftId && onOpen ? <button className="tl-link" onClick={() => onOpen(r.shiftId!)}>{r.name}</button> : <span>{r.name}</span>}
              <span className="sub">{r.note}</span>
            </div>
            <div className="tl-track" role="img" aria-label={`${r.name}: ${summary}`}>
              {hours.map((t) => <i key={t} className="tl-grid" style={{ left: pct(t) }} />)}
              {r.segments.map((s, i) => {
                const a = new Date(s.start).getTime(), b = new Date(s.end).getTime();
                return <i key={i} className={`tl-seg seg-${s.state}`} style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} title={`${MINUTE_STATE[s.state]} · ${fmtTime(a)}–${fmtTime(b)} (${fmtMinutes((b - a) / 60000)})`} />;
              })}
              {(r.markers ?? []).map((m, i) => (
                <span key={`m${i}`} className="tl-marker" style={{ left: pct(new Date(m.at).getTime()) }} tabIndex={0} aria-label={`${fmtTime(m.at)}: ${m.label}`}>
                  <span className="tl-marker-tip">{fmtTime(m.at)} · {m.label}</span>
                </span>
              ))}
              {showNow && <i className="tl-now" style={{ left: pct(now) }} title={`Ahora · ${fmtTime(now)}`} />}
            </div>
          </div>
        );
      })}
      <Legend items={STATE_ORDER.map((k) => ({ key: k, label: MINUTE_STATE[k] }))} />
    </div>
  );
}

/** Barra horizontal de composición (reparto del tiempo de una fila). */
export function Composition({ parts, height = 10 }: { parts: { key: string; value: number }[]; height?: number }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <span className="muted">—</span>;
  return (
    <div className="comp" style={{ height }} role="img" aria-label={parts.filter((p) => p.value > 0).map((p) => `${MINUTE_STATE[p.key]} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
      {parts.filter((p) => p.value > 0).map((p) => <i key={p.key} className={`seg-${p.key}`} style={{ flex: p.value }} title={`${MINUTE_STATE[p.key]}: ${fmtMinutes(p.value)} (${Math.round((p.value / total) * 100)}%)`} />)}
    </div>
  );
}

/** Barras apiladas por categoría (p. ej. por día), con leyenda y valor al pasar el cursor o enfocar. */
export function StackedBars({ data, height = 190 }: { data: { label: string; parts: { key: string; value: number }[] }[]; height?: number }) {
  const totals = data.map((d) => d.parts.reduce((n, p) => n + p.value, 0));
  const max = Math.max(...totals, 1);
  const top = Math.max(60, Math.ceil(max / 60) * 60);
  return (
    <div className="chart">
      <div className="chart-scale"><span>{fmtMinutes(top)}</span></div>
      <div className="chart-plot" style={{ height }}>
        {data.map((d, i) => (
          <div className="chart-col" key={d.label} tabIndex={0} aria-label={`${d.label}: ${d.parts.filter((p) => p.value > 0).map((p) => `${MINUTE_STATE[p.key]} ${fmtMinutes(p.value)}`).join(', ') || 'sin datos'}`}>
            <span className="chart-tip">
              <strong>{d.label}</strong>
              {d.parts.filter((p) => p.value > 0).map((p) => <span key={p.key}><i className={`seg-${p.key}`} />{MINUTE_STATE[p.key]}: {fmtMinutes(p.value)}</span>)}
            </span>
            <div className="chart-stack" style={{ height: `${(totals[i] / top) * 100}%` }}>
              {[...d.parts].reverse().filter((p) => p.value > 0).map((p) => <i key={p.key} className={`seg-${p.key}`} style={{ flex: p.value }} />)}
            </div>
          </div>
        ))}
      </div>
      <div className="chart-axis" aria-hidden="true">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
      <Legend items={STATE_ORDER.map((k) => ({ key: k, label: MINUTE_STATE[k] }))} />
    </div>
  );
}

/**
 * Barras por hora de una sola medida. Para comparar dos medidas de unidades distintas se usan dos de estos
 * gráficos uno junto al otro con el mismo eje de horas (nunca dos escalas en el mismo gráfico).
 */
export function HourBars({ values, unit, tone = 'teal', height = 160 }: { values: { hour: number; value: number }[]; unit: string; tone?: 'teal' | 'blue'; height?: number }) {
  const max = Math.max(...values.map((v) => v.value), 1);
  const top = Math.max(10, Math.ceil(max / 10) * 10);
  const label = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <div className="chart">
      <div className="chart-scale"><span>{top} {unit}</span></div>
      <div className="chart-plot" style={{ height }} role="img" aria-label={`Por hora: ${values.map((v) => `${label(v.hour)} ${v.value} ${unit}`).join(', ')}`}>
        {values.map((v) => (
          <div className="chart-col" key={v.hour} tabIndex={0} aria-label={`${label(v.hour)}: ${v.value} ${unit}`}>
            <span className="chart-tip"><strong>{label(v.hour)}</strong><span>{v.value} {unit}</span></span>
            <div className={`chart-bar ${tone}`} style={{ height: `${(v.value / top) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-axis" aria-hidden="true">{values.map((v) => <span key={v.hour}>{values.length > 14 && v.hour % 2 ? '' : String(v.hour).padStart(2, '0')}</span>)}</div>
    </div>
  );
}

/** Minigráfico de evolución (una serie, escala fija 0–100). El último punto va resaltado. */
export function Sparkline({ values, width = 180, height = 40, label }: { values: number[]; width?: number; height?: number; label: string }) {
  if (!values.length) return <span className="muted">—</span>;
  const pad = 5;
  const x = (i: number) => (values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2));
  const y = (v: number) => pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${values.join(', ')}`}>
      <line x1={pad} x2={width - pad} y1={y(80)} y2={y(80)} className="spark-ref" />
      {values.length > 1 && <polyline points={points} className="spark-line" fill="none" />}
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={i === last ? 4 : 2.5} className={i === last ? 'spark-last' : 'spark-dot'}>
          <title>{`Evaluación ${i + 1}: ${v} de 100`}</title>
        </circle>
      ))}
    </svg>
  );
}
