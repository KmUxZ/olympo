import { DAYS } from '../lib/format';
import { Field } from './ui';

export interface ScheduleValue {
  enabled: boolean;
  weekdays: number[];
  startTime: string;
  endTime: string;
}

export const emptySchedule: ScheduleValue = { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '17:00' };

export function toScheduleValue(s?: { weekdays: number[]; startTime: string; endTime: string } | null): ScheduleValue {
  return s ? { enabled: true, weekdays: s.weekdays, startTime: s.startTime, endTime: s.endTime } : emptySchedule;
}

export function ScheduleFields({ value, onChange }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void }) {
  const toggle = (day: number) =>
    onChange({ ...value, weekdays: value.weekdays.includes(day) ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day].sort() });
  return (
    <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
      <legend className="small muted">Horario fijo (opcional)</legend>
      <div className="checks">
        <label>
          <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} /> Tiene un horario fijo todas las semanas
        </label>
      </div>
      <span className="small muted">Si subes la malla de turnos, déjalo sin marcar: la malla es la que manda. Sirve solo para quien trabaja siempre los mismos días y horas.</span>
      {value.enabled && (
        <>
          <div className="checks" role="group" aria-label="Días">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <label key={d}>
                <input type="checkbox" checked={value.weekdays.includes(d)} onChange={() => toggle(d)} /> {DAYS[d]}
              </label>
            ))}
          </div>
          <div className="row">
            <div className="grow">
              <Field label="Hora de inicio">
                <input type="time" required value={value.startTime} onChange={(e) => onChange({ ...value, startTime: e.target.value })} />
              </Field>
            </div>
            <div className="grow">
              <Field label="Hora de fin">
                <input type="time" required value={value.endTime} onChange={(e) => onChange({ ...value, endTime: e.target.value })} />
              </Field>
            </div>
          </div>
        </>
      )}
    </fieldset>
  );
}
