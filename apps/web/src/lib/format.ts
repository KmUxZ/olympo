export const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', supervisor: 'Supervisor', seller: 'Vendedora' };
export const BREAK_LABEL: Record<string, string> = { descanso: 'Descanso', almuerzo: 'Almuerzo', personal: 'Personal', capacitacion: 'Capacitación o reunión', otro: 'Otro' };
export const INCIDENT_LABEL: Record<string, string> = { conexion: 'Falla de conexión', linea: 'Problema con la línea', plataforma: 'Falla de una plataforma', ausencia: 'Ausencia', otro: 'Otro' };
export const INCIDENT_STATUS: Record<string, { label: string; tone: string }> = {
  abierta: { label: 'Abierta', tone: 'danger' },
  en_curso: { label: 'En curso', tone: 'warn' },
  resuelta: { label: 'Resuelta', tone: 'ok' },
};
export const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', telefono: 'Teléfono', otro: 'Otro' };
export const END_REASON: Record<string, string> = { usuario: 'Finalizado por la persona', supervision: 'Cerrado por supervisión', automatico: 'Cierre automático (sin señal)' };
export const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Estados en vivo: texto y tono. El texto siempre acompaña al color. */
export const LIVE_STATE: Record<string, { label: string; tone: string; help: string }> = {
  actividad_observada: { label: 'Actividad observada', tone: 'ok', help: 'Hubo teclado o ratón en una herramienta autorizada en los últimos minutos.' },
  sin_actividad_observada: { label: 'Sin actividad observada', tone: '', help: 'Conectada, sin teclado ni ratón en las herramientas. Puede estar leyendo, en llamada o resolviendo una novedad.' },
  en_pausa: { label: 'En pausa', tone: 'warn', help: 'Pausa declarada por la persona.' },
  sin_senal: { label: 'Sin señal', tone: 'danger', help: 'La extensión dejó de sincronizar: sin conexión, navegador cerrado o equipo suspendido.' },
  fuera_de_turno: { label: 'Fuera de turno', tone: 'plain', help: 'No tiene un turno abierto.' },
};

export const MINUTE_STATE: Record<string, string> = {
  observada: 'Actividad observada',
  sin_actividad: 'Sin actividad observada',
  pausa: 'Pausa',
  sin_datos: 'Sin datos',
};

const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const timeSecFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

type When = string | number | Date | null | undefined;
const toDate = (v: When) => (v == null ? null : new Date(v));

export const fmtTime = (v: When) => (toDate(v) ? timeFmt.format(toDate(v)!) : '—');
export const fmtTimeSec = (v: When) => (toDate(v) ? timeSecFmt.format(toDate(v)!) : '—');
export const fmtDate = (v: When) => (toDate(v) ? dateFmt.format(toDate(v)!) : '—');
export const fmtDateTime = (v: When) => (toDate(v) ? dateTimeFmt.format(toDate(v)!) : '—');

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null) return '—';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * Porcentaje del turno con la extensión conectada (con señal): todo menos los minutos «sin datos».
 * No depende del teclado: una persona en pausa o sin teclear sigue contando como conectada.
 */
export function connectedPct(totalMinutes: number, noDataMinutes: number): number | null {
  if (!totalMinutes || totalMinutes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((totalMinutes - noDataMinutes) / totalMinutes) * 100)));
}
export const pctTone = (pct: number) => (pct >= 90 ? 'ok' : pct >= 80 ? 'warn' : 'danger');

export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')} min`;
}

export function ago(v: When, now = Date.now()): string {
  const d = toDate(v);
  if (!d) return '—';
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `hace ${Math.floor(s / 86400)} d`;
}

export function scheduleText(s: { weekdays: number[]; startTime: string; endTime: string } | null | undefined): string {
  if (!s) return 'Sin programar';
  return `${s.weekdays.map((d) => DAYS[d]).join(', ')} · ${s.startTime}–${s.endTime}`;
}

export const AGENDA_KIND: Record<string, string> = { tarea: 'Tarea', reunion: 'Reunión', compromiso: 'Compromiso', actividad: 'Actividad' };
export const COMMITMENT_STATUS: Record<string, { label: string; tone: string }> = {
  pendiente: { label: 'Pendiente', tone: 'warn' },
  cumplido: { label: 'Cumplido', tone: 'ok' },
  no_cumplido: { label: 'No cumplido', tone: 'danger' },
};

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Fecha local AAAA-MM-DD (para campos de fecha). */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const dayStartIso = (day: string) => new Date(`${day}T00:00:00`).toISOString();
export const dayEndIso = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

const weekdayFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtLongDay = (v: string | Date) => {
  const s = weekdayFmt.format(new Date(v));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Descarga un CSV que Excel en español abre directamente (separador ; y marca BOM). */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cell = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function download(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
