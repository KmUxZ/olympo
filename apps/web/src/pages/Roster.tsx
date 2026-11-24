// Malla de turnos: el turno de cada vendedora por fecha, semana a semana.
// En un día con malla, la malla manda sobre el horario fijo. Cada celda muestra también a qué hora inició de verdad.
import { useMemo, useState } from 'react';
import { api, useApi } from '../lib/api';
import { DAYS, downloadCsv } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, Modal } from '../components/ui';

interface Person { id: string; name: string; email: string; teamName: string | null; schedule: { weekdays: number[]; startTime: string; endTime: string } | null }
interface Entry { userId: string; day: string; startTime: string | null; endTime: string | null }
interface Worked { userId: string; day: string; firstStart: string; minutes: number; open: boolean }
interface RosterData { today: string; nowMinutes: number; canEdit: boolean; people: Person[]; entries: Entry[]; worked: Worked[] }
interface Change { userId: string; day: string; startTime?: string | null; endTime?: string | null; remove?: boolean }
type Plan = { kind: 'turno'; start: string; end: string; fixed: boolean } | { kind: 'descanso' } | { kind: 'nada' };

const at = (key: string) => new Date(`${key}T12:00:00Z`);
const addDays = (key: string, n: number) => new Date(at(key).getTime() + n * 86400_000).toISOString().slice(0, 10);
const weekdayOf = (key: string) => at(key).getUTCDay();
const mondayOf = (key: string) => addDays(key, -((weekdayOf(key) + 6) % 7));
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const shortDay = (key: string) => `${Number(key.slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
const slashDay = (key: string) => `${key.slice(8)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function planOf(person: Person, day: string, entry: Entry | undefined): Plan {
  if (entry) return entry.startTime && entry.endTime ? { kind: 'turno', start: entry.startTime, end: entry.endTime, fixed: false } : { kind: 'descanso' };
  const s = person.schedule;
  return s && s.weekdays.includes(weekdayOf(day)) ? { kind: 'turno', start: s.startTime, end: s.endTime, fixed: true } : { kind: 'nada' };
}

/** Lo que pasó de verdad ese día frente a lo planeado. Solo para hoy y días pasados. */
function control(plan: Plan, w: Worked | undefined, day: string, data: RosterData): { tone: string; text: string } | null {
  if (day > data.today) return null;
  if (plan.kind !== 'turno') return w ? { tone: 'muted', text: `Trabajó · inició ${w.firstStart}` } : null;
  if (w) {
    const late = toMin(w.firstStart) - toMin(plan.start);
    return late > 5 ? { tone: 'warn', text: `Inició ${w.firstStart} · ${late} min tarde` } : { tone: 'ok', text: `Inició ${w.firstStart}` };
  }
  if (day < data.today) return { tone: 'danger', text: 'No inició turno' };
  return data.nowMinutes > toMin(plan.start) + 5 ? { tone: 'danger', text: 'No ha iniciado' } : null;
}

function useRoster(monday: string) {
  return useApi<RosterData>(`/api/argos/roster?from=${monday}&to=${addDays(monday, 6)}`, 60_000);
}

function WeekNav({ monday, onChange }: { monday: string; onChange: (m: string) => void }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn sm" onClick={() => onChange(addDays(monday, -7))} aria-label="Semana anterior">←</button>
      <strong className="nowrap">Semana del {shortDay(monday)} al {shortDay(addDays(monday, 6))}</strong>
      <button className="btn sm" onClick={() => onChange(addDays(monday, 7))} aria-label="Semana siguiente">→</button>
      <button className="btn sm" onClick={() => onChange(mondayOf(localToday()))}>Esta semana</button>
    </div>
  );
}

