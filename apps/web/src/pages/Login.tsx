import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { ErrorNote, Field } from '../components/ui';

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { email, password, client: 'web' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card card-pad stack" onSubmit={submit}>
        <div>
          <h1>Argos</h1>
          <p className="muted small">OLYMPO · Operación de equipos de venta</p>
        </div>
        <ErrorNote error={error} />
        <Field label="Correo">
          <input type="email" required autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Entrando…' : 'Iniciar sesión'}
        </button>
      </form>
    </div>
  );
}

export function ChangePassword({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setError('Las contraseñas nuevas no coinciden.');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/change-password', { current, next });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card card-pad stack" onSubmit={submit}>
        <div>
          <h1>Crea tu contraseña</h1>
          {forced && <p className="muted small">Tu contraseña actual es temporal. Cámbiala para continuar.</p>}
        </div>
        <ErrorNote error={error} />
        <Field label="Contraseña temporal o actual">
          <input type="password" required autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">
          <input type="password" required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Repite la nueva contraseña">
          <input type="password" required minLength={10} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
        <button type="button" className="btn ghost" onClick={() => void logout()}>
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
