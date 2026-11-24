import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission, SessionUser } from '@bijliwala/contracts';
import { api, http, tokenStore } from '@/lib/api-client';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** Completes sign-in with the token (and user) returned by an AUTHENTICATED auth step. */
  signIn: (accessToken: string, user?: SessionUser) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Session bootstrap (ARCHITECTURE §8.2): the access token lives in memory only; on load we try a
 * cookie-based refresh and then load /auth/me. The API client refreshes transparently on 401.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);

  const loadMe = useCallback(async () => {
    const me = await api.get<SessionUser>('/auth/me');
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await http.post<{ data: { accessToken: string } }>('/auth/refresh', undefined, {
          skipAuthRefresh: true,
        } as object);
        tokenStore.set(res.data.data.accessToken);
        if (!cancelled) await loadMe();
      } catch {
        if (!cancelled) {
          tokenStore.set(null);
          setStatus('anonymous');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  // If a refresh fails mid-session (e.g. the account was suspended), drop to anonymous.
  useEffect(() => {
    const unsubscribe = tokenStore.subscribe((token) => {
      if (!token) {
        setUser(null);
        setStatus((s) => (s === 'loading' ? s : 'anonymous'));
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(
    async (accessToken: string, signedIn?: SessionUser) => {
      tokenStore.set(accessToken);
      if (signedIn) {
        setUser(signedIn);
        setStatus('authenticated');
        return signedIn;
      }
      return loadMe();
    },
    [loadMe],
  );

  const signOut = useCallback(async () => {
    try {
      await http.post('/auth/logout');
    } finally {
      tokenStore.set(null);
      setUser(null);
      setStatus('anonymous');
      queryClient.clear();
    }
  }, [queryClient]);

  const refreshUser = useCallback(async () => {
    await loadMe();
  }, [loadMe]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn,
      signOut,
      refreshUser,
      can: (permission) => !!user?.permissions.includes(permission),
    }),
    [status, user, signIn, signOut, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** UI-level permission check (ARCHITECTURE §8.2). The server remains the authority. */
export function useCan(permission: Permission): boolean {
  return useAuth().can(permission);
}

export type { SessionUser };
