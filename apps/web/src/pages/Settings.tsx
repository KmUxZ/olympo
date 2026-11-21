import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, useApi } from '../lib/api';
import { PancakeSettings } from './PancakeSettings';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHead } from '../components/ui';

interface Tool { id: string; name: string; hosts: string[]; active: boolean }
interface SettingsData { retentionDays: number; staleSeconds: number; activityWindowMinutes: number; autoCloseHours: number }

export function Settings() {
  const tools = useApi<{ tools: Tool[] }>('/api/argos/tools');
  const settings = useApi<{ settings: SettingsData }>('/api/settings');
  const [editing, setEditing] = useState<Tool | 'new' | null>(null);
  const [form, setForm] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data.settings);
  }, [settings.data, form]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api('PATCH', '/api/settings', form);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const num = (key: keyof SettingsData) => ({
    type: 'number' as const,
    required: true,
    value: form?.[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => form && setForm({ ...form, [key]: Number(e.target.value) }),
  });

  return (
    <>
      <PageHead title="Configuración" subtitle="Dónde puede registrar la extensión y cuánto tiempo se conservan los datos." />

      <div className="card">
        <div className="card-head">
          <h2>Herramientas de trabajo autorizadas</h2>
          <button className="btn primary sm" onClick={() => setEditing('new')}>Autorizar herramienta</button>
        </div>
        {!tools.data ? <Loading /> : tools.data.tools.length ? (
          <table>
            <thead><tr><th>Herramienta</th><th>Sitios</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {tools.data.tools.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td className="mono">{t.hosts.join(', ')}</td>
                  <td>{t.active ? <Badge tone="ok">Autorizada</Badge> : <Badge>Desactivada</Badge>}</td>
                  <td><button className="btn sm" onClick={() => setEditing(t)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Sin herramientas autorizadas: la extensión no registrará actividad en ningún sitio.</Empty>
        )}
        <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
          La extensión solo puede ver estos sitios, y solo durante un turno activo. Cuando agregues uno nuevo, cada vendedora deberá autorizarlo en su extensión.
        </div>
      </div>

      <PancakeSettings />

      <SupportAccess />

      <form className="card" onSubmit={save}>
        <div className="card-head"><h2>Conservación de datos y umbrales</h2></div>
        <div className="card-pad stack">
          <ErrorNote error={error ?? settings.error} />
          {saved && <div className="alert ok" role="status">Ajustes guardados.</div>}
          {!form ? <Loading /> : (
            <div className="grid cols-2">
              <Field label="Conservación de registros por minuto (días)" hint="Pasado este plazo se eliminan automáticamente. Los resúmenes de turno se conservan. Entre 7 y 730.">
                <input {...num('retentionDays')} min={7} max={730} />
              </Field>
              <Field label="«Sin señal» tras (segundos)" hint="Tiempo sin sincronización de la extensión. Entre 90 y 900.">
                <input {...num('staleSeconds')} min={90} max={900} />
              </Field>
              <Field label="Ventana de actividad reciente (minutos)" hint="Sin eventos en este tiempo, el estado pasa a «Sin actividad observada». Entre 2 y 30.">
                <input {...num('activityWindowMinutes')} min={2} max={30} />
              </Field>
              <Field label="Cierre automático de turno (horas sin señal)" hint="El turno se cierra en la hora del último dato recibido. Entre 1 y 12.">
                <input {...num('autoCloseHours')} min={1} max={12} />
              </Field>
            </div>
          )}
          <div><button className="btn primary" disabled={!form}>Guardar ajustes</button></div>
        </div>
      </form>

      {editing && (
        <ToolModal
          tool={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await tools.reload();
          }}
        />
      )}
    </>
  );
}

/** La empresa decide si el equipo de OLYMPO puede entrar a ayudarla, y por cuánto tiempo. */
function SupportAccess() {
  const access = useApi<{ until: string | null }>('/api/settings/support-access');
  const [error, setError] = useState<string | null>(null);
  const until = access.data?.until ? new Date(access.data.until) : null;
  const open = Boolean(until && until.getTime() > Date.now());
  async function change(method: 'POST' | 'DELETE', hours?: number) {
    setError(null);
    try {
      await api(method, '/api/settings/support-access', hours ? { hours } : undefined);
      await access.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>Acceso de soporte</h2>
        {open ? <Badge tone="warn">Concedido hasta {until!.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</Badge> : <Badge tone="plain">No concedido</Badge>}
      </div>
      <div className="card-pad stack">
        <ErrorNote error={error ?? access.error} />
        <p className="small muted">
          El equipo de OLYMPO no puede ver los datos de tu empresa. Si necesitas ayuda, puedes darle acceso temporal: podrá entrar como administrador
          hasta que venza el plazo o lo revoques, y todo lo que haga quedará en tu auditoría.
        </p>
        <div className="actions">
          {open
            ? <button className="btn danger" onClick={() => void change('DELETE')}>Revocar acceso ahora</button>
            : <>
                <button className="btn" onClick={() => void change('POST', 4)}>Conceder 4 horas</button>
                <button className="btn" onClick={() => void change('POST', 24)}>Conceder 24 horas</button>
              </>}
        </div>
      </div>
    </div>
  );
}

function ToolModal({ tool, onClose, onSaved }: { tool: Tool | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(tool?.name ?? '');
  const [hosts, setHosts] = useState(tool?.hosts.join('\n') ?? '');
  const [active, setActive] = useState(tool?.active ?? true);
  async function save() {
    // Se aceptan direcciones pegadas completas: solo se conserva el dominio.
    const list = hosts.split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    if (!list.length) throw new Error('Indica al menos un dominio.');
    const body = { name, hosts: list, active };
    if (tool) await api('PATCH', `/api/argos/tools/${tool.id}`, body);
    else await api('POST', '/api/argos/tools', body);
    await onSaved();
  }
  return (
    <FormModal title={tool ? `Editar · ${tool.name}` : 'Autorizar herramienta'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre" hint="Así aparecerá en el dashboard y en los resúmenes."><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: WhatsApp Web" /></Field>
      <Field label="Dominios (uno por línea)" hint="Solo el dominio, sin rutas. Usa *.ejemplo.com para incluir subdominios. Deben ser sitios https.">
        <textarea required value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="web.whatsapp.com" className="mono" />
      </Field>
      {tool && <div className="checks"><label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Autorizada</label></div>}
    </FormModal>
  );
}
