import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { call } from '../api.ts';
import { Notice } from '../components/ui.tsx';

/**
 * Målet för bekräftelselänken i mailet. Sidan gör anropet mot API:et åt användaren och
 * stannar kvar med ett besked: bekräftat och vägen vidare till inloggningen, eller
 * felet och hur man begär ett nytt mail. Länken pekade tidigare rakt in i API:et, och
 * lämnade då ett JSON-svar i webbläsaren oavsett hur det gick.
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
