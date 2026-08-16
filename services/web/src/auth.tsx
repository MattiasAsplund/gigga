import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { call } from './api.ts';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  token: string;
  refreshToken: string;
}

interface AuthValue {
  account: Account | null;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, password: string, displayName: string): Promise<Account>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const STORAGE_KEY = 'fastgig.account';

/**
 * Läser `sub` ur vår egen access-token. Ingen verifiering — det gör API:et — men
 * användarens id behövs för att veta om en förfrågan är ens egen, och det finns
 * inget /me-anrop som lämnar ut det.
 */
function subjectOf(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) return '';
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return (JSON.parse(json) as { sub?: string }).sub ?? '';
}

function stored(): Account | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Account) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(stored);

  const value = useMemo<AuthValue>(
    () => ({
      account,

      async signIn(email, password) {
        const session = await call<{ token: string; refreshToken: string }>('/auth/login', {
          body: { email, password },
        });
        const next: Account = {
          id: subjectOf(session.token),
          email,
          displayName: email,
          token: session.token,
          refreshToken: session.refreshToken,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setAccount(next);
      },

      async register(email, password, displayName) {
        const created = await call<Account>('/auth/register', {
          body: { email, password, displayName },
        });
        return created;
      },

      async signOut() {
        if (account) {
          await call('/auth/logout', { method: 'POST', token: account.token }).catch(() => {});
        }
        localStorage.removeItem(STORAGE_KEY);
        setAccount(null);
      },
    }),
    [account],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth utanför AuthProvider');
  return value;
}

/** Token för den inloggade, eller ett tydligt fel om ingen är inloggad. */
export function useToken(): string {
  const { account } = useAuth();
  if (!account) throw new Error('Ingen inloggad session');
  return account.token;
}
