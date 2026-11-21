import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './auth';
import { api } from './lib/api';
import { ROLE_LABEL } from './lib/format';

interface Item {
  label: string;
  to?: string; // sin ruta = módulo previsto, aún no disponible
  roles?: Role[];
  badge?: 'openAlerts' | 'unreadMessages' | 'pendingToday';
}

interface Counts {
  openAlerts: number;
  unreadMessages: number;
  pendingToday: number;
  recentAlerts: { id: string; message: string }[];
}

// Navegación acordada. Un módulo sin ruta se mostraría como "Próximamente" en lugar de una pantalla vacía.
const NAV: { group: string; items: Item[] }[] = [
  {
    group: 'Operación',
    items: [
      { label: 'Agenda', to: '/agenda', badge: 'pendingToday' },
      { label: 'Dashboard', to: '/dashboard', roles: ['admin', 'supervisor'] },
      { label: 'Mi turno', to: '/mi-turno', roles: ['seller'] },
      { label: 'Novedades', to: '/novedades' },
      { label: 'Turnos', to: '/turnos', roles: ['admin', 'supervisor'] },
      { label: 'Líneas', to: '/lineas', roles: ['admin', 'supervisor'] },
      { label: 'Reportes', to: '/reportes', roles: ['admin', 'supervisor'] },
    ],
  },
  {
    group: 'Equipo',
    items: [{ label: 'Acompañamiento', to: '/acompanamiento' }, { label: 'Mensajes', to: '/mensajes', badge: 'unreadMessages' }, { label: 'Calidad', to: '/calidad' }],
  },
  {
    group: 'Administración',
    items: [
      { label: 'Alarmas', to: '/alarmas', roles: ['admin', 'supervisor'], badge: 'openAlerts' },
      { label: 'Usuarios', to: '/usuarios', roles: ['admin'] },
      { label: 'Auditoría', to: '/auditoria', roles: ['admin'] },
      { label: 'Configuración', to: '/configuracion', roles: ['admin'] },
    ],
  },
];

/** Contadores del menú. Si el navegador tiene permiso, avisa también de cada alerta nueva. */
function useCounts(enabled: boolean): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const next = await api<Counts>('GET', '/api/argos/notifications');
        if (!alive) return;
        if (seen.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          for (const a of next.recentAlerts) if (!seen.current.has(a.id)) new Notification('Argos · alerta', { body: a.message, tag: a.id });
        }
        seen.current = new Set(next.recentAlerts.map((a) => a.id));
        setCounts(next);
      } catch {
        /* el menú sigue funcionando sin contadores */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    const refresh = () => void load();
    window.addEventListener('olympo:notifications', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('olympo:notifications', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);
  return counts;
}

export function Layout() {
  const { me, logout } = useAuth();
  const counts = useCounts(Boolean(me));
  if (!me) return null;
  const role = me.user.role;
  async function exitSupport() {
    await api('POST', '/api/platform/support/exit').catch(() => {});
    window.location.assign('/plataforma');
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        {/* Marca en texto con los colores de la propuesta. Sustituir por el logotipo SVG de Argos cuando esté exportado. */}
        <div className="brand">
          <strong>Argos</strong>
          <span>OLYMPO · {me.company.name}</span>
        </div>
        <nav className="nav" aria-label="Principal">
          {NAV.map(({ group, items }) => {
            const visible = items.filter((i) => !i.roles || i.roles.includes(role));
            if (!visible.length) return null;
            return (
              <div className="nav-group" key={group}>
                <span>{group}</span>
                {visible.map((item) =>
                  item.to ? (
                    <NavLink key={item.label} to={item.to}>
                      {item.label}
                      {item.badge && counts && counts[item.badge] > 0 && (
                        <em className="count" aria-label={`${counts[item.badge]} pendientes`}>{counts[item.badge]}</em>
                      )}
                    </NavLink>
                  ) : (
                    <div key={item.label} className="soon" aria-disabled="true">
                      {item.label} <em>Próximamente</em>
                    </div>
                  ),
                )}
              </div>
            );
          })}
          {me.user.isPlatformAdmin && (
            <div className="nav-group">
              <span>Plataforma</span>
              <NavLink to="/plataforma">Empresas</NavLink>
            </div>
          )}
          <div className="nav-group">
            <span>Transparencia</span>
            <NavLink to="/que-se-registra">Qué se registra</NavLink>
          </div>
        </nav>
        <div className="sidebar-foot">
          <div>
            <div style={{ color: 'var(--color-sidebar-strong)', fontWeight: 600 }}>{me.user.name}</div>
            <div className="xs" style={{ color: 'var(--color-sidebar-muted)' }}>
              {ROLE_LABEL[role]}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => void logout()}>
            Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="main">
        {me.support && (
          <div className="demo-banner" role="alert" style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>
            <strong>Modo soporte en {me.company.name}.</strong> Estás viendo los datos de un cliente con su permiso; todo lo que hagas queda en su auditoría.{' '}
            <button className="btn sm" onClick={() => void exitSupport()}>Salir del modo soporte</button>
          </div>
        )}
        {me.company.isDemo && (
          <div className="demo-banner" role="note">
            <strong>Entorno de demostración.</strong> Las cuentas, equipos y líneas son ficticios. La actividad que veas proviene únicamente de turnos reales hechos con la extensión.
          </div>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