function Grid({ data, days, onCell }: { data: RosterData; days: string[]; onCell?: (p: Person, day: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="roster">
        <thead>
          <tr>
            <th>Vendedora</th>
            {days.map((d) => <th key={d} className={d === data.today ? 'today' : ''}>{DAYS[weekdayOf(d)]} {Number(d.slice(8))}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.people.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.name}</strong>{p.teamName && <span className="sub">{p.teamName}</span>}</td>
              {days.map((d) => {
                const plan = planOf(p, d, data.entries.find((e) => e.userId === p.id && e.day === d));
                const ctl = control(plan, data.worked.find((w) => w.userId === p.id && w.day === d), d, data);
                const body = (
                  <>
                    {plan.kind === 'turno' && <span className={`hours ${plan.fixed ? 'fixed' : ''}`}>{plan.start}–{plan.end}</span>}
                    {plan.kind === 'turno' && plan.fixed && <span className="ctl muted">horario fijo</span>}
                    {plan.kind === 'descanso' && <Badge tone="plain">Descanso</Badge>}
                    {plan.kind === 'nada' && <span className="muted">—</span>}
                    {ctl && <span className={`ctl ${ctl.tone}`}>{ctl.text}</span>}
                  </>
                );
                return (
                  <td key={d} className={d === data.today ? 'today' : ''}>
                    {onCell ? <button className="cell" onClick={() => onCell(p, d)} aria-label={`${p.name}, ${DAYS[weekdayOf(d)]} ${shortDay(d)}`}>{body}</button> : <div className="cell">{body}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RosterTab() {
  const [monday, setMonday] = useState(() => mondayOf(localToday()));
  const roster = useRoster(monday);
  const [cell, setCell] = useState<{ person: Person; day: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const data = roster.data;

  const save = async (entries: Change[]) => {
    await api('PUT', '/api/argos/roster', { entries });
    await roster.reload();
  };

  async function copyPrevious() {
    setError(null);
    setBusy(true);
    try {
      const prev = await api<RosterData>('GET', `/api/argos/roster?from=${addDays(monday, -7)}&to=${addDays(monday, -1)}`);
      if (!prev.entries.length) return setError('La semana anterior no tiene malla para copiar.');
      if (!window.confirm(`Se copiarán ${prev.entries.length} turnos de la semana anterior a esta semana. Lo que ya esté escrito en esos mismos días se reemplaza. ¿Continuar?`)) return;
      await save(prev.entries.map((e) => ({ userId: e.userId, day: addDays(e.day, 7), startTime: e.startTime, endTime: e.endTime })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <WeekNav monday={monday} onChange={setMonday} />
          {data?.canEdit && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" disabled={busy} onClick={() => void copyPrevious()}>Copiar semana anterior</button>
              <button className="btn sm primary" onClick={() => setUploading(true)}>Subir malla</button>
            </div>
          )}
        </div>
        <ErrorNote error={error ?? roster.error} />
        {!data ? <Loading /> : data.people.length ? <Grid data={data} days={days} onCell={data.canEdit ? (person, day) => setCell({ person, day }) : undefined} /> : <Empty>No hay vendedoras activas.</Empty>}
        <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
          {data?.canEdit ? 'Pulsa una celda para cambiarla. ' : ''}
          La malla manda sobre el horario fijo en ese día; donde no hay malla, se aplica el horario fijo. Debajo de cada turno aparece la hora real de inicio: se marca tarde después de 5 minutos.
        </div>
      </div>
      {cell && data && (
        <CellModal
          person={cell.person}
          day={cell.day}
          days={days}
          entry={data.entries.find((e) => e.userId === cell.person.id && e.day === cell.day)}
          onClose={() => setCell(null)}
          onSave={async (entries) => {
            await save(entries);
            setCell(null);
          }}
        />
      )}
      {uploading && data && (
        <UploadModal
          data={data}
          days={days}
          onClose={() => setUploading(false)}
          onSave={async (entries) => {
            await save(entries);
            const first = entries.map((e) => e.day).sort()[0];
            if (first) setMonday(mondayOf(first));
          }}
        />
      )}
    </>
  );
}

function CellModal({ person, day, days, entry, onClose, onSave }: { person: Person; day: string; days: string[]; entry?: Entry; onClose: () => void; onSave: (entries: Change[]) => Promise<void> }) {
  const [mode, setMode] = useState<'turno' | 'descanso' | 'fijo'>(entry ? (entry.startTime ? 'turno' : 'descanso') : 'turno');
  const [start, setStart] = useState(entry?.startTime ?? person.schedule?.startTime ?? '08:00');
  const [end, setEnd] = useState(entry?.endTime ?? person.schedule?.endTime ?? '17:00');
  const [chosen, setChosen] = useState<string[]>([day]);
  const toggle = (d: string) => setChosen(chosen.includes(d) ? chosen.filter((x) => x !== d) : [...chosen, d]);
  async function submit() {
    if (!chosen.length) throw new Error('Elige al menos un día.');
    if (mode === 'turno' && start === end) throw new Error('La hora de inicio y la de fin no pueden ser iguales.');
    await onSave(chosen.map((d) => (mode === 'fijo' ? { userId: person.id, day: d, remove: true } : { userId: person.id, day: d, startTime: mode === 'turno' ? start : null, endTime: mode === 'turno' ? end : null })));
  }
  return (
    <FormModal title={`${person.name} · ${DAYS[weekdayOf(day)]} ${shortDay(day)}`} onClose={onClose} onSubmit={submit}>
      <div className="checks" role="radiogroup" aria-label="Qué hace ese día">
        <label><input type="radio" name="modo" checked={mode === 'turno'} onChange={() => setMode('turno')} /> Tiene turno</label>
        <label><input type="radio" name="modo" checked={mode === 'descanso'} onChange={() => setMode('descanso')} /> Descanso</label>
        <label><input type="radio" name="modo" checked={mode === 'fijo'} onChange={() => setMode('fijo')} /> Usar horario fijo</label>
      </div>
      {mode === 'turno' && (
        <div className="row">
          <div className="grow"><Field label="Hora de inicio"><input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></Field></div>
          <div className="grow"><Field label="Hora de fin"><input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></Field></div>
        </div>
      )}
      <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <legend className="small muted">Aplicar a estos días de la semana</legend>
        <div className="checks">
          {days.map((d) => <label key={d}><input type="checkbox" checked={chosen.includes(d)} onChange={() => toggle(d)} /> {DAYS[weekdayOf(d)]} {Number(d.slice(8))}</label>)}
        </div>
      </fieldset>
    </FormModal>
  );
}

// ───────── Carga desde Excel ─────────
const WEEKDAY_NAMES: Record<string, number> = { domingo: 0, dom: 0, lunes: 1, lun: 1, martes: 2, mar: 2, miercoles: 3, mie: 3, jueves: 4, jue: 4, viernes: 5, vie: 5, sabado: 6, sab: 6 };
const valid = (y: number, m: number, d: number) => {
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${key}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDate() === d && date.getUTCMonth() === m - 1 ? key : null;
};

/** Fecha de un encabezado: 2026-11-23, 23/11/2026, 23/11, 23-nov o el nombre del día (se toma de la semana que se está viendo). */
function parseHeaderDay(raw: string, weekDays: string[]): string | null {
  const t = plain(raw);
  const year = Number(weekDays[0].slice(0, 4));
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (m) return valid(m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year, Number(m[2]), Number(m[1]));
  m = t.match(/(\d{1,2})[ -/]?(?:de )?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/);
  if (m) return valid(year, MONTHS.indexOf(m[2]) + 1, Number(m[1]));
  const word = t.split(' ')[0];
  if (word in WEEKDAY_NAMES) return weekDays.find((d) => weekdayOf(d) === WEEKDAY_NAMES[word]) ?? null;
  return null;
}

/** Una celda: "8-17", "08:00 - 17:00", "8am a 5pm", "Descanso", "Fijo" o vacía (no cambia nada). */
function parseCell(raw: string): { startTime: string | null; endTime: string | null; remove?: boolean } | 'vacia' | 'error' {
  const t = plain(raw).replace(/\./g, '').replace(/\s+/g, '');
  if (!t || t === '-') return 'vacia';
  if (/^(descanso|descansa|libre|d|off|x|no)$/.test(t)) return { startTime: null, endTime: null };
  if (t === 'fijo') return { startTime: null, endTime: null, remove: true };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?(?:-|–|—|a|hasta)(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?$/);
  if (!m) return 'error';
  const time = (h: string, min: string | undefined, half: string | undefined) => {
    let hour = Number(h);
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const minute = Number(min ?? 0);
    return hour > 23 || minute > 59 ? null : `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };
  const startTime = time(m[1], m[2], m[3]);
  const endTime = time(m[4], m[5], m[6]);
  return !startTime || !endTime || startTime === endTime ? 'error' : { startTime, endTime };
}

function splitLine(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t').map((c) => c.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseRoster(text: string, people: Person[], weekDays: string[]): { entries: Change[]; errors: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { entries: [], errors: ['Faltan filas: la primera debe traer las fechas y las siguientes una vendedora cada una.'] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const head = splitLine(lines[0], sep);
  const errors: string[] = [];
  const colDays = head.slice(1).map((h) => (h ? parseHeaderDay(h, weekDays) : null));
  head.slice(1).forEach((h, i) => { if (h && !colDays[i]) errors.push(`No entiendo la fecha del encabezado «${h}». Usa 23/11/2026 o el nombre del día.`); });
  if (!colDays.some(Boolean)) return { entries: [], errors: errors.length ? errors : ['La primera fila debe traer las fechas de cada columna.'] };

  const byKey = new Map<string, Change>();
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, sep);
    const who = plain(cells[0] ?? '');
    if (!who) continue;
    const matches = people.filter((p) => plain(p.name) === who || p.email.toLowerCase() === who);
    if (matches.length !== 1) {
      errors.push(matches.length ? `Hay más de una vendedora llamada «${cells[0]}»: usa su correo.` : `No encuentro a «${cells[0]}» entre las vendedoras activas.`);
      continue;
    }
    colDays.forEach((day, i) => {
      if (!day) return;
      const parsed = parseCell(cells[i + 1] ?? '');
      if (parsed === 'vacia') return;
      if (parsed === 'error') return void errors.push(`${matches[0].name}, ${slashDay(day)}: no entiendo «${cells[i + 1]}». Escribe por ejemplo 08:00-17:00 o Descanso.`);
      byKey.set(`${matches[0].id}|${day}`, { userId: matches[0].id, day, ...parsed });
    });
  }
  return { entries: [...byKey.values()], errors };
}

function UploadModal({ data, days, onClose, onSave }: { data: RosterData; days: string[]; onClose: () => void; onSave: (entries: Change[]) => Promise<void> }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ entries: Change[]; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const review = (source = text) => {
    setError(null);
    if (!source.trim()) return setError('Pega la malla desde Excel o elige un archivo.');
    setParsed(parseRoster(source, data.people, days));
  };
  async function loadFile(file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    setText(content);
    review(content);
  }
  async function run() {
    if (!parsed?.entries.length) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed.entries);
      setDone(parsed.entries.length);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const template = () =>
    downloadCsv(
      `malla-turnos-${days[0]}.csv`,
      ['Vendedora', ...days.map(slashDay)],
      data.people.map((p) => [p.name, ...days.map((d) => {
        const plan = planOf(p, d, data.entries.find((e) => e.userId === p.id && e.day === d));
        return plan.kind === 'turno' ? `${plan.start}-${plan.end}` : plan.kind === 'descanso' ? 'Descanso' : '';
      })]),
    );
  const peopleCount = parsed ? new Set(parsed.entries.map((e) => e.userId)).size : 0;

  return (
    <Modal title="Subir malla de turnos" onClose={onClose} wide>
      <div className="modal-body">
        <ErrorNote error={error} />
        {done !== null ? (
          <div className="alert ok" role="status">Se guardaron {done} turnos en la malla.</div>
        ) : (
          <>
            <p className="small muted">
              Una fila por vendedora y una columna por fecha. La primera fila trae las fechas (23/11/2026) o los nombres de los días; la primera columna, el nombre o el correo de la vendedora.
              En cada celda: <strong>08:00-17:00</strong>, <strong>Descanso</strong>, o vacía para no cambiar ese día.
            </p>
            <div className="row">
              <button type="button" className="btn sm" onClick={template}>Descargar plantilla de esta semana</button>
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                Elegir archivo CSV
                <input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
              </label>
            </div>
            <Field label="O pega aquí las celdas copiadas desde Excel">
              <textarea rows={7} value={text} onChange={(e) => { setText(e.target.value); setParsed(null); }} placeholder={'Vendedora\tLunes\tMartes\tMiércoles\nSandra Benitez\t08:00-17:00\t08:00-17:00\tDescanso'} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} />
            </Field>
            {parsed && (
              <>
                <div className={`alert ${parsed.entries.length ? (parsed.errors.length ? 'warn' : 'ok') : 'danger'}`} role="status">
                  {parsed.entries.length ? `${parsed.entries.length} turnos de ${peopleCount} vendedora${peopleCount === 1 ? '' : 's'} listos para guardar.` : 'No hay ningún turno para guardar.'}
                  {parsed.errors.length > 0 && ` ${parsed.errors.length} dato${parsed.errors.length === 1 ? '' : 's'} con problema: no se guardan.`}
                </div>
                {parsed.errors.length > 0 && (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {parsed.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}
                    {parsed.errors.length > 12 && <li>… y {parsed.errors.length - 12} más.</li>}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>{done !== null ? 'Cerrar' : 'Cancelar'}</button>
        {done === null && (parsed?.entries.length
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? 'Guardando…' : `Guardar ${parsed.entries.length} turnos`}</button>
          : <button type="button" className="btn primary" onClick={() => review()}>Revisar</button>)}
      </div>
    </Modal>
  );
}

/** La malla de la semana de quien inició sesión (vista de la vendedora). */
export function MyWeek() {
  const [monday, setMonday] = useState(() => mondayOf(localToday()));
  const roster = useRoster(monday);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  if (!roster.data || !roster.data.people.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>Mi malla de turnos</h2><WeekNav monday={monday} onChange={setMonday} /></div>
      <Grid data={roster.data} days={days} />
    </div>
  );
}
