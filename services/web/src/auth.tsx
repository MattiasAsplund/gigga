import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { ApiError, call, type Problem } from './api.ts';

/**
 * Den inloggades identitet, hämtad ur API:et — inte ur token.
 *
 * Keycloaks `sub` är *inte* `users.id`, och det är lokala id:n ägarskapen i svaren
 * jämförs mot. Därför frågar vi /me istället för att avkoda token, som förr.
 */
export interface Account {
  id: string;
  email: string;
  displayName: string;
  organization: { id: string; alias: string; name: string };
}

interface AuthValue {
  account: Account | null;
  /** Sant medan sessionen läses in — skiljer "inte inloggad" från "vet inte än". */
  loading: boolean;
  /**
   * Sant när Keycloak gett oss en giltig token. Skilt från `account`, som kräver att
   * API:et också känns vid kontot.
   */
  signedIn: boolean;
  /**
   * Inloggad, men avvisad av API:et — typiskt ett nyss bekräftat konto som ännu inte hör
   * till någon organisation. Att skicka en sådan användare till inloggningen igen vore
   * fel svar på fel fråga: sessionen är i sin ordning, det är kontot som saknar något.
   */
  blocked: Problem | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Keycloak nås under /auth på webbens egen origin, proxad av Vite. Att bygga authority
 * ur `window.location.origin` istället för en inbyggd adress är vad som gör att samma
 * bygge fungerar på localhost, från e2e-containern och bakom en cloudflare-tunnel —
 * issuern i token blir den adress webbläsaren faktiskt använde.
 */
const authority = `${window.location.origin}/auth/realms/fastgig`;

export const userManager = new UserManager({
  authority,
  client_id: 'fastgig-web',
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',
  scope: 'openid profile email organization',
  // Tokens i sessionStorage och inte localStorage: de överlever en omladdning men inte
  // en stängd flik, och delas inte mellan fönster som råkar vara olika inloggningar.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
  monitorSession: false,
});

/** Token för utgående anrop. Läses vid varje anrop — den byts ut vid tyst förnyelse. */
let current: User | null = null;

export function currentToken(): string {
  if (!current) throw new Error('Ingen inloggad session');
  return current.access_token;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [blocked, setBlocked] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function adopt(user: User | null): Promise<void> {
      current = user;
      if (!user || user.expired) {
        if (alive) {
          setAccount(null);
          setSignedIn(false);
          setBlocked(null);
          setLoading(false);
        }
        return;
      }

      /*
       * Första anropet med en ny token skapar också speglingen i API:et.
       *
       * Felet får inte slås ihop med "ingen är inloggad". Ett nyss bekräftat konto som
       * ännu inte kopplats till en organisation svarar `403 organization-missing`, och
       * att då tolka det som utloggad skickar användaren till inloggningen — som loggar
       * in igen, och studsar tillbaka. Beskedet finns i svaret; det ska visas.
       */
      let me: Account | null = null;
      let problem: Problem | null = null;
      try {
        me = await call<Account>('/me', { token: user.access_token });
      } catch (cause) {
        problem =
          cause instanceof ApiError
            ? cause.problem
            : {
                type: 'about:blank',
                title: 'API:et gick inte att nå',
                status: 0,
                detail: cause instanceof Error ? cause.message : String(cause),
              };
      }

      if (alive) {
        setAccount(me);
        setSignedIn(true);
        setBlocked(problem);
        setLoading(false);
      }
    }

    void userManager.getUser().then(adopt);

    const onLoaded = (user: User) => void adopt(user);
    const onUnloaded = () => void adopt(null);
    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);

    return () => {
      alive = false;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
    };
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      account,
      loading,
      signedIn,
      blocked,
      // Ett enda sätt in. Keycloaks inloggningssida bär registreringslänken själv
      // (`registrationAllowed` i realmet), så gigga behöver ingen egen väg till ett
      // formulär Keycloak redan äger — och kan därmed inte råka gå förbi kravet på
      // bekräftad adress.
      signIn: () => userManager.signinRedirect({ state: { from: window.location.pathname } }),
      signOut: () => userManager.signoutRedirect(),
    }),
    [account, loading, signedIn, blocked],
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
  return currentToken();
}
