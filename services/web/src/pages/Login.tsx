import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Notice } from '../components/ui.tsx';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate('/requests');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Logga in</h1>
      <p className="lede">
        Adressen måste vara bekräftad. Har du inte klickat länken i bekräftelsemailet
        släpper inloggningen inte igenom.
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
        <label>
          <span>Lösenord</span>
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
            Logga in
          </button>
          <Link to="/register">Skapa konto i stället</Link>
          <Link to="/forgot-password" data-testid="forgot-password">
            Jag har glömt mitt lösenord
          </Link>
        </div>
      </form>
    </>
  );
}
