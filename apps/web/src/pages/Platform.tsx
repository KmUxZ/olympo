import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi, useNow } from '../lib/api';
import { ago, fmtDate, fmtDateTime } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Freshness, Loading, Modal, PageHero } from '../components/ui';
import { PRODUCT_INFO } from '../components/brand';

/** Casillas de los productos que la empresa tiene contratados. */
function ProductFields({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
      <legend className="small muted">Productos contratados</legend>
      <div className="checks">
        {Object.entries(PRODUCT_INFO).map(([key, p]) => (
          <label key={key} style={p.available ? undefined : { opacity: 0.55 }}>
            <input type="checkbox" disabled={!p.available} checked={value.includes(key)} onChange={(e) => onChange(e.target.checked ? [...value, key] : value.filter((x) => x !== key))} />
            {p.name} · {p.tagline}{!p.available && ' (próximamente)'}
          </label>
        ))}
      </div>
      <span className="small muted">La empresa solo ve y puede usar lo que tenga marcado.</span>
    </fieldset>
  );
}

interface Company {
  id: string; name: string; timezone: string; isDemo: boolean; status: 'active' | 'suspended'; suspendedReason: string;
  limits: { maxSellers?: number | null; maxLines?: number | null }; products: string[]; supportAccessUntil: string | null; createdAt: string;
  users: number; sellers: number; lines: number; activeShifts: number; lastUsedAt: string | null;
  admins: { id: string; name: string; email: string }[];
}

const quota = (used: number, max?: number | null) => (max ? `${used} de ${max}` : String(used));

