import { useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi } from '../lib/api';
import { fmtDate, ROLE_LABEL, scheduleText } from '../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, Modal, PageHead } from '../components/ui';
import { ScheduleFields, toScheduleValue } from '../components/ScheduleFields';
import type { ScheduleValue } from '../components/ScheduleFields';

interface User { id: string; name: string; email: string; role: string; status: string; teamId: string | null; teamName: string | null; supervisorName: string | null; mustChangePassword: boolean; isDemo: boolean; consentAt: string | null }
interface Team { id: string; name: string; supervisorId: string | null; supervisorName: string | null; members: number }
interface Line { id: string; label: string; channel: string; identifier: string; active: boolean; assignedUserId: string | null; assignedUserName: string | null }
interface Schedule { userId: string; weekdays: number[]; startTime: string; endTime: string }

export function Users() {
  const { me } = useAuth();
  const users = useApi<{ users: User[] }>('/api/users');
  const teams = useApi<{ teams: Team[] }>('/api/teams');
  const lines = useApi<{ lines: Line[] }>('/api/argos/lines');
  const schedules = useApi<{ schedules: Schedule[] }>('/api/argos/schedules');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [editingTeam, setEditingTeam] = useState<Team | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; email: string; password: string } | null>(null);

  if (!users.data || !teams.data || !lines.data || !schedules.data) {
    return users.error ? <ErrorNote error={users.error} /> : <Loading />;
  }
  const reloadAll = () => Promise.all([users.reload(), teams.reload(), lines.reload(), schedules.reload()]);
  const scheduleOf = (id: string) => schedules.data!.schedules.find((s) => s.userId === id);
  const linesOf = (id: string) => lines.data!.lines.filter((l) => l.assignedUserId === id && l.active);

  async function resetPassword(u: User) {
    if (!window.confirm(`¿Restablecer la contraseña de ${u.name}? Se cerrarán sus sesiones.`)) return;
    const res = await api('POST', `/api/users/${u.id}/reset-password`);
    setSecret({ name: u.name, email: u.email, password: res.tempPassword });
    void users.reload();
  }

  return (
    <>
      <PageHead title="Usuarios" subtitle="Cuentas, roles y equipos. Cada cambio queda en auditoría.">
        <button className="btn" onClick={() => setEditingTeam('new')}>Nuevo equipo</button>
        <button className="btn primary" onClick={() => setEditing('new')}>Nuevo usuario</button>
      </PageHead>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nombre</th><th>Rol</th><th>Equipo · Supervisor</th><th>Línea</th><th>Turno programado</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong><span className="sub">{u.email}</span></td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>{u.teamName ?? '—'}{u.teamName && <span className="sub">{u.supervisorName ? `Supervisa: ${u.supervisorName}` : 'Sin supervisor'}</span>}</td>
                  <td>{linesOf(u.id).map((l) => l.label).join(', ') || '—'}</td>
                  <td>{u.role === 'seller' ? scheduleText(scheduleOf(u.id)) : '—'}</td>
                  <td>
                    {u.status === 'active' ? <Badge tone="ok">Activa</Badge> : <Badge>Desactivada</Badge>}
                    {u.mustChangePassword && u.status === 'active' && <span className="sub">Contraseña temporal pendiente</span>}
                    {u.role === 'seller' && u.status === 'active' && <span className="sub">{u.consentAt ? `Aceptó el aviso de registro el ${fmtDate(u.consentAt)}` : 'Aviso de registro sin aceptar'}</span>}
                  </td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => setEditing(u)}>Editar</button>{' '}
                    <button className="btn sm" onClick={() => void resetPassword(u)}>Restablecer contraseña</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Equipos</h2></div>
        {teams.data.teams.length ? (
          <table>
            <thead><tr><th>Equipo</th><th>Supervisor</th><th>Integrantes activos</th><th></th></tr></thead>
            <tbody>
              {teams.data.teams.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td>{t.supervisorName ?? <span className="muted">Sin supervisor</span>}</td>
                  <td>{t.members}</td>
                  <td><button className="btn sm" onClick={() => setEditingTeam(t)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Aún no hay equipos. Crea uno y asígnale un supervisor.</Empty>
        )}
      </div>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === me?.user.id}
          teams={teams.data.teams}
          lines={lines.data.lines}
          schedule={editing === 'new' ? undefined : scheduleOf(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async (created) => {
            setEditing(null);
            await reloadAll();
            if (created) setSecret(created);
          }}
        />
      )}
      {editingTeam && (
        <TeamModal
          team={editingTeam === 'new' ? null : editingTeam}
          supervisors={users.data.users.filter((u) => u.status === 'active' && (u.role === 'supervisor' || u.role === 'admin'))}
          onClose={() => setEditingTeam(null)}
          onSaved={async () => {
            setEditingTeam(null);
            await reloadAll();
          }}
        />
      )}
      {secret && (
        <Modal title="Contraseña temporal" onClose={() => setSecret(null)} footer={<button className="btn primary" onClick={() => setSecret(null)}>Entendido</button>}>
          <div className="modal-body">
            <p>Entrega esta contraseña a <strong>{secret.name}</strong> por un canal seguro. Solo se muestra una vez y deberá cambiarla al entrar a la plataforma web.</p>
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

function UserModal({ user, isSelf, teams, lines, schedule, onClose, onSaved }: {
  user: User | null; isSelf: boolean; teams: Team[]; lines: Line[]; schedule?: Schedule;
  onClose: () => void; onSaved: (created?: { name: string; email: string; password: string }) => Promise<void>;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState(user?.role ?? 'seller');
  const [teamId, setTeamId] = useState(user?.teamId ?? '');
  const [active, setActive] = useState(user ? user.status === 'active' : true);
  const [lineIds, setLineIds] = useState<string[]>(user ? lines.filter((l) => l.assignedUserId === user.id).map((l) => l.id) : []);
  const [sched, setSched] = useState<ScheduleValue>(toScheduleValue(schedule));
  const team = teams.find((t) => t.id === teamId);
  const activeLines = lines.filter((l) => l.active);

  async function save() {
    if (sched.enabled && !sched.weekdays.length) throw new Error('Elige al menos un día para el turno.');
    let id = user?.id;
    let created: { name: string; email: string; password: string } | undefined;
    if (!user) {
      const res = await api('POST', '/api/users', { name, email, role, teamId: teamId || null });
      id = res.user.id;
      created = { name, email, password: res.tempPassword };
    } else {
      await api('PATCH', `/api/users/${user.id}`, { name, role, teamId: teamId || null, status: active ? 'active' : 'disabled' });
    }
    // Líneas: solo se envían las que cambian de persona.
    for (const line of activeLines) {
      const wanted = lineIds.includes(line.id);
      const has = line.assignedUserId === id;
      if (wanted === has) continue;
      await api('PATCH', `/api/argos/lines/${line.id}`, { label: line.label, channel: line.channel, identifier: line.identifier, active: line.active, assignedUserId: wanted ? id : null });
    }
    if (sched.enabled) await api('PUT', `/api/argos/schedules/${id}`, { weekdays: sched.weekdays, startTime: sched.startTime, endTime: sched.endTime });
    else if (schedule) await api('DELETE', `/api/argos/schedules/${id}`);
    await onSaved(created);
  }

  return (
    <FormModal title={user ? `Editar · ${user.name}` : 'Nuevo usuario'} submitLabel={user ? 'Guardar cambios' : 'Crear usuario'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre completo"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Correo" hint={user ? 'El correo no se puede cambiar.' : 'Con este correo iniciará sesión en la web y en la extensión.'}>
        <input type="email" required disabled={Boolean(user)} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <div className="row">
        <div className="grow">
          <Field label="Rol">
            <select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value)}>
              <option value="seller">Vendedora</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Administrador</option>
            </select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Equipo" hint={team ? `Supervisor: ${team.supervisorName ?? 'sin asignar'}` : 'El supervisor se define en el equipo.'}>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Sin equipo</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
      </div>
      {role === 'seller' && (
        <>
          <fieldset className="stack" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
            <legend className="small muted">Líneas asignadas</legend>
            {activeLines.length ? (
              <div className="checks">
                {activeLines.map((l) => (
                  <label key={l.id}>
                    <input type="checkbox" checked={lineIds.includes(l.id)} onChange={(e) => setLineIds(e.target.checked ? [...lineIds, l.id] : lineIds.filter((x) => x !== l.id))} />
                    {l.label}
                    {l.assignedUserId && l.assignedUserId !== user?.id && <span className="muted xs">(ahora: {l.assignedUserName})</span>}
                  </label>
                ))}
              </div>
            ) : (
              <span className="small muted">No hay líneas creadas. Créalas en «Líneas».</span>
            )}
          </fieldset>
          <ScheduleFields value={sched} onChange={setSched} />
        </>
      )}
      {user && !isSelf && (
        <div className="checks">
          <label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Cuenta activa</label>
        </div>
      )}
    </FormModal>
  );
}

function TeamModal({ team, supervisors, onClose, onSaved }: { team: Team | null; supervisors: User[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(team?.name ?? '');
  const [supervisorId, setSupervisorId] = useState(team?.supervisorId ?? '');
  async function save() {
    const body = { name, supervisorId: supervisorId || null };
    if (team) await api('PATCH', `/api/teams/${team.id}`, body);
    else await api('POST', '/api/teams', body);
    await onSaved();
  }
  return (
    <FormModal title={team ? `Editar equipo · ${team.name}` : 'Nuevo equipo'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre del equipo"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Supervisor" hint="Verá y gestionará únicamente a las personas de este equipo.">
        <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
          <option value="">Sin supervisor</option>
          {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name} ({ROLE_LABEL[s.role]})</option>)}
        </select>
      </Field>
    </FormModal>
  );
}
