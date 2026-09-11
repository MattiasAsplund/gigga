import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, download } from '../api.ts';
import { currentToken } from '../auth.tsx';
import { _ } from '../i18n.ts';

/**
 * Sidan länken i brevet leder till.
 *
 * Den gör en enda sak: hämtar det signerade avtalet. Att den ligger bakom `RequireAuth`
 * är hela poängen med att brevet bär en länk och inte en bilaga — den som klickar
 * skickas till Keycloak först, kommer tillbaka hit, och nedladdningen startar då av sig
 * själv. Ingen knapp att leta efter, och ingen fil som kan vidarebefordras till någon
 * som inte är part.
 *
 * `started` spärrar dubbelhämtning: React kör effekter två gånger i StrictMode, och två
 * nedladdningar av samma avtal är två filer i mappen Hämtade filer.
 */
export function ContractDocument() {
  const { contractId } = useParams<{ contractId: string }>();
  const [filename, setFilename] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef(false);

  async function fetchDocument() {
    setFailed(null);
    try {
      setFilename(await download(`/contracts/${contractId}/document`, currentToken()));
    } catch (cause) {
      setFailed(
        cause instanceof ApiError
          ? cause.problem.detail || cause.problem.title
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchDocument();
    // Avtalet hämtas en gång per besök — därför inga beroenden utöver id:t.
  }, [contractId]);

  return (
    <section className="panel stack" data-testid="contract-document">
      <h1>{_('contractDocument.title')}</h1>

      {failed ? (
        <p className="error" data-testid="contract-document-error">
          {failed}
        </p>
      ) : filename ? (
        <p data-testid="contract-document-done">
          {_('contractDocument.done', { filename })}
        </p>
      ) : (
        <p data-testid="contract-document-pending">{_('contractDocument.pending')}</p>
      )}

      <p className="lede">{_('contractDocument.language')}</p>

      <div className="actions">
        <button onClick={() => void fetchDocument()} data-testid="contract-document-again">
          {failed ? _('contractDocument.retry') : _('contractDocument.again')}
        </button>
        <Link to="/me/bids">{_('contractDocument.back')}</Link>
      </div>
    </section>
  );
}
