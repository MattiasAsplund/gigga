import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { call } from '../api.ts';
import { Notice } from '../components/ui.tsx';

/**
 * Målet för länken i återställningsmailet. Till skillnad från bekräftelselänken går den
 * inte att utföra med ett klick — ett nytt lösenord behövs, alltså ett formulär, och
 * koden ur länken följer med som ett dolt fält.
 *
 * Återställningen stänger alla sessioner, även den här webbläsarens. Därför skickas
 * ingen vidare in i appen efteråt, utan till inloggningen.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ reset: boolean; email: string }>('/auth/reset-password', {
        body: { token, password },
      });
      setEmail(result.email);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (email) {
    return (
      <>
        <h1>Lösenordet är bytt</h1>
        <div className="notice" data-testid="password-reset">
          <strong>{email} har ett nytt lösenord.</strong>
          <p className="notice__detail">
            Alla inloggningar sedan tidigare är avslutade — logga in på nytt med det du
            just satte.
          </p>
        </div>
        <p>
          <Link to="/login">Logga in</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Sätt ett nytt lösenord</h1>

      {token ? (
        <p className="lede">Koden ur mailet följer med länken. Skriv det nya lösenordet.</p>
      ) : (
        <Notice message="Länken saknar kod. Begär en ny återställning från inloggningen." />
      )}

      <Notice error={error} />

      {token && (
        <form className="stack" onSubmit={submit}>
          <label>
            <span>Nytt lösenord — minst 12 tecken</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="password"
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy} data-testid="submit">
              Byt lösenord
            </button>
            <Link to="/login">Till inloggningen</Link>
          </div>
        </form>
      )}
    </>
  );
}
