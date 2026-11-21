import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ApiError } from '../lib/api';
import { useNow } from '../lib/api';
import { ago, fmtTimeSec, LIVE_STATE, MINUTE_STATE } from '../lib/format';

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatePill({ state }: { state: string }) {
  const s = LIVE_STATE[state] ?? { label: state, tone: '', help: '' };
  return (
    <span className={`badge ${s.tone}`} title={s.help}>
      {s.label}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ error }: { error?: ApiError | string | null }) {
  if (!error) return null;
  return (
    <div className="alert danger" role="alert">
      {typeof error === 'string' ? error : error.message}
    </div>
  );
}

/**
 * Indicador de vigencia de los datos. Si la última actualización falló o es antigua,
 * lo dice de forma explícita en lugar de mostrar datos viejos como si fueran actuales.
 */
export function Freshness({ updatedAt, error, staleAfterMs = 45_000 }: { updatedAt?: number; error?: ApiError; staleAfterMs?: number }) {
  const now = useNow(5000);
  if (!updatedAt) return error ? <span className="fresh stale">No se pudieron cargar los datos</span> : null;
  const stale = Boolean(error) || now - updatedAt > staleAfterMs;
  return (
    <span className={`fresh ${stale ? 'stale' : ''}`} role="status">
      {stale ? `Datos desactualizados · última actualización ${fmtTimeSec(updatedAt)}` : `Actualizado ${ago(updatedAt, now)}`}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Cerrar">
            Cerrar
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Formulario dentro de un modal: gestiona envío, estado de carga y error. */
export function FormModal({ title, submitLabel = 'Guardar', onClose, onSubmit, children, wide }: { title: string; submitLabel?: string; onClose: () => void; onSubmit: () => Promise<void>; children: ReactNode; wide?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <ErrorNote error={error} />
          {children}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Guardando…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">Cargando…</div>;
}

export function Timeline({ segments }: { segments: { start: string; end: string; state: string }[] }) {
  if (!segments.length) return <div className="muted small">Aún no hay minutos registrados.</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="timeline" role="img" aria-label="Línea de tiempo del turno">
        {segments.map((s, i) => {
          const minutes = Math.max(1, (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000);
          return <i key={i} className={`seg-${s.state}`} style={{ flex: minutes }} title={`${MINUTE_STATE[s.state]} · ${Math.round(minutes)} min`} />;
        })}
      </div>
      <div className="legend">
        {Object.entries(MINUTE_STATE).map(([key, label]) => (
          <span key={key}>
            <i className={`seg-${key}`} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
