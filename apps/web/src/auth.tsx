import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './lib/api';

export type Role = 'admin' | 'supervisor' | 'seller';
export interface Me {
  user: { id: string; name: string; email: string; role: Role; teamId: string | null; mustChangePassword: boolean; isPlatformAdmin: boolean };
  company: { id: string; name: string; timezone: string; isDemo: boolean; products: string[] };
  /** true si quien opera la plataforma está dentro de esta empresa en modo soporte. */
  support: boolean;
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({ me: null, loading: true, refresh: async () => {}, logout: async () => {} });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/api/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('olympo:unauthorized', onUnauthorized);
    return () => window.removeEventListener('olympo:unauthorized', onUnauthorized);
  }, [refresh]);

  return <AuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}
