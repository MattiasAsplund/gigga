import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.tsx';
import { Callback } from './pages/Callback.tsx';
import { Landing } from './pages/Landing.tsx';
import { Catalog } from './pages/Catalog.tsx';
import { NewRequest } from './pages/NewRequest.tsx';
import { RequestDetail } from './pages/RequestDetail.tsx';
import { RequestSpec } from './pages/RequestSpec.tsx';
import { MyRequests } from './pages/MyRequests.tsx';
import { MyBids } from './pages/MyBids.tsx';
import { BidDetail } from './pages/BidDetail.tsx';
import { useEffect, useRef, useState, type ReactElement } from 'react';

function Masthead() {
  const { account, signOut } = useAuth();

  return (
    <header className="masthead">
      <div className="masthead__inner">
        <NavLink to="/" className="wordmark">
          gigga
        </NavLink>

        {account && (
          <nav className="primary" aria-label="Huvudmeny">
            <NavLink to="/requests">Katalog</NavLink>
            <NavLink to="/requests/new">Ny förfrågan</NavLink>
            <NavLink to="/me/requests">Mina förfrågningar</NavLink>
            <NavLink to="/me/bids">Mina anbud</NavLink>
          </nav>
        )}

        <div className="identity">
          {account ? (
            <>
              <span data-testid="current-user">{account.email}</span>
              <span data-testid="current-organization" className="quiet">
                {account.organization.name}
              </span>
              <button className="quiet" onClick={() => void signOut()} data-testid="logout">
                Logga ut
              </button>
            </>
          ) : (
            <NavLink to="/">Logga in</NavLink>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Skyddad route: utan inloggning skickas man till Keycloak, inte till ett tomt skal.
 *
 * `loading` är inte kosmetik. Sessionen läses ur sessionStorage asynkront, och utan
 * väntan hade en omladdning av en skyddad sida hunnit se `account === null` och skickat
 * iväg en redan inloggad användare på en ny inloggningsrunda.
 */
function RequireAuth({ children }: { children: ReactElement }) {
  const { account, loading, signedIn, blocked, signIn, signOut } = useAuth();
  const location = useLocation();
  const [failed, setFailed] = useState<string | null>(null);
  // En gång per montering. Utan spärren startar varje omrendering en ny omdirigering,
  // och två samtidiga avbryter varandra — sidan blir stående på "skickar dig vidare".
  const sent = useRef(false);

  useEffect(() => {
    // Bara den som *inte* är inloggad ska skickas till Keycloak. Den som är inloggad men
    // avvisad av API:et har redan en giltig session — en ny inloggning hade gett samma
    // token tillbaka och studsat användaren fram och tillbaka utan att säga varför.
    if (loading || account || signedIn || sent.current) return;
    sent.current = true;
    signIn().catch((cause: unknown) =>
      setFailed(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [loading, account, signedIn, signIn, location.pathname]);

  if (loading) return <p className="panel">Läser in sessionen…</p>;
  if (failed) {
    // Hellre ett besked än en sida som ser ut att ladda för alltid: går Keycloak inte att
    // nå är det inget väntan löser.
    return (
      <section className="panel">
        <h1>Inloggningen kunde inte startas</h1>
        <p className="error" data-testid="signin-error">{failed}</p>
      </section>
    );
  }
  if (blocked) {
    return (
      <section className="panel stack" data-testid="blocked">
        <h1>{blocked.title}</h1>
        <p>{blocked.detail}</p>
        <button className="quiet" onClick={() => void signOut()} data-testid="logout">
          Logga ut
        </button>
      </section>
    );
  }
  if (!account) return <p className="panel">Skickar dig till inloggningen…</p>;
  return children;
}

function Shell() {
  // `signedIn` och inte `account`: den som är inloggad men avvisad av API:et ska föras
  // vidare till RequireAuth, som visar skälet — inte mötas av inloggningsknappen igen.
  const { signedIn } = useAuth();

  return (
    <>
      <Masthead />
      <main className="page">
        <Routes>
          {/* Öppen landningssida. Den inloggade skickas vidare till katalogen; den
              utloggade får stanna. Se kommentaren i pages/Landing.tsx. */}
          <Route
            path="/"
            element={signedIn ? <Navigate to="/requests" replace /> : <Landing />}
          />
          <Route path="/callback" element={<Callback />} />

          <Route
            path="/requests"
            element={
              <RequireAuth>
                <Catalog />
              </RequireAuth>
            }
          />
          <Route
            path="/requests/new"
            element={
              <RequireAuth>
                <NewRequest />
              </RequireAuth>
            }
          />
          <Route
            path="/requests/:requestId"
            element={
              <RequireAuth>
                <RequestDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/requests/:requestId/spec"
            element={
              <RequireAuth>
                <RequestSpec />
              </RequireAuth>
            }
          />
          <Route
            path="/me/requests"
            element={
              <RequireAuth>
                <MyRequests />
              </RequireAuth>
            }
          />
          <Route
            path="/me/bids"
            element={
              <RequireAuth>
                <MyBids />
              </RequireAuth>
            }
          />
          <Route
            path="/bids/:bidId"
            element={
              <RequireAuth>
                <BidDetail />
              </RequireAuth>
            }
          />

          <Route path="*" element={<p className="empty">Sidan finns inte.</p>} />
        </Routes>
      </main>
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
