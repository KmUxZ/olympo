// Hermes · conexión del WhatsApp real a través de Pancake: página, token, dirección de avisos, plantillas y activación.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, useApi } from '../../lib/api';
import { Badge, ErrorNote, Field, Loading } from '../../components/ui';

interface Template { key: string; title: string; required: boolean; when: string; text: string; buttons: string[] }
interface Channel { driver: string; pageId: string; hasToken: boolean; webhookUrl: string | null; templates: Record<string, string>; missing: string[]; catalog: Template[] }

function Copy({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }).catch(() => {})}>
      {done ? 'Copiado ✓' : label}
    </button>
  );
}

export function ChannelCard({ onChanged }: { onChanged?: () => void }) {
  const channel = useApi<Channel>('/api/hermes/channel');
  const [data, setData] = useState<Channel | null>(null);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [ids, setIds] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = (c: Channel) => {
    setData(c);
    setPageId(c.pageId);
    setIds(c.templates);
    setToken('');
  };
  useEffect(() => {
    if (channel.data && !data) load(channel.data);
  }, [channel.data, data]);

  async function run(task: () => Promise<Channel | void>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await task();
      if (next) load(next);
      setNotice(ok);
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api<Channel>('PUT', '/api/hermes/channel', { pageId: pageId.trim(), ...(token.trim() ? { token: token.trim() } : {}), templates: ids }), 'Conexión guardada y comprobada con Pancake.');
  };
  const test = (key: string, title: string) => run(async () => { await api('POST', '/api/hermes/channel/test', { phone, template: key }); }, `Prueba de «${title}» enviada. Revisa el WhatsApp de ese número.`);
  const activate = (active: boolean) => {
    if (active && !window.confirm('Desde ahora Hermes le escribirá de verdad a los clientes por WhatsApp. ¿Activar?')) return;
    void run(() => api<Channel>('POST', '/api/hermes/channel/activate', { active }), active ? 'Envío real activado.' : 'Hermes volvió al modo simulado.');
  };

  if (!data) return <div className="card card-pad">{channel.error ? <ErrorNote error={channel.error} /> : <Loading />}</div>;
  const live = data.driver === 'pancake';
  const connected = Boolean(data.pageId && data.hasToken);
  const dirty = pageId.trim() !== data.pageId || Boolean(token.trim()) || JSON.stringify(ids) !== JSON.stringify(data.templates);

  return (
    <form className="card" onSubmit={save}>
      <div className="card-head">
        <div>
          <h2>WhatsApp por Pancake</h2>
          <span className="xs muted">Conecta el número con el que Hermes le escribe a los clientes.</span>
        </div>
        {live ? <Badge tone="ok">Enviando por WhatsApp</Badge> : connected ? <Badge tone="info">Conectado · sin activar</Badge> : <Badge tone="warn">Sin conectar</Badge>}
      </div>
      <div className="card-pad stack">
        <ErrorNote error={error} />
        {notice && <div className="alert ok" role="status">{notice}</div>}

        <h3>1. Conecta la página</h3>
        <div className="grid cols-2">
          <Field label="Identificador de la página en Pancake" hint="Empieza por waba_. Está en la dirección de la página en Pancake.">
            <input value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="waba_1234567890" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Token de acceso de la página" hint="Pancake → Configuración → Herramientas → Public API. Se guarda cifrado y no se vuelve a mostrar.">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.hasToken ? 'Guardado · pega uno nuevo solo para cambiarlo' : 'Pega aquí el token'} autoComplete="off" />
          </Field>
        </div>

        <h3>2. Avisos de mensajes entrantes</h3>
        {data.webhookUrl ? (
          <>
            <p className="small muted">En Pancake abre <strong>Configuración → Herramientas → Webhooks</strong> de esa página, pega esta dirección y marca el evento de mensajes. Es secreta: no la compartas.</p>
            <div className="row">
              <code className="grow" style={{ overflowWrap: 'anywhere', fontSize: 'var(--text-xs)' }}>{data.webhookUrl}</code>
              <Copy text={data.webhookUrl} label="Copiar dirección" />
            </div>
          </>
        ) : <p className="small muted">La dirección aparece al guardar la conexión.</p>}

        <h3>3. Plantillas aprobadas</h3>
        <p className="small muted">
          Crea cada plantilla en WhatsApp Manager (categoría <strong>Utilidad</strong>, idioma español) con este mismo texto, las variables con el mismo nombre y los botones de respuesta rápida indicados.
          Cuando Meta la apruebe, pega aquí su identificador. Las marcadas como obligatorias son las que hacen avanzar el pedido.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Plantilla</th><th>Texto</th><th>Identificador aprobado</th><th></th></tr></thead>
            <tbody>
              {data.catalog.map((t) => (
                <tr key={t.key}>
                  <td style={{ minWidth: 170 }}>
                    <strong>{t.title}</strong>
                    <span className="sub">{t.when}</span>
                    <span className="sub mono">{t.key}</span>
                    {t.required ? <Badge tone={ids[t.key] ? 'ok' : 'warn'}>Obligatoria</Badge> : <Badge tone="plain">Opcional</Badge>}
                  </td>
                  <td className="small" style={{ minWidth: 260 }}>
                    {t.text}
                    {t.buttons.length > 0 && <span className="sub">Botones: {t.buttons.join(' · ')}</span>}
                    <div style={{ marginTop: 6 }}><Copy text={t.text} label="Copiar texto" /></div>
                  </td>
                  <td style={{ minWidth: 170 }}>
                    <input aria-label={`Identificador de ${t.title}`} value={ids[t.key] ?? ''} onChange={(e) => setIds({ ...ids, [t.key]: e.target.value.trim() })} autoComplete="off" spellCheck={false} />
                  </td>
                  <td>
                    <button type="button" className="btn sm" disabled={busy || dirty || !data.templates[t.key] || !phone.trim()} onClick={() => void test(t.key, t.title)}>Probar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Field label="Número para las pruebas" hint="Escribe tu propio WhatsApp con indicativo (573001234567). «Probar» envía la plantilla con datos de ejemplo a ese número.">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" style={{ maxWidth: 260 }} />
        </Field>

        <h3>4. Activa el envío real</h3>
        {live ? (
          <div className="alert ok">Hermes está escribiendo a los clientes por WhatsApp. Si necesitas detenerlo, vuelve al modo simulado: los pedidos siguen su curso dentro de la plataforma.</div>
        ) : data.missing.length ? (
          <div className="alert info">Para activar falta: {data.missing.join('; ')}.</div>
        ) : (
          <div className="alert info">Todo listo. Antes de activar, prueba cada plantilla obligatoria con tu número.</div>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy || !dirty}>{busy ? 'Guardando…' : 'Guardar y comprobar'}</button>
          {live
            ? <button type="button" className="btn" disabled={busy} onClick={() => activate(false)}>Volver al modo simulado</button>
            : <button type="button" className="btn" disabled={busy || dirty || data.missing.length > 0} onClick={() => activate(true)}>Activar envío real</button>}
        </div>
      </div>
    </form>
  );
}
