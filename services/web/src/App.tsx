import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.tsx';
import { Login } from './pages/Login.tsx';
import { Register } from './pages/Register.tsx';
import { Verify } from './pages/Verify.tsx';
import { ForgotPassword } from './pages/ForgotPassword.tsx';
import { ResetPassword } from './pages/ResetPassword.tsx';
import { Catalog } from './pages/Catalog.tsx';
import { NewRequest } from './pages/NewRequest.tsx';
import { RequestDetail } from './pages/RequestDetail.tsx';
import { MyRequests } from './pages/MyRequests.tsx';
import { MyBids } from './pages/MyBids.tsx';
import { BidDetail } from './pages/BidDetail.tsx';
import type { ReactElement } from 'react';

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
              <button className="quiet" onClick={() => void signOut()} data-testid="logout">
                Logga ut
              </button>
            </>
          ) : (
            <nav className="primary" aria-label="Konto">
              <NavLink to="/login">Logga in</NavLink>
              <NavLink to="/register">Skapa konto</NavLink>
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}

/** Skyddad route: utan inloggning skickas man till inloggningen, inte till ett tomt skal. */
function RequireAuth({ children }: { children: ReactElement }) {
  const { account } = useAuth();
  const location = useLocation();

  if (!account) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

function Shell() {
  const { account } = useAuth();

  return (
    <>
      <Masthead />
      <main className="page">
        <Routes>
          <Route
            path="/"
            element={<Navigate to={account ? '/requests' : '/login'} replace />}
          />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

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
