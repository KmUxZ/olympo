import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Las respuestas de la API se tipan de forma laxa en el MVP.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError('sin_conexion', 'No hay conexión con el servidor.', 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(json?.error?.code ?? 'error', json?.error?.message ?? 'Ocurrió un error.', res.status);
    if (res.status === 401 && !path.startsWith('/api/auth/login')) window.dispatchEvent(new Event('olympo:unauthorized'));
    throw err;
  }
  return json as T;
}

export interface Loaded<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
  /** Momento (reloj local) de la última respuesta correcta. */
  updatedAt?: number;
  reload: () => Promise<void>;
}

/**
 * Carga datos y, opcionalmente, los refresca cada `refreshMs`.
 * Si una actualización falla se conservan los últimos datos y se expone el error:
 * la pantalla debe avisar de que lo que muestra está desactualizado.
 */
export function useApi<T = Json>(path: string | null, refreshMs = 0): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, 'reload'>>({ loading: Boolean(path) });
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api<T>('GET', path);
      if (current.current === path) setState({ data, loading: false, updatedAt: Date.now() });
    } catch (error) {
      if (current.current === path) setState((s) => ({ ...s, loading: false, error: error as ApiError }));
    }
  }, [path]);

  useEffect(() => {
    setState({ loading: Boolean(path) });
    void reload();
    if (!refreshMs || !path) return;
    const id = setInterval(() => !document.hidden && void reload(), refreshMs);
    const onVisible = () => !document.hidden && void reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, refreshMs, reload]);

  return { ...state, reload };
}

/** Vuelve a pintar cada `ms` para que los textos "hace X" avancen. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
