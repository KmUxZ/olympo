// Hermes · página pública de rastreo. La abre el cliente desde el enlace que recibe por WhatsApp, sin cuenta.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

interface Tracking {
  company: string; code: string; firstName: string; city: string; status: string; carrier: string; trackingNumber: string; carrierUrl: string; inOffice: boolean;
  createdAt: string; confirmedAt: string | null; dispatchedAt: string | null; outForDeliveryAt: string | null; deliveredAt: string | null; returnedAt: string | null;
}

/** Qué le decimos al cliente en cada estado: un titular y una frase de qué esperar. */
function headline(t: Tracking): { title: string; text: string; tone: 'ok' | 'info' | 'warn' | 'danger' } {
  if (t.status === 'entregado') return { title: 'Tu pedido fue entregado', text: 'Gracias por tu compra.', tone: 'ok' };
  if (t.status === 'devuelto') return { title: 'Tu pedido fue devuelto', text: 'La transportadora lo regresó. Si quieres recibirlo de nuevo, respóndenos por WhatsApp.', tone: 'danger' };
  if (t.status === 'cancelado') return { title: 'Este pedido fue cancelado', text: 'Si fue un error, respóndenos por WhatsApp y lo revisamos.', tone: 'danger' };
  if (t.status === 'novedad') return { title: 'Hubo una novedad con la entrega', text: 'Te escribimos por WhatsApp para resolverla contigo.', tone: 'warn' };
  if (t.inOffice) return { title: 'Te espera en la oficina', text: `Está listo para que lo recojas en la oficina de ${t.carrier || 'la transportadora'} en ${t.city}. Lleva tu documento de identidad.`, tone: 'warn' };
  if (t.status === 'en_reparto') return { title: 'Tu pedido sale a reparto', text: 'Mantén el teléfono a la mano: la transportadora puede llamarte.', tone: 'info' };
  if (t.status === 'despachado') return { title: 'Tu pedido va en camino', text: 'Te avisaremos por WhatsApp cuando salga a reparto.', tone: 'info' };
  return { title: 'Estamos preparando tu pedido', text: 'Te avisaremos por WhatsApp cuando salga.', tone: 'info' };
}

const STEPS: { key: string; label: string; at: (t: Tracking) => string | null }[] = [
  { key: 'confirmado', label: 'Confirmado', at: (t) => t.confirmedAt },
  { key: 'despachado', label: 'En camino', at: (t) => t.dispatchedAt },
  { key: 'en_reparto', label: 'En reparto', at: (t) => t.outForDeliveryAt },
  { key: 'entregado', label: 'Entregado', at: (t) => t.deliveredAt },
];
const ORDER = ['por_confirmar', 'confirmado', 'despachado', 'en_reparto', 'entregado'];

export function TrackPage() {
  const token = window.location.pathname.split('/')[2] ?? '';
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    document.title = 'Sigue tu pedido';
    let alive = true;
    const load = () => api<Tracking>('GET', `/api/hermes/track/${encodeURIComponent(token)}`).then((d) => alive && (setData(d), setError(null)), (e) => alive && setError((e as Error).message));
    void load();
    // El estado cambia cuando la transportadora informa: se vuelve a consultar cada dos minutos.
    const id = setInterval(() => void load(), 120_000);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  if (error && !data) {
    return (
      <main className="track">
        <div className="card card-pad stack track-card">
          <h1>No encontramos ese pedido</h1>
          <p className="muted">Revisa que el enlace esté completo. Si lo copiaste de WhatsApp, ábrelo directamente desde el mensaje.</p>
        </div>
      </main>
    );
  }
  if (!data) return <main className="track"><div className="card card-pad track-card muted">Buscando tu pedido…</div></main>;

  const h = headline(data);
  const reached = ORDER.indexOf(data.status === 'novedad' ? 'en_reparto' : data.status);
  const closedBad = data.status === 'devuelto' || data.status === 'cancelado';
  return (
    <main className="track">
      <div className="card track-card">
        <div className="card-pad stack">
          <span className="small muted">{data.company} · Pedido {data.code}</span>
          <h1>{data.firstName ? `${data.firstName}, ` : ''}{h.title.charAt(0).toLowerCase() + h.title.slice(1)}</h1>
          <div className={`alert ${h.tone}`} role="status">{h.text}</div>

          {!closedBad && (
            <ol className="track-steps" aria-label="Recorrido del pedido">
              {STEPS.map((s) => {
                const i = ORDER.indexOf(s.key);
                const state = i < reached ? 'done' : i === reached ? 'current' : '';
                return (
                  <li key={s.key} className={state}>
                    <span className="track-dot" aria-hidden="true" />
                    <span className="track-label">{s.label}</span>
                    <span className="track-when">{s.at(data) ? fmtDateTime(s.at(data)!) : state ? '' : 'Pendiente'}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {data.trackingNumber && (
            <div className="track-guide">
              <div>
                <span className="small muted">Guía{data.carrier ? ` · ${data.carrier}` : ''}</span>
                <strong className="mono track-number">{data.trackingNumber}</strong>
              </div>
              <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(data.trackingNumber).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {})}>{copied ? 'Copiada ✓' : 'Copiar'}</button>
            </div>
          )}
          {data.carrierUrl && <a className="btn" href={data.carrierUrl} target="_blank" rel="noopener noreferrer">Ver en la página de {data.carrier || 'la transportadora'}</a>}
          <p className="xs muted">Esta página se actualiza sola cuando la transportadora informa un cambio. ¿Tienes una duda? Respóndenos en el mismo chat de WhatsApp.</p>
        </div>
      </div>
    </main>
  );
}
