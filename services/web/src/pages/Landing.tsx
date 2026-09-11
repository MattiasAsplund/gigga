import { useState } from 'react';
import { useAuth } from '../auth.tsx';
import { _ } from '../i18n.ts';

/**
 * Den enda öppna sidan.
 *
 * Den finns för utloggningens skull. Skickar man den utloggade rakt in i katalogen
 * märker RequireAuth att ingen är inloggad och skickar vidare till Keycloak — och då går
 * det inte att vara utloggad: man hamnar i inloggningen igen, varje gång. Här landar man
 * istället, och går vidare när man själv vill.
 */
export function Landing() {
  const { signIn, loading } = useAuth();
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <section className="panel stack">
      <h1>gigga</h1>
      <p>{_('landing.intro')}</p>
      <p>{_('landing.accounts')}</p>
      <button
        onClick={() =>
          signIn().catch((cause: unknown) =>
            // En knapp som tyst inte gör något är värre än ett fel. Går omdirigeringen
            // inte att starta — Keycloak nere, eller en osäker origin där webbläsaren
            // saknar crypto.subtle och PKCE därmed inte går att räkna ut — ska det synas.
            setFailed(cause instanceof Error ? cause.message : String(cause)),
          )
        }
        disabled={loading}
        data-testid="login"
      >
        {_('landing.login')}
      </button>
      {failed && (
        <p className="error" data-testid="signin-error">
          {_('landing.signInFailed', { reason: failed })}
        </p>
      )}
    </section>
  );
}
