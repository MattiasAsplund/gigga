import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { call } from '../api.ts';
import { Notice } from '../components/ui.tsx';

/**
 * Målet för bekräftelselänken. Backendens länk pekar in i API:et, men vägen genom
 * webben finns för att användaren ska landa någonstans där hen kan gå vidare.
 */
export function Verify() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'väntar' | 'klar' | 'fel'>('väntar');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!token) {
      setState('fel');
      setError(new Error('Länken saknar token.'));
      return;
    }
    call<{ verified: boolean; email: string }>(`/validate-user?token=${encodeURIComponent(token)}`)
      .then((result) => {
        setEmail(result.email);
        setState('klar');
      })
      .catch((cause) => {
        setError(cause);
        setState('fel');
      });
  }, [token]);

  return (
    <>
      <h1>Bekräfta e-postadress</h1>
      {state === 'väntar' && <p className="lede">Bekräftar …</p>}

      {state === 'klar' && (
        <>
          <div className="notice" data-testid="verified">
            <strong>{email} är bekräftad.</strong>
            <p className="notice__detail">Nu går det att logga in.</p>
          </div>
          <p>
            <Link to="/login">Logga in</Link>
          </p>
        </>
      )}

      {state === 'fel' && (
        <>
          <Notice error={error} />
          <p className="lede">
            Gick länken ut? Begär ett nytt bekräftelsemail från inloggningssidan.
          </p>
        </>
      )}
    </>
  );
}
