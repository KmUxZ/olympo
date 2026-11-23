// Guía para instalar la extensión Argos: un paso a la vez, con un dibujo de lo que se debe ver en pantalla.
// Pensada para quien nunca ha instalado una extensión. Al iniciar sesión en la extensión, la guía lo detecta sola.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { ArgosMark } from '../components/brand';

interface Status { connected: boolean; lastSeenAt: string | null; version: string; serverUrl: string }

/** Marco que imita una ventana, para que el dibujo se parezca a lo que la persona tiene delante. */
function Win({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ill-win" role="img" aria-label={title}>
      <div className="ill-bar"><i /><i /><i /><span>{title}</span></div>
      <div className="ill-body">{children}</div>
    </div>
  );
}
const Here = ({ children }: { children: ReactNode }) => <span className="ill-here">{children}<em aria-hidden="true">clic aquí</em></span>;

function Illustration({ step, email }: { step: number; email: string }) {
  if (step === 0) {
    return (
      <Win title="Descargas">
        <div className="ill-file"><span className="ill-zip">ZIP</span><div><strong>Argos.zip</strong><small>Archivo comprimido</small></div></div>
        <p className="ill-note">Al descargar, el archivo queda en tu carpeta <strong>Descargas</strong>.</p>
      </Win>
    );
  }
  if (step === 1) {
    return (
      <Win title="Descargas">
        <div className="ill-file"><span className="ill-zip">ZIP</span><div><strong>Argos.zip</strong><small>clic derecho sobre el archivo</small></div></div>
        <ul className="ill-menu">
          <li>Abrir</li>
          <li><Here>Extraer todo…</Here></li>
          <li>Compartir</li>
          <li>Eliminar</li>
        </ul>
      </Win>
    );
  }
  if (step === 2) {
    return (
      <Win title="Google Chrome">
        <div className="ill-address"><span>chrome://extensions</span></div>
        <div className="ill-ext-head">
          <strong>Extensiones</strong>
          <span className="ill-toggle-wrap">Modo de desarrollador <Here><span className="ill-toggle on" /></Here></span>
        </div>
      </Win>
    );
  }
  if (step === 3) {
    return (
      <Win title="Extensiones">
        <div className="ill-buttons"><Here><span className="ill-btn">Cargar descomprimida</span></Here><span className="ill-btn ghost">Empaquetar extensión</span><span className="ill-btn ghost">Actualizar</span></div>
        <div className="ill-picker">
          <div className="ill-folder sel"><span className="ill-dir" /> Argos</div>
          <div className="ill-folder"><span className="ill-dir" /> Otras carpetas</div>
          <span className="ill-btn solid">Seleccionar carpeta</span>
        </div>
      </Win>
    );
  }
  return (
    <Win title="Google Chrome">
      <div className="ill-toolbar"><div className="ill-address"><span>tu página de trabajo</span></div><Here><span className="ill-puzzle" aria-label="icono de extensiones" /></Here></div>
      <div className="ill-popup">
        <div className="ill-popup-head"><ArgosMark size={18} /> <strong>Argos</strong></div>
        <div className="ill-input">{email}</div>
        <div className="ill-input">••••••••</div>
        <span className="ill-btn solid">Iniciar sesión</span>
      </div>
    </Win>
  );
}

const STEPS: { title: string; text: ReactNode }[] = [
  { title: 'Descarga Argos', text: <>Pulsa el botón <strong>Descargar Argos</strong>. Se descarga un archivo llamado <strong>Argos.zip</strong>.</> },
  { title: 'Abre el archivo descargado', text: <>Ve a tu carpeta <strong>Descargas</strong>. Haz <strong>clic derecho</strong> sobre <strong>Argos.zip</strong>, elige <strong>Extraer todo…</strong> y luego pulsa <strong>Extraer</strong>. Queda una carpeta llamada <strong>Argos</strong>. No la borres nunca.</> },
  { title: 'Abre las extensiones de Chrome', text: <>Pulsa <strong>Copiar dirección</strong>. Abre una <strong>pestaña nueva</strong>, pega la dirección arriba (Ctrl + V) y pulsa <strong>Enter</strong>. Luego activa el interruptor <strong>Modo de desarrollador</strong>, arriba a la derecha.</> },
  { title: 'Carga la carpeta Argos', text: <>Pulsa <strong>Cargar descomprimida</strong>, arriba a la izquierda. Busca la carpeta <strong>Argos</strong> en Descargas, haz un clic sobre ella y pulsa <strong>Seleccionar carpeta</strong>.</> },
  { title: 'Inicia sesión en Argos', text: <>Arriba a la derecha de Chrome, pulsa el icono de <strong>pieza de rompecabezas</strong> y luego <strong>Argos</strong>. Escribe el mismo correo y la misma contraseña con los que entraste aquí.</> },
];