/** Panel de plataforma. Muestra solo datos de gestión de cada empresa; nunca su actividad operativa. */
export function Platform() {
  const { refresh } = useAuth();
  const list = useApi<{ companies: Company[] }>('/api/platform/companies', 60_000);
  const now = useNow(30_000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enter(c: Company) {
    setError(null);
    try {
      await api('POST', `/api/platform/companies/${c.id}/support`);
      await refresh();
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetAdmin(c: Company, admin: { id: string; name: string }) {
    if (!window.confirm(`¿Restablecer la contraseña de ${admin.name} (${c.name})? Se cerrarán sus sesiones y quedará registrado en la auditoría de esa empresa.`)) return;
    setError(null);
    try {
      const res = await api('POST', `/api/platform/companies/${c.id}/reset-admin`, { userId: admin.id });
      setSecret({ title: `Nueva contraseña temporal de ${res.name}`, email: res.email, password: res.tempPassword });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero kpis={[{ label: 'Empresas activas', value: (list.data?.companies ?? []).filter((c) => c.status === 'active').length }, { label: 'Suspendidas', value: (list.data?.companies ?? []).filter((c) => c.status === 'suspended').length }, { label: 'Vendedoras en total', value: (list.data?.companies ?? []).reduce((n, c) => n + c.sellers, 0) }]} title="Empresas" subtitle="Clientes de la plataforma. Aquí solo hay datos de gestión: la actividad de cada equipo pertenece a su empresa.">
        <Freshness updatedAt={list.updatedAt} error={list.error} staleAfterMs={150_000} />
        <button className="btn primary" onClick={() => setCreating(true)}>Nueva empresa</button>
      </PageHero>
      <ErrorNote error={error} />

      <div className="card">
        {!list.data ? (list.error ? <ErrorNote error={list.error} /> : <Loading />) : list.data.companies.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Empresa</th><th>Estado</th><th>Vendedoras</th><th>Líneas</th><th>En turno ahora</th><th>Último uso</th><th>Soporte</th><th></th></tr></thead>
              <tbody>
                {list.data.companies.map((c) => {
                  const supportOpen = c.supportAccessUntil && new Date(c.supportAccessUntil).getTime() > now;
                  return (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong> {c.isDemo && <Badge tone="warn">Demo</Badge>}
                        <span className="sub">Productos: {c.products.map((p) => PRODUCT_INFO[p]?.name ?? p).join(', ') || 'ninguno'}</span>
                        <span className="sub">Desde {fmtDate(c.createdAt)} · {c.timezone}</span>
                        <span className="sub">{c.admins.length ? `Admin: ${c.admins.map((a) => a.email).join(', ')}` : 'Sin administrador activo'}</span>
                      </td>
                      <td>
                        {c.status === 'active' ? <Badge tone="ok">Activa</Badge> : <Badge tone="danger">Suspendida</Badge>}
                        {c.suspendedReason && <span className="sub">{c.suspendedReason}</span>}
                      </td>
                      <td>{quota(c.sellers, c.limits.maxSellers)}<span className="sub">{c.users} cuentas en total</span></td>
                      <td>{quota(c.lines, c.limits.maxLines)}</td>
                      <td>{c.activeShifts}</td>
                      <td className="nowrap">{c.lastUsedAt ? ago(c.lastUsedAt, now) : 'Nunca'}</td>
                      <td>
                        {supportOpen ? (
                          <>
                            <button className="btn sm" onClick={() => void enter(c)}>Entrar</button>
                            <span className="sub">Hasta {fmtDateTime(c.supportAccessUntil)}</span>
                          </>
                        ) : <span className="muted" title="El administrador de la empresa lo concede en Configuración">No concedido</span>}
                      </td>
                      <td><button className="btn sm" onClick={() => setEditing(c)}>Gestionar</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Aún no hay empresas.</Empty>
        )}
      </div>

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onSaved={async (created) => {
            setCreating(false);
            setSecret({ title: 'Empresa creada · contraseña temporal del administrador', ...created });
            await list.reload();
          }}
        />
      )}
      {editing && (
        <ManageModal
          company={editing}
          onResetAdmin={(admin) => void resetAdmin(editing, admin)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await list.reload();
          }}
        />
      )}
      {secret && (
        <Modal title={secret.title} onClose={() => setSecret(null)} footer={<button className="btn primary" onClick={() => setSecret(null)}>Entendido</button>}>
          <div className="modal-body">
            <p>Entrégala por un canal seguro. Solo se muestra una vez y habrá que cambiarla en el primer inicio de sesión.</p>
            <div className="card card-pad stack" style={{ gap: 4 }}>
              <span className="small muted">Correo</span><span className="mono">{secret.email}</span>
              <span className="small muted">Contraseña temporal</span><span className="mono" style={{ fontSize: 'var(--text-lg)' }}>{secret.password}</span>
            </div>
            <button className="btn sm" style={{ alignSelf: 'start' }} onClick={() => void navigator.clipboard.writeText(secret.password)}>Copiar contraseña</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function LimitFields({ maxSellers, maxLines, onChange }: { maxSellers: string; maxLines: string; onChange: (k: 'maxSellers' | 'maxLines', v: string) => void }) {
  return (
    <div className="row">
      <div className="grow">
        <Field label="Máximo de vendedoras activas" hint="Vacío = sin límite.">
          <input type="number" min={1} value={maxSellers} onChange={(e) => onChange('maxSellers', e.target.value)} />
        </Field>
      </div>
      <div className="grow">
        <Field label="Máximo de líneas activas" hint="Vacío = sin límite.">
          <input type="number" min={1} value={maxLines} onChange={(e) => onChange('maxLines', e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
const toLimits = (maxSellers: string, maxLines: string) => ({ maxSellers: maxSellers ? Number(maxSellers) : null, maxLines: maxLines ? Number(maxLines) : null });

function CreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: (c: { email: string; password: string }) => Promise<void> }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [limits, setLimits] = useState({ maxSellers: '', maxLines: '' });
  const [products, setProducts] = useState<string[]>(['argos']);
  async function save() {
    if (!products.length) throw new Error('Activa al menos un producto.');
    const res = await api('POST', '/api/platform/companies', { name, timezone, adminName, adminEmail, products, limits: toLimits(limits.maxSellers, limits.maxLines) });
    await onSaved({ email: res.adminEmail, password: res.tempPassword });
  }
  return (
    <FormModal title="Nueva empresa" submitLabel="Crear empresa" onClose={onClose} onSubmit={save}>
      <Field label="Nombre de la empresa"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Zona horaria" hint="Ejemplo: America/Bogota.">
        <input required value={timezone} onChange={(e) => setTimezone(e.target.value)} className="mono" />
      </Field>
      <div className="row">
        <div className="grow"><Field label="Nombre del administrador"><input required minLength={2} value={adminName} onChange={(e) => setAdminName(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Correo del administrador"><input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} /></Field></div>
      </div>
      <ProductFields value={products} onChange={setProducts} />
      <LimitFields {...limits} onChange={(k, v) => setLimits({ ...limits, [k]: v })} />
    </FormModal>
  );
}

function ManageModal({ company, onClose, onSaved, onResetAdmin }: { company: Company; onClose: () => void; onSaved: () => Promise<void>; onResetAdmin: (a: { id: string; name: string }) => void }) {
  const [name, setName] = useState(company.name);
  const [suspended, setSuspended] = useState(company.status === 'suspended');
  const [reason, setReason] = useState(company.suspendedReason);
  const [limits, setLimits] = useState({ maxSellers: String(company.limits.maxSellers ?? ''), maxLines: String(company.limits.maxLines ?? '') });
  const [products, setProducts] = useState<string[]>(company.products);
  async function save() {
    if (!products.length) throw new Error('Activa al menos un producto.');
    await api('PATCH', `/api/platform/companies/${company.id}`, { name, status: suspended ? 'suspended' : 'active', suspendedReason: reason, products, limits: toLimits(limits.maxSellers, limits.maxLines) });
    await onSaved();
  }
  return (
    <FormModal title={`Gestionar · ${company.name}`} onClose={onClose} onSubmit={save}>
      <Field label="Nombre de la empresa"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <ProductFields value={products} onChange={setProducts} />
      <LimitFields {...limits} onChange={(k, v) => setLimits({ ...limits, [k]: v })} />
      <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <legend className="small muted">Estado</legend>
        <div className="checks">
          <label><input type="checkbox" checked={suspended} onChange={(e) => setSuspended(e.target.checked)} /> Empresa suspendida</label>
        </div>
        {suspended && (
          <>
            <Field label="Motivo (opcional)"><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: pago pendiente" /></Field>
            <p className="small muted">Al suspender se cierran todas sus sesiones, nadie de la empresa puede entrar y sus extensiones dejan de registrar. Sus datos se conservan.</p>
          </>
        )}
      </fieldset>
      <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <legend className="small muted">Administradores</legend>
        {company.admins.length ? company.admins.map((a) => (
          <div className="row" key={a.id}>
            <div className="grow"><strong>{a.name}</strong><div className="small muted">{a.email}</div></div>
            <button type="button" className="btn sm" onClick={() => onResetAdmin(a)}>Restablecer contraseña</button>
          </div>
        )) : <span className="small muted">Sin administradores activos.</span>}
      </fieldset>
    </FormModal>
  );
}
