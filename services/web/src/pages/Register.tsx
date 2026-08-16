import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Notice } from '../components/ui.tsx';

export function Register() {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, password, displayName);
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
        <h1>Kontot är skapat</h1>
        <div className="notice" data-testid="registered">
          <strong>Bekräfta din e-postadress.</strong>
          <p className="notice__detail">
            Ett mail är på väg till {email}. Klicka länken i det innan du loggar in —
            fram till dess svarar inloggningen att adressen inte är bekräftad.
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
      <h1>Skapa konto</h1>
      <p className="lede">
        Ett konto räcker. Du är köpare i de förfrågningar du publicerar och säljare i de
        anbud du lämnar.
      </p>

      <Notice error={error} />

      <form className="stack" onSubmit={submit}>
        <label>
          <span>Namn</span>
          <input
            name="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            data-testid="displayName"
          />
        </label>
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
          <span>Lösenord — minst 12 tecken</span>
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
            Skapa konto
          </button>
          <Link to="/login">Jag har redan ett konto</Link>
        </div>
      </form>
    </>
  );
}
