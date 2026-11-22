import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './auth';
import { api } from './lib/api';
import { ROLE_LABEL } from './lib/format';
import { ArgosLogo, OlympoMark } from './components/brand';
import { Icon } from './components/Icon';

interface Item {
  label: string;
  icon: string;
  to?: string; // sin ruta = módulo previsto, aún no disponible
  roles?: Role[];
  badge?: 'openAlerts' | 'unreadMessages' | 'pendingToday' | 'hermesAttention';
}

interface Counts {
  openAlerts: number;
  unreadMessages: number;
  pendingToday: number;
  hermesAttention: number;
  recentAlerts: { id: string; message: string }[];
}

// Navegación acordada. Un módulo sin ruta se mostraría como "Próximamente" en lugar de una pantalla vacía.
const NAV: { group: string; items: Item[] }[] = [
  {
    group: 'Operación',
    items: [
      { label: 'Dashboard', icon: 'home', to: '/dashboard', roles: ['admin', 'supervisor'] },
      { label: 'Mi turno', icon: 'home', to: '/mi-turno', roles: ['seller'] },
      { label: 'Agenda', icon: 'calendar', to: '/agenda', badge: 'pendingToday' },
      { label: 'Novedades', icon: 'note', to: '/novedades' },
      { label: 'Turnos', icon: 'clock', to: '/turnos', roles: ['admin', 'supervisor'] },
      { label: 'Líneas', icon: 'phone', to: '/lineas', roles: ['admin', 'supervisor'] },
      { label: 'Reportes', icon: 'chart', to: '/reportes', roles: ['admin', 'supervisor'] },
    ],
  },
  {
    group: 'Equipo',
    items: [
      { label: 'Acompañamiento', icon: 'target', to: '/acompanamiento' },
      { label: 'Mensajes', icon: 'message', to: '/mensajes', badge: 'unreadMessages' },
      { label: 'Calidad', icon: 'star', to: '/calidad' },
    ],
  },
  {
    group: 'Hermes · Logística',
    items: [
      { label: 'Pedidos', icon: 'box', to: '/hermes/pedidos', badge: 'hermesAttention' },
      { label: 'Novedades de entrega', icon: 'alert', to: '/hermes/novedades', roles: ['admin', 'supervisor'] },
      { label: 'Panel de entregas', icon: 'chart', to: '/hermes/panel', roles: ['admin', 'supervisor'] },
    ],
  },
  {
    group: 'Administración',
    items: [
      { label: 'Alarmas', icon: 'bell', to: '/alarmas', roles: ['admin', 'supervisor'], badge: 'openAlerts' },
      { label: 'Usuarios', icon: 'users', to: '/usuarios', roles: ['admin'] },
      { label: 'Auditoría', icon: 'shield', to: '/auditoria', roles: ['admin'] },
      { label: 'Configuración', icon: 'settings', to: '/configuracion', roles: ['admin'] },
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

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export function Layout() {
  const { me, logout } = useAuth();
  const counts = useCounts(Boolean(me));
  if (!me) return null;
  const role = me.user.role;
  async function exitSupport() {
    await api('POST', '/api/platform/support/exit').catch(() => {});
    window.location.assign('/plataforma');
  }
  const navLink = (item: Item) => (
    <NavLink key={item.label} to={item.to!}>
      <span className="nav-label"><Icon name={item.icon} />{item.label}</span>
      {item.badge && counts && counts[item.badge] > 0 && (
        <em className="count" aria-label={`${counts[item.badge]} pendientes`}>{counts[item.badge]}</em>
      )}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Argos, inicio">
          <ArgosLogo size={30} />
        </Link>
        <nav className="nav" aria-label="Principal">
          {NAV.map(({ group, items }) => {
            const visible = items.filter((i) => !i.roles || i.roles.includes(role));
            if (!visible.length) return null;
            return (
              <div className="nav-group" key={group}>
                <span>{group}</span>
                {visible.map((item) =>
                  item.to ? navLink(item) : (
                    <div key={item.label} className="soon" aria-disabled="true">
                      <span className="nav-label"><Icon name={item.icon} />{item.label}</span> <em>Próximamente</em>
                    </div>
                  ),
                )}
              </div>
            );
          })}
          {me.user.isPlatformAdmin && (
            <div className="nav-group">
              <span>Plataforma</span>
              {navLink({ label: 'Empresas', icon: 'building', to: '/plataforma' })}
            </div>
          )}
          <div className="nav-group">
            <span>Transparencia</span>
            {navLink({ label: 'Qué se registra', icon: 'eye', to: '/que-se-registra' })}
          </div>
        </nav>
        <div className="sidebar-foot">
          <OlympoMark size={18} />
          <span>Parte de <strong>OLYMPO</strong></span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-company">
            <strong>{me.company.name}</strong>
            {me.company.isDemo && <span className="badge warn plain">Demo</span>}
          </div>
          <div className="topbar-actions">
            {role !== 'seller' && (
              <Link to="/alarmas" className="icon-btn" aria-label={`Alarmas${counts?.openAlerts ? `: ${counts.openAlerts} abiertas` : ''}`}>
                <Icon name="bell" size={20} />
                {Boolean(counts?.openAlerts) && <em className="dot">{counts!.openAlerts}</em>}
              </Link>
            )}
            <Link to="/mensajes" className="icon-btn" aria-label={`Mensajes${counts?.unreadMessages ? `: ${counts.unreadMessages} sin leer` : ''}`}>
              <Icon name="message" size={20} />
              {Boolean(counts?.unreadMessages) && <em className="dot">{counts!.unreadMessages}</em>}
            </Link>
            <div className="topbar-user">
              <span className="avatar" aria-hidden="true">{initials(me.user.name)}</span>
              <div>
                <div className="topbar-name">{me.user.name}</div>
                <div className="xs muted">{ROLE_LABEL[role]}</div>
              </div>
            </div>
            <button className="icon-btn" onClick={() => void logout()} aria-label="Cerrar sesión" title="Cerrar sesión">
              <Icon name="logout" size={20} />
            </button>
          </div>
        </header>

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
