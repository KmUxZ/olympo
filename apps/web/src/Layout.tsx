import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './auth';
import { api } from './lib/api';
import { ROLE_LABEL } from './lib/format';

interface Item {
  label: string;
  to?: string; // sin ruta = módulo previsto, aún no disponible
  roles?: Role[];
}

// Navegación acordada. Los módulos sin ruta se muestran como "Próximamente" en lugar de pantallas vacías.
const NAV: { group: string; items: Item[] }[] = [
  {
    group: 'Operación',
    items: [
      { label: 'Agenda' },
      { label: 'Dashboard', to: '/dashboard', roles: ['admin', 'supervisor'] },
      { label: 'Mi turno', to: '/mi-turno', roles: ['seller'] },
      { label: 'Novedades', to: '/novedades' },
      { label: 'Turnos', to: '/turnos', roles: ['admin', 'supervisor'] },
      { label: 'Líneas', to: '/lineas', roles: ['admin', 'supervisor'] },
      { label: 'Reportes', roles: ['admin', 'supervisor'] },
    ],
  },
  {
    group: 'Equipo',
    items: [{ label: 'Acompañamiento' }, { label: 'Mensajes' }, { label: 'Calidad' }],
  },
  {
    group: 'Administración',
    items: [
      { label: 'Alarmas', roles: ['admin'] },
      { label: 'Usuarios', to: '/usuarios', roles: ['admin'] },
      { label: 'Auditoría', to: '/auditoria', roles: ['admin'] },
      { label: 'Configuración', to: '/configuracion', roles: ['admin'] },
    ],
  },
];

export function Layout() {
  const { me, logout } = useAuth();
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
