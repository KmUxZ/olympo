import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { ErrorNote, Field } from '../components/ui';
import { ArgosLogo, OlympoLogo, Splash } from '../components/brand';

/** Marco de las pantallas de acceso: panel de marca a la izquierda, formulario a la derecha. */
function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="login-brand">
        <OlympoLogo size={40} color="var(--brand-blue)" />
        <div>
          <h2>Tu comercio, conectado.</h2>
          <p>Argos acompaña a tu equipo de ventas: turnos, líneas, novedades y calidad en un solo lugar, con datos que tu equipo puede ver y entender.</p>
        </div>
        <span className="xs" style={{ color: '#8b97a8' }}>OLYMPO · Ecosistema de herramientas para e-commerce</span>
      </div>
      <div className="login-form">{children}</div>
    </div>
  );
}

/** Campo de contraseña con un botón para verla mientras se escribe: evita errores al iniciar sesión. */
function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="pw-toggle" aria-pressed={show} onClick={() => setShow(!show)}>
        {show ? 'Ocultar' : 'Ver'}
      </button>
    </span>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { email, password, client: 'web' });
      // Un instante con la pantalla de carga, para que la entrada no sea un salto brusco.
      setEntering(true);
      await new Promise((r) => setTimeout(r, 700));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setEntering(false);
    }
  }

  if (entering) return <Splash label="Entrando…" />;
  return (
    <AuthFrame>
      <form className="stack" onSubmit={submit}>
        <div className="stack" style={{ gap: 6 }}>
          <ArgosLogo size={36} />
          <h1>Inicia sesión</h1>
          <p className="muted small">Operación y acompañamiento de equipos de venta.</p>
        </div>
        <ErrorNote error={error} />
        <Field label="Correo">
          <input type="email" required autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <PasswordInput required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Entrando…' : 'Iniciar sesión'}
        </button>
      </form>
    </AuthFrame>
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
    <AuthFrame>
      <form className="stack" onSubmit={submit}>
        <div>
          <h1>Crea tu contraseña</h1>
          {forced && <p className="muted small">Tu contraseña actual es temporal. Cámbiala para continuar.</p>}
        </div>
        <ErrorNote error={error} />
        <Field label="Contraseña temporal o actual">
          <PasswordInput required autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">
          <PasswordInput required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Repite la nueva contraseña">
          <PasswordInput required minLength={10} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
        <button type="button" className="btn ghost" onClick={() => void logout()}>
          Cerrar sesión
        </button>
      </form>
    </AuthFrame>
  );
}
