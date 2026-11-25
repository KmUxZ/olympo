import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import type { Role } from './auth';
import { Layout } from './Layout';
import { Loading } from './components/ui';
import { ChangePassword, Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Shifts } from './pages/Shifts';
import { MyShift } from './pages/MyShift';
import { Incidents } from './pages/Incidents';
import { Lines } from './pages/Lines';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { Privacy } from './pages/Privacy';
import { Platform } from './pages/Platform';
import { Alarms } from './pages/Alarms';
import { Reports } from './pages/Reports';
import { Agenda } from './pages/Agenda';
import { Messages } from './pages/Messages';
import { Coaching } from './pages/Coaching';
import { Quality } from './pages/Quality';
import { HermesOrders } from './pages/hermes/Orders';
import { HermesChats } from './pages/hermes/Chats';
import { HermesBlocked } from './pages/hermes/Blocked';
import { HermesIncidents } from './pages/hermes/Incidents';
import { HermesPanel } from './pages/hermes/Panel';
import { AthenaChats } from './pages/athena/Chats';
import { AthenaCatalog } from './pages/athena/Catalog';
import { AthenaSettings } from './pages/athena/Settings';
import { ZeusCustomers } from './pages/zeus/Customers';
import { ZeusRepurchase } from './pages/zeus/Repurchase';
import { ZeusFollowups } from './pages/zeus/Followups';
import { InstallGuide } from './pages/InstallGuide';
import { api } from './lib/api';
import '@fontsource-variable/montserrat/wght.css';
import './styles/base.css';

/**
 * Puerta de entrada de las vendedoras: sin la extensión conectada, Argos no puede registrar su turno,
 * así que primero ven la guía de instalación. Se abre sola cuando la extensión inicia sesión.
 */
function ExtensionGate({ active, children }: { active: boolean; children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'needed' | 'open'>(active ? 'checking' : 'open');
  useEffect(() => {
    if (!active) return setState('open');
    if (sessionStorage.getItem('argos.guia.omitida') === '1') return setState('open');
    api<{ connected: boolean }>('GET', '/api/argos/extension/status').then((s) => setState(s.connected ? 'open' : 'needed')).catch(() => setState('open'));
  }, [active]);
  if (state === 'checking') return <Loading />;
  if (state === 'needed') {
    return (
      <InstallGuide
        gate
        onDone={() => {
          try { sessionStorage.setItem('argos.guia.omitida', '1'); } catch { /* sin almacenamiento: se entra igual */ }
          setState('open');
        }}
      />
    );
  }
  return <>{children}</>;
}

function Only({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { me } = useAuth();
  // El servidor aplica los permisos; esto solo evita mostrar pantallas que responderían "sin permiso".
  return me && roles.includes(me.user.role) ? <>{children}</> : <Navigate to="/" replace />;
}

function App() {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Login />;
  if (me.user.mustChangePassword) return <ChangePassword forced />;
  // Cada empresa ve solo los productos que tiene contratados.
  const has = (p: string) => me.company.products.includes(p);
  const home = has('argos') ? (me.user.role === 'seller' ? '/mi-turno' : '/dashboard') : has('hermes') ? '/hermes/pedidos' : has('athena') && me.user.role !== 'seller' ? '/athena/conversaciones' : '/usuarios';
  return (
    <ExtensionGate active={me.user.role === 'seller' && has('argos') && !me.support}>
    <Routes>
      <Route element={<Layout />}>
        {has('argos') && (
          <>
            <Route path="/dashboard" element={<Only roles={['admin', 'supervisor']}><Dashboard /></Only>} />
            <Route path="/mi-turno" element={<MyShift />} />
            <Route path="/novedades" element={<Incidents />} />
            <Route path="/turnos" element={<Only roles={['admin', 'supervisor']}><Shifts /></Only>} />
            <Route path="/lineas" element={<Only roles={['admin', 'supervisor']}><Lines /></Only>} />
            <Route path="/configuracion" element={<Only roles={['admin']}><Settings /></Only>} />
            <Route path="/agenda" element={<Agenda />} />
            <Route path="/mensajes" element={<Messages />} />
            <Route path="/acompanamiento" element={<Coaching />} />
            <Route path="/calidad" element={<Quality />} />
            <Route path="/reportes" element={<Only roles={['admin', 'supervisor']}><Reports /></Only>} />
            <Route path="/alarmas" element={<Only roles={['admin', 'supervisor']}><Alarms /></Only>} />
            <Route path="/que-se-registra" element={<Privacy />} />
            <Route path="/instalar-extension" element={<InstallGuide />} />
          </>
        )}
        {has('hermes') && (
          <>
            <Route path="/hermes/chats" element={<Only roles={['admin', 'supervisor']}><HermesChats /></Only>} />
            <Route path="/hermes/pedidos" element={<HermesOrders />} />
            <Route path="/hermes/novedades" element={<Only roles={['admin', 'supervisor']}><HermesIncidents /></Only>} />
            <Route path="/hermes/bloqueados" element={<Only roles={['admin', 'supervisor']}><HermesBlocked /></Only>} />
            <Route path="/hermes/panel" element={<Only roles={['admin', 'supervisor']}><HermesPanel /></Only>} />
          </>
        )}
        {has('athena') && (
          <>
            <Route path="/athena/conversaciones" element={<Only roles={['admin', 'supervisor']}><AthenaChats /></Only>} />
            <Route path="/athena/catalogo" element={<Only roles={['admin', 'supervisor']}><AthenaCatalog /></Only>} />
            <Route path="/athena/ajustes" element={<Only roles={['admin', 'supervisor']}><AthenaSettings /></Only>} />
          </>
        )}
        {has('zeus') && (
          <>
            <Route path="/zeus" element={<Navigate to={me.user.role === 'seller' ? '/zeus/seguimientos' : '/zeus/clientes'} replace />} />
            <Route path="/zeus/clientes" element={<Only roles={['admin', 'supervisor']}><ZeusCustomers /></Only>} />
            <Route path="/zeus/recompra" element={<Only roles={['admin', 'supervisor']}><ZeusRepurchase /></Only>} />
            <Route path="/zeus/seguimientos" element={<ZeusFollowups />} />
          </>
        )}
        <Route path="/usuarios" element={<Only roles={['admin']}><Users /></Only>} />
        <Route path="/auditoria" element={<Only roles={['admin']}><Audit /></Only>} />
        {me.user.isPlatformAdmin && <Route path="/plataforma" element={<Platform />} />}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
    </ExtensionGate>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