export function InstallGuide({ gate = false, onDone }: { gate?: boolean; onDone?: () => void }) {
  const { me, logout } = useAuth();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [copied, setCopied] = useState(false);
  // Reinstalar: la sesión anterior de la extensión sigue viva aunque la hayan quitado de Chrome, así que se espera una señal más nueva.
  const [againSince, setAgainSince] = useState<string | null | undefined>(undefined);
  const last = step === STEPS.length - 1;

  // Se consulta cada pocos segundos: cuando la persona inicia sesión en la extensión, la guía termina sola.
  useEffect(() => {
    let alive = true;
    const check = () => api<Status>('GET', '/api/argos/extension/status').then((s) => alive && setStatus(s)).catch(() => {});
    check();
    const id = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText('chrome://extensions');
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  const again = againSince !== undefined && (status?.lastSeenAt ?? null) === againSince;
  const connected = Boolean(status?.connected) && !again;
  return (
    <div className={`guide ${gate ? 'gate' : ''}`}>
      <header className="guide-head">
        <ArgosMark size={34} />
        <div>
          <h1>{connected ? '¡Argos quedó instalado!' : 'Instala Argos en este computador'}</h1>
          <p className="muted">{connected ? 'Ya puedes iniciar tu turno desde el icono de Argos en Chrome.' : 'Son 5 pasos y se hace una sola vez. Sigue cada paso con calma; nada se daña si te equivocas.'}</p>
        </div>
      </header>

      {connected ? (
        <div className="guide-done">
          <div className="guide-check" aria-hidden="true">✓</div>
          <p>La extensión ya está conectada con tu cuenta{me ? `, ${me.user.name.split(' ')[0]}` : ''}.</p>
          {onDone && <button className="btn primary lg" onClick={onDone}>Entrar a la plataforma</button>}
          <button className="link" onClick={() => { setStep(0); setAgainSince(status?.lastSeenAt ?? null); }}>¿La quitaste o cambiaste de computador? Instalarla de nuevo</button>
        </div>
      ) : (
        <>
          <ol className="guide-dots" aria-label="Pasos">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i === step ? 'current' : i < step ? 'done' : ''}>
                <button onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}><b>{i + 1}</b><span>{s.title}</span></button>
              </li>
            ))}
          </ol>

          <section className="guide-step" aria-live="polite">
            <div className="guide-text">
              <span className="guide-count">Paso {step + 1} de {STEPS.length}</span>
              <h2>{STEPS[step].title}</h2>
              <p>{STEPS[step].text}</p>
              {step === 0 && <a className="btn primary lg" href="/api/argos/extension.zip" download="Argos.zip" onClick={() => setTimeout(() => setStep(1), 800)}>Descargar Argos</a>}
              {step === 2 && (
                <div className="guide-copy">
                  <code>chrome://extensions</code>
                  <button className="btn primary" onClick={() => void copy()}>{copied ? 'Copiada ✓' : 'Copiar dirección'}</button>
                </div>
              )}
              {last && (
                <div className="guide-wait" role="status">
                  <span className="guide-spinner" aria-hidden="true" />
                  Esperando a que inicies sesión en la extensión… Esta pantalla avanza sola cuando lo hagas.
                </div>
              )}
              <div className="guide-nav">
                {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Atrás</button>}
                {!last && <button className={`btn ${step === 0 ? '' : 'primary'} lg`} onClick={() => setStep(step + 1)}>{step === 0 ? 'Ya lo descargué' : 'Listo, siguiente'}</button>}
              </div>
            </div>
            <Illustration step={step} email={me?.user.email ?? 'tu correo'} />
          </section>

          <details className="guide-help">
            <summary>Algo no me sale</summary>
            <ul>
              <li><strong>No veo «Cargar descomprimida».</strong> Falta activar <em>Modo de desarrollador</em> (paso 3).</li>
              <li><strong>Chrome dice que falta el manifiesto.</strong> Elegiste otra carpeta. Vuelve al paso 4 y elige la carpeta <em>Argos</em>; si adentro hay otra carpeta Argos, elige esa.</li>
              <li><strong>No encuentro el archivo.</strong> Pulsa Ctrl + J en Chrome: ahí aparecen tus descargas.</li>
              <li><strong>Sigue sin funcionar.</strong> Avísale a tu supervisora y muéstrale esta pantalla.</li>
            </ul>
          </details>
        </>
      )}

      {gate && !connected && (
        <footer className="guide-foot">
          {onDone && <button className="link" onClick={onDone}>No puedo instalarla en este equipo: entrar por esta vez</button>}
          <button className="link" onClick={() => void logout()}>Cerrar sesión</button>
        </footer>
      )}
    </div>
  );
}
