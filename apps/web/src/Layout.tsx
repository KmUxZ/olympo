import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './auth';
import { api } from './lib/api';
import { ROLE_LABEL } from './lib/format';
import { OlympoMark, PRODUCT_INFO } from './components/brand';
import { Icon } from './components/Icon';

interface Item {
  label: string;
  icon: string;
  to?: string; // sin ruta = módulo previsto, aún no disponible
  roles?: Role[];
  badge?: 'openAlerts' | 'unreadMessages' | 'pendingToday' | 'hermesAttention';
}
type Group = { group: string; items: Item[] };

interface Counts {
  openAlerts: number;
  unreadMessages: number;
  pendingToday: number;
  hermesAttention: number;
  recentAlerts: { id: string; message: string }[];
}

// Cada producto del ecosistema tiene su propio menú. La cuenta (usuarios, auditoría) es común a todos.
const NAV: Record<string, Group[]> = {
  argos: [
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
      group: 'Ajustes de Argos',
      items: [
        { label: 'Alarmas', icon: 'bell', to: '/alarmas', roles: ['admin', 'supervisor'], badge: 'openAlerts' },
        { label: 'Configuración', icon: 'settings', to: '/configuracion', roles: ['admin'] },
        { label: 'Qué se registra', icon: 'eye', to: '/que-se-registra' },
      ],
    },
  ],
  hermes: [
    {
      group: 'Logística',
      items: [
        { label: 'Chats', icon: 'message', to: '/hermes/chats', roles: ['admin', 'supervisor'], badge: 'hermesAttention' },
        { label: 'Pedidos', icon: 'box', to: '/hermes/pedidos' },
        { label: 'Novedades de entrega', icon: 'alert', to: '/hermes/novedades', roles: ['admin', 'supervisor'] },
        { label: 'Panel de entregas', icon: 'chart', to: '/hermes/panel', roles: ['admin', 'supervisor'] },
      ],
    },
  ],
};
const ACCOUNT: Group = {
  group: 'Cuenta',
  items: [
    { label: 'Usuarios', icon: 'users', to: '/usuarios', roles: ['admin'] },
    { label: 'Auditoría', icon: 'shield', to: '/auditoria', roles: ['admin'] },
  ],
};

/** A qué producto pertenece la pantalla actual. Las de cuenta conservan el último producto visitado. */
function productOf(pathname: string, fallback: string): string {
  if (pathname.startsWith('/hermes')) return 'hermes';
  if (['/usuarios', '/auditoria', '/plataforma'].some((p) => pathname.startsWith(p))) return fallback;
  return 'argos';
}

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
  const location = useLocation();
  const counts = useCounts(Boolean(me));
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const lastProduct = useRef('argos');
  const switcherRef = useRef<HTMLDivElement>(null);

  // El selector se cierra al cambiar de pantalla, con Escape o al pulsar fuera.
  useEffect(() => setSwitcherOpen(false), [location.pathname]);
  useEffect(() => {
    if (!switcherOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSwitcherOpen(false);
    const onClick = (e: MouseEvent) => !switcherRef.current?.contains(e.target as Node) && setSwitcherOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [switcherOpen]);

  if (!me) return null;
  const role = me.user.role;
  const owned = me.company.products.filter((p) => PRODUCT_INFO[p]?.available);
  let product = productOf(location.pathname, lastProduct.current);
  if (!owned.includes(product)) product = owned[0] ?? 'argos';
  lastProduct.current = product;
  const info = PRODUCT_INFO[product];
  document.title = `${info.name} · OLYMPO`;

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
  const groups = [...(NAV[product] ?? []), ACCOUNT];
  // Pendientes del otro producto, para avisar en el selector.
  const pendingIn = (p: string) => (!counts ? 0 : p === 'hermes' ? counts.hermesAttention : counts.openAlerts + counts.unreadMessages);
  const others = owned.filter((p) => p !== product);
  const otherPending = others.reduce((n, p) => n + pendingIn(p), 0);

  return (
    <div className="shell" data-product={product}>
      <aside className="sidebar">
        <div className="switcher" ref={switcherRef}>
          <button className="brand" aria-haspopup="menu" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen((v) => !v)}>
            <span className="logo">
              <info.Mark size={30} />
              <span>
                <span className="logo-word">{info.name}</span>
                <span className="logo-tag">{info.tagline}</span>
              </span>
            </span>
            <span className="switcher-caret" aria-hidden="true">
              {otherPending > 0 && <em className="count">{otherPending}</em>}
              <Icon name="chevron" size={16} />
            </span>
            <span className="sr-only">Cambiar de producto</span>
          </button>
          {switcherOpen && (
            <div className="switcher-menu" role="menu">
              <div className="switcher-title"><OlympoMark size={16} /> Productos de OLYMPO</div>
              {Object.entries(PRODUCT_INFO).map(([key, p]) => {
                const has = owned.includes(key);
                const body = (
                  <>
                    <p.Mark size={26} />
                    <span className="switcher-name"><strong>{p.name}</strong><span>{p.tagline}</span></span>
                    {key === product ? <span className="badge ok plain">Aquí</span> : has ? pendingIn(key) > 0 && <em className="count">{pendingIn(key)}</em> : <span className="badge plain">{p.available ? 'No contratado' : 'Próximamente'}</span>}
                  </>
                );
                return has ? (
                  <Link key={key} to={p.home} role="menuitem" className={`switcher-item ${key === product ? 'current' : ''}`}>{body}</Link>
                ) : (
                  <div key={key} className="switcher-item disabled" aria-disabled="true">{body}</div>
                );
              })}
            </div>
          )}
        </div>

        <nav className="nav" aria-label={`Menú de ${info.name}`}>
          {groups.map(({ group, items }) => {
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
            {role !== 'seller' && owned.includes('argos') && (
              <Link to="/alarmas" className="icon-btn" aria-label={`Alarmas${counts?.openAlerts ? `: ${counts.openAlerts} abiertas` : ''}`}>
                <Icon name="bell" size={20} />
                {Boolean(counts?.openAlerts) && <em className="dot">{counts!.openAlerts}</em>}
              </Link>
            )}
            {owned.includes('argos') && (
              <Link to="/mensajes" className="icon-btn" aria-label={`Mensajes${counts?.unreadMessages ? `: ${counts.unreadMessages} sin leer` : ''}`}>
                <Icon name="message" size={20} />
                {Boolean(counts?.unreadMessages) && <em className="dot">{counts!.unreadMessages}</em>}
              </Link>
            )}
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
            <strong>Entorno de demostración.</strong> Las cuentas, equipos y líneas son ficticios.
          </div>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
