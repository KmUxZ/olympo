// Athena · ajustes: cómo se presenta, qué políticas conoce, qué reglas sigue y qué puede hacer sola.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { Badge, ErrorNote, Field, Loading, PageHero } from '../../components/ui';

interface S { enabled: boolean; assistantName: string; businessAbout: string; tone: string; shippingPolicy: string; paymentPolicy: string; extraRules: string; model: string; createOrders: boolean }
const MODEL_LABEL: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 · el más capaz (recomendado)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 · más rápido y económico',
  'claude-haiku-5-5': 'Claude Haiku 5.5 · el más económico',
};

export function AthenaSettings() {
  const { me } = useAuth();
  const canEdit = me!.user.role === 'admin';
  const data = useApi<{ settings: S; aiReady: boolean; hermesActive: boolean; models: string[] }>('/api/athena/settings');
  const [f, setF] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data.data && !f) setF(data.data.settings);
  }, [data.data, f]);
  if (!data.data || !f) return data.error ? <ErrorNote error={data.error} /> : <Loading />;
  const set = <K extends keyof S>(k: K, v: S[K]) => { setF({ ...f, [k]: v }); setSaved(false); };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/athena/settings', f);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHero tone="athena" title="Ajustes de Athena" subtitle="Cómo se presenta, qué sabe de tu operación y hasta dónde puede llegar sola." />
      <div className="grid cols-2">
        <div className="card card-pad stack">
          <div className="row"><h3 className="grow">Inteligencia artificial</h3>{data.data.aiReady ? <Badge tone="ok">Conectada</Badge> : <Badge tone="warn">Sin conectar</Badge>}</div>
          <p className="small muted">
            {data.data.aiReady
              ? 'Athena responde con IA: entiende la pregunta, usa tu catálogo y reglas, y toma los datos del pedido.'
              : 'Mientras no se conecte, Athena funciona en modo básico: repite lo escrito en el catálogo y las políticas y pasa todo lo demás a una persona. La credencial la configura quien administra el servidor (variable ANTHROPIC_API_KEY); no se escribe en esta pantalla.'}
          </p>
        </div>
        <div className="card card-pad stack">
          <div className="row"><h3 className="grow">Canal de WhatsApp</h3><Badge tone="warn">Simulado</Badge></div>
          <p className="small muted">Aún no hay un número conectado: Athena solo conversa en las pruebas de la plataforma y no le escribe a ningún cliente. El número se conecta al final, junto con los demás accesos.</p>
        </div>
      </div>

      <form className="card card-pad stack" onSubmit={save}>
        <ErrorNote error={error} />
        {!canEdit && <div className="alert info" role="status">Solo el administrador puede cambiar estos ajustes.</div>}
        <fieldset disabled={!canEdit || busy} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <div className="grow"><Field label="Nombre con el que se presenta"><input required minLength={2} maxLength={40} value={f.assistantName} onChange={(e) => set('assistantName', e.target.value)} /></Field></div>
            <div className="grow" style={{ flex: 2 }}><Field label="Tono" hint="Ej.: cercano, de tú, sin emojis en exceso."><input maxLength={300} value={f.tone} onChange={(e) => set('tone', e.target.value)} /></Field></div>
          </div>
          <Field label="Sobre el negocio" hint="Qué vendes, a quién y qué te diferencia. Athena lo usa para presentarse y orientar al cliente.">
            <textarea rows={3} maxLength={2000} value={f.businessAbout} onChange={(e) => set('businessAbout', e.target.value)} />
          </Field>
          <div className="row">
            <div className="grow"><Field label="Envíos" hint="Cobertura, tiempos, costo y transportadora."><textarea rows={4} maxLength={2000} value={f.shippingPolicy} onChange={(e) => set('shippingPolicy', e.target.value)} /></Field></div>
            <div className="grow"><Field label="Pagos" hint="Contraentrega, otros medios, si se puede abrir el paquete."><textarea rows={4} maxLength={1500} value={f.paymentPolicy} onChange={(e) => set('paymentPolicy', e.target.value)} /></Field></div>
          </div>
          <Field label="Reglas" hint="Lo que no debe prometer, cuándo pasar a una persona, cambios y garantías.">
            <textarea rows={4} maxLength={3000} value={f.extraRules} onChange={(e) => set('extraRules', e.target.value)} placeholder="Ej.: No prometas resultados médicos. Si preguntan por ventas al por mayor, pasa a una persona." />
          </Field>
          <div className="row">
            <div className="grow">
              <Field label="Modelo de IA"><select value={f.model} onChange={(e) => set('model', e.target.value)}>{data.data.models.map((m) => <option key={m} value={m}>{MODEL_LABEL[m] ?? m}</option>)}</select></Field>
            </div>
            <div className="grow stack" style={{ justifyContent: 'center' }}>
              <label className="check">
                <input type="checkbox" checked={f.createOrders} disabled={!data.data.hermesActive} onChange={(e) => set('createOrders', e.target.checked)} /> Athena crea el pedido en Hermes cuando el cliente confirma
              </label>
              <span className="xs muted">{data.data.hermesActive ? 'Si lo desmarcas, reúne los datos y le pasa la conversación a una persona para que lo registre.' : 'Tu empresa no tiene Hermes activo: Athena reúne los datos y una persona registra el pedido.'}</span>
              <label className="check">
                <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Responder a clientes reales cuando el número esté conectado
              </label>
            </div>
          </div>
        </fieldset>
        {canEdit && <div className="actions"><button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button>{saved && <span className="small" style={{ color: 'var(--color-ok)' }}>Guardado.</span>}</div>}
      </form>
    </>
  );
}
