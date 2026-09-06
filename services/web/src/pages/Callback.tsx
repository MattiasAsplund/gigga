import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { userManager } from '../auth.tsx';

/**
 * Landningen tillbaka från Keycloak.
 *
 * Sidan finns bara för att växla in koden i en token och sedan komma ur vägen. Adressen
 * bär `code` och `state` i frågesträngen, och `replace` gör att en bakåtknapp inte
 * skickar användaren tillbaka in i ett redan förbrukat utbyte.
 */
export function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const user = await userManager.signinRedirectCallback();
        const from = (user.state as { from?: string } | undefined)?.from;
        navigate(from && from !== '/callback' ? from : '/requests', { replace: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Inloggningen kunde inte slutföras.');
      }
    })();
  }, [navigate]);

  if (error) {
    return (
      <section className="panel">
        <h1>Inloggningen gick inte igenom</h1>
        <p className="error" data-testid="callback-error">
          {error}
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <p data-testid="callback-pending">Loggar in…</p>
    </section>
  );
}
