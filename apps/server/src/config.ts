import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  /** Si está vacío se usa PostgreSQL embebido (PGlite) en DATA_DIR: solo para desarrollo. */
  databaseUrl: process.env.DATABASE_URL ?? '',
  dataDir: process.env.DATA_DIR ?? resolve(root, 'data'),
  webDist: resolve(root, 'apps/web/dist'),
  /** Orígenes desde los que se aceptan peticiones con cookie de sesión. */
  webOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()),
  cookieSecure: process.env.NODE_ENV === 'production',
  sessionDays: 14,
};

/**
 * Versión del aviso "Qué se registra". Al cambiar lo que la extensión registra hay que subirla:
 * todas las personas deberán aceptar de nuevo antes de iniciar turno.
 */
export const CONSENT_VERSION = '2026-11';

/** Ajustes por empresa (se guardan en core_companies.settings; aquí están los valores por defecto). */
export const DEFAULT_SETTINGS = {
  /** Días que se conservan los registros de actividad por minuto. Los resúmenes de turno se conservan. */
  retentionDays: 90,
  /** Segundos sin sincronización tras los cuales un turno se muestra como "Sin señal". */
  staleSeconds: 150,
  /** Ventana (minutos) para considerar que hay "actividad observada" reciente. */
  activityWindowMinutes: 5,
  /** Horas sin señal tras las cuales un turno abierto se cierra automáticamente. */
  autoCloseHours: 3,
};

export type CompanySettings = typeof DEFAULT_SETTINGS;

export function resolveSettings(raw: unknown): CompanySettings {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(out) as (keyof CompanySettings)[]) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = v;
    }
  }
  return out;
}
