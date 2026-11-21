import { StrictMode } from 'react';
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
import './styles/base.css';

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
  const home = me.user.role === 'seller' ? '/mi-turno' : '/dashboard';
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<Only roles={['admin', 'supervisor']}><Dashboard /></Only>} />
        <Route path="/mi-turno" element={<MyShift />} />
        <Route path="/novedades" element={<Incidents />} />
        <Route path="/turnos" element={<Only roles={['admin', 'supervisor']}><Shifts /></Only>} />
        <Route path="/lineas" element={<Only roles={['admin', 'supervisor']}><Lines /></Only>} />
        <Route path="/usuarios" element={<Only roles={['admin']}><Users /></Only>} />
        <Route path="/auditoria" element={<Only roles={['admin']}><Audit /></Only>} />
        <Route path="/configuracion" element={<Only roles={['admin']}><Settings /></Only>} />
        <Route path="/que-se-registra" element={<Privacy />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
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
