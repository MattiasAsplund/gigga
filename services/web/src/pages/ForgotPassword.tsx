import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { call } from '../api.ts';
import { Notice } from '../components/ui.tsx';

/**
 * Begäran om ett återställningsmail. Svaret från API:et är detsamma vare sig adressen
 * finns eller inte — annars gick sidan att använda för att kartlägga vilka som har
 * konto — så beskedet här säger "om adressen finns", inte "mailet är skickat".
 */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('/auth/forgot-password', { body: { email } });
      setDone(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1>Kolla mailen</h1>
        <div className="notice" data-testid="reset-requested">
          <strong>Finns {email} hos oss är ett mail på väg.</strong>
          <p className="notice__detail">
            Länken i det leder hit tillbaka, till en sida där du sätter ett nytt lösenord.
            Den gäller i en timme och bara en gång.
          </p>
        </div>
        <p>
          <Link to="/login">Till inloggningen</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Glömt lösenordet</h1>
      <p className="lede">
        Fyll i adressen du registrerade dig med, så kommer ett mail med en länk till en
        sida där du sätter ett nytt lösenord.
      </p>

      <Notice error={error} />

      <form className="stack" onSubmit={submit}>
        <label>
          <span>E-postadress</span>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="email"
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy} data-testid="submit">
            Skicka återställningslänk
          </button>
          <Link to="/login">Jag kom på det</Link>
        </div>
      </form>
    </>
  );
}
