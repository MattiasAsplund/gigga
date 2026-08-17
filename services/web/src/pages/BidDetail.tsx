import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  call,
  download,
  type Attachment,
  type Contract,
  type MyBid,
} from '../api.ts';
import { useAuth, useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';

export function BidDetail() {
  const { bidId = '' } = useParams();
  const token = useToken();
  const { account } = useAuth();

  const [contract, setContract] = useState<Contract | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const files = useLoader(
    () => call<{ items: Attachment[] }>(`/bids/${bidId}/attachments`, { token }),
    [bidId],
  );

  // Anbudets egna uppgifter finns bara i säljarens lista; för andra roller räcker
  // dokumenten och avtalet, som båda hämtas per anbud.
  const mine = useLoader(() => call<{ items: MyBid[] }>('/me/bids', { token }), []);
  const bid = mine.data?.items.find((item) => item.id === bidId) ?? null;
  const isSeller = Boolean(bid);

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      setContract(await call<Contract>(`/bids/${bidId}/contract/signatures`, { token, method: 'POST' }));
      mine.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem('file') as HTMLInputElement;
    if (!input.files?.[0]) return;

    const body = new FormData();
    body.append('file', input.files[0]);
    setError(null);
    try {
      await call(`/bids/${bidId}/attachments`, { token, form: body });
      form.reset();
      files.reload();
    } catch (cause) {
      setError(cause);
    }
  }

  async function rename(attachmentId: string, current: string) {
    const filename = window.prompt('Nytt filnamn', current);
    if (!filename || filename === current) return;
    setError(null);
    try {
      await call(`/bids/${bidId}/attachments/${attachmentId}`, {
        token,
        method: 'PATCH',
        body: { filename },
      });
      files.reload();
    } catch (cause) {
      setError(cause);
    }
  }

  async function remove(attachmentId: string) {
    setError(null);
    try {
      await call(`/bids/${bidId}/attachments/${attachmentId}`, { token, method: 'DELETE' });
      files.reload();
    } catch (cause) {
      setError(cause);
    }
  }

  const signatureState = contract ?? bidContract(bid);

  return (
    <>
      <h1>Anbud</h1>
      <div className="meta" style={{ marginBottom: '1.5rem' }}>
        <span className="mono" data-testid="bid-id">
          {bidId}
        </span>
        {bid && <Status value={bid.status} />}
      </div>

      <Notice error={error ?? files.error} />

      {bid && (
        <section className="section">
          <h2>{bid.requestTitle}</h2>
          <p>{bid.plan}</p>
          <div className="meta">
            <span>
              <span className="eyebrow">Ersättning</span>{' '}
              {bid.compensation.type === 'fixed'
                ? `Fast pris ${formatAmount(bid.compensation.amountMinor)}`
                : `${formatAmount(bid.compensation.rateMinor)}/tim × ${bid.compensation.estimatedHours} tim`}
            </span>
            <span>
              <span className="eyebrow">Beräknat totalt</span>{' '}
              <span className="amount" data-testid="bid-total">
                {formatAmount(bid.estimatedTotalMinor)}
              </span>
            </span>
          </div>
        </section>
      )}

      {bid && isSeller && (
        <ChangeBid bid={bid} token={token} onDone={mine.reload} onError={setError} />
      )}

      <section className="section">
        <h2>Dokument</h2>

        {isSeller && (
          <form className="actions" onSubmit={upload} data-testid="upload-form">
            <label style={{ flex: 1, maxWidth: '24rem' }}>
              <span>Markdown eller PDF, högst 10 MB</span>
              <input type="file" name="file" accept=".md,.markdown,.pdf" data-testid="file" />
            </label>
            <button type="submit" data-testid="upload">
              Ladda upp
            </button>
          </form>
        )}

        <ul className="plain-list" style={{ marginTop: '1rem' }} data-testid="attachments">
          {files.data?.items.length === 0 && <Empty>Inga dokument är bifogade.</Empty>}
          {files.data?.items.map((file) => (
            <li
              className={`line-item${file.available ? '' : ' line-item--unavailable'}`}
              key={file.id}
              data-testid="attachment"
              data-filename={file.filename}
            >
              <span>
                {file.filename}{' '}
                <span className="mono">
                  {(file.sizeBytes / 1024).toFixed(1)} kB
                  {file.available ? '' : ' — innehållet saknas'}
                </span>
              </span>
              {isSeller && (
                <span className="actions">
                  <button
                    className="quiet"
                    onClick={() => void rename(file.id, file.filename)}
                    data-testid="rename"
                  >
                    Byt namn
                  </button>
                  <button
                    className="quiet"
                    onClick={() => void remove(file.id)}
                    data-testid="delete-attachment"
                  >
                    Radera
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="actions" style={{ marginTop: '1rem' }}>
          <button
            className="secondary"
            data-testid="download-archive"
            onClick={() =>
              void download(`/bids/${bidId}/attachments/archive`, token, `anbud-${bidId}.zip`).catch(
                setError,
              )
            }
          >
            Ladda ner alla som ZIP
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Avtal</h2>
        {signatureState ? (
          <ContractBlock contract={signatureState} />
        ) : (
          <p className="lede" data-testid="no-contract">
            Inget avtal är påbörjat. Köparens signatur skapar det och innebär samtidigt att
            anbudet antas; säljarens signatur aktiverar det.
          </p>
        )}

        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={() => void sign()} disabled={busy} data-testid="sign">
            Signera avtalet
          </button>
          <span className="mono">
            {account?.email} signerar som {isSeller ? 'säljare' : 'köpare'}
          </span>
        </div>
      </section>
    </>
  );
}

/**
 * Säljarens egna handlingar på anbudet: skriva om det, eller dra tillbaka det.
 *
 * Villkoren fryses i avtalet när köparen signerar, så när ett avtal finns visas ingen
 * form alls — bara beskedet om varför, och att vägen ut är att låta bli att signera.
 * Förfrågans läge och deadline känner sidan inte till; de spärrarna får API:et svara på,
 * och felet hamnar i notisen ovanför.
 */
function ChangeBid({
  bid,
  token,
  onDone,
  onError,
}: {
  bid: MyBid;
  token: string;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const [kind, setKind] = useState<'fixed' | 'hourly'>(bid.compensation.type);
  const [busy, setBusy] = useState(false);

  if (bid.contract) {
    return (
      <section className="section">
        <h2>Ändra anbudet</h2>
        <p className="lede" data-testid="bid-locked">
          Avtalet är påbörjat, och anbudets villkor ligger frysta i det. Vill du inte ha
          uppdraget räcker det att låta bli att signera.
        </p>
      </section>
    );
  }

  if (bid.status !== 'submitted') {
    return (
      <section className="section">
        <h2>Ändra anbudet</h2>
        <p className="lede" data-testid="bid-locked">
          Anbudet är {bid.status} och går inte längre att ändra.
          {bid.status === 'withdrawn' && ' Du kan lämna ett nytt anbud på förfrågan.'}
        </p>
      </section>
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    onError(null);
    try {
      await call(`/bids/${bid.id}`, {
        token,
        method: 'PATCH',
        body: {
          plan: form.get('plan'),
          // Ersättningen skickas alltid hel — API:et byter aldrig fält för fält.
          compensation:
            kind === 'fixed'
              ? {
                  type: 'fixed',
                  amountMinor: Math.round(Number(form.get('amount')) * 100),
                  currency: 'SEK',
                }
              : {
                  type: 'hourly',
                  rateMinor: Math.round(Number(form.get('rate')) * 100),
                  estimatedHours: Number(form.get('hours')),
                  currency: 'SEK',
                },
        },
      });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!window.confirm('Dra tillbaka anbudet? Du kan lämna ett nytt på samma förfrågan.')) {
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await call(`/bids/${bid.id}/withdrawal`, { token, method: 'POST' });
      onDone();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  const fixed = bid.compensation.type === 'fixed' ? bid.compensation : null;
  const hourly = bid.compensation.type === 'hourly' ? bid.compensation : null;

  return (
    <section className="section">
      <h2>Ändra anbudet</h2>
      <form className="stack" onSubmit={save} data-testid="change-bid-form">
        <label>
          <span>Genomförandeplan</span>
          <textarea name="plan" required defaultValue={bid.plan} data-testid="change-plan" />
        </label>

        <label style={{ maxWidth: '16rem' }}>
          <span>Ersättningsform</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'fixed' | 'hourly')}
            data-testid="change-compensation-type"
          >
            <option value="hourly">Timpris</option>
            <option value="fixed">Fast pris</option>
          </select>
        </label>

        {kind === 'fixed' ? (
          <label style={{ maxWidth: '16rem' }}>
            <span>Fast pris i kronor</span>
            <input
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              required
              defaultValue={fixed ? fixed.amountMinor / 100 : ''}
              data-testid="change-amount"
            />
          </label>
        ) : (
          <div className="field-row">
            <label>
              <span>Timpris i kronor</span>
              <input
                name="rate"
                type="number"
                min="0.01"
                step="0.01"
                required
                defaultValue={hourly ? hourly.rateMinor / 100 : ''}
                data-testid="change-rate"
              />
            </label>
            <label>
              <span>Uppskattade timmar</span>
              <input
                name="hours"
                type="number"
                min="0.25"
                step="0.25"
                required
                defaultValue={hourly ? hourly.estimatedHours : ''}
                data-testid="change-hours"
              />
            </label>
          </div>
        )}

        <div className="actions">
          <button type="submit" disabled={busy} data-testid="save-bid">
            Spara ändringen
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => void withdraw()}
            disabled={busy}
            data-testid="withdraw-bid"
          >
            Dra tillbaka anbudet
          </button>
        </div>
      </form>
    </section>
  );
}

/** Säljarens anbudslista bär signaturläget, men inte de frysta villkoren. */
function bidContract(bid: MyBid | null): Contract | null {
  if (!bid?.contract) return null;
  return {
    contractId: bid.contract.id,
    status: bid.contract.status,
    buyerSignedAt: bid.contract.buyerSigned ? '' : null,
    sellerSignedAt: bid.contract.sellerSigned ? '' : null,
    terms: {
      bidId: bid.id,
      requestId: bid.requestId,
      buyerId: '',
      sellerId: '',
      requestTitle: bid.requestTitle,
      plan: bid.plan,
      compensation: bid.compensation,
      estimatedTotalMinor: bid.estimatedTotalMinor,
      frozenAt: '',
    },
  };
}

/**
 * Avtalet är det enda stället där appen visar ett dokument snarare än data — därav
 * serifen. Två platser som fylls var för sig, och blir bindande först tillsammans.
 */
function ContractBlock({ contract }: { contract: Contract }) {
  return (
    <div className="contract" data-testid="contract" data-status={contract.status}>
      <div className="contract__terms">
        <dl>
          <dt>Uppdrag</dt>
          <dd>{contract.terms.requestTitle}</dd>
          <dt>Åtagande</dt>
          <dd>{contract.terms.plan}</dd>
          <dt>Ersättning</dt>
          <dd>
            <span className="amount">{formatAmount(contract.terms.estimatedTotalMinor)}</span>
            {contract.terms.compensation.type === 'hourly' &&
              ` (${formatAmount(contract.terms.compensation.rateMinor)}/tim × ${contract.terms.compensation.estimatedHours} tim)`}
          </dd>
          <dt>Status</dt>
          <dd>
            <Status value={contract.status} />
          </dd>
        </dl>
      </div>

      <div className="signatures">
        <Signature party="Köparen" at={contract.buyerSignedAt} testid="signature-buyer" />
        <Signature party="Säljaren" at={contract.sellerSignedAt} testid="signature-seller" />
      </div>
    </div>
  );
}

function Signature({
  party,
  at,
  testid,
}: {
  party: string;
  at: string | null;
  testid: string;
}) {
  const signed = at !== null;
  return (
    <div
      className={`signature${signed ? ' signature--signed' : ''}`}
      data-testid={testid}
      data-signed={signed}
    >
      <span className="signature__party">{party}</span>
      <span className="signature__mark">{signed ? 'Signerat' : 'Väntar'}</span>
      <span className="signature__when">{at ? formatDate(at) : 'Ingen signatur än'}</span>
    </div>
  );
}
