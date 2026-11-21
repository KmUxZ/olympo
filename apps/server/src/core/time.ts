// Utilidades de zona horaria sin dependencias (Intl).

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(timezone: string, at: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function offsetMs(timezone: string, at: Date): number {
  const p = localParts(timezone, at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Convierte una hora local de pared (año, mes, día, hora…) de una zona horaria a un instante UTC. */
export function localToUtc(timezone: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = asUtc - offsetMs(timezone, new Date(asUtc));
  return new Date(asUtc - offsetMs(timezone, new Date(first)));
}

/** Inicio del día local (00:00) de la zona horaria, como instante UTC. */
export function startOfLocalDay(timezone: string, at = new Date()): Date {
  const p = localParts(timezone, at);
  return localToUtc(timezone, p.year, p.month, p.day);
}
