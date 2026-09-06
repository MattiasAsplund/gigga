import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  call,
  loadSpec,
  type Permission,
  type RequestDetail as Detail,
  type RequestSpec as Spec,
} from '../api.ts';
import { useAuth, useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';
import { SpecReading } from './RequestSpec.tsx';

export function RequestDetail() {
  const { requestId = '' } = useParams();
  const token = useToken();
  const { account } = useAuth();

  const { data, error, reload } = useLoader(
    () => call<Detail>(`/requests/${requestId}`, { token }),
    [requestId],
  );

  // Organisationen är part: en kollega på köparsidan ser och gör samma sak som den som
  // skapade förfrågan.
  const isBuyer = data?.buyerOrganizationId === account?.organization.id;
  // Ett tillbakadraget anbud spärrar inte: API:et släpper igenom ett nytt, och katalogens
  // hasMyBid räknar likadant. Utan filtret vore knappen borta fast anbudet vore tillåtet.
  const myBid = data?.bids.find(
    (bid) =>
      bid.sellerOrganizationId === account?.organization.id && bid.status !== 'withdrawn',
  );
  const spec = useLoader(() => loadSpec(requestId, token), [requestId]);
  const published = spec.data?.version.status === 'published' ? spec.data : null;

  // Anbud förutsätter en publicerad kravspec — utan den finns ingen omfattning att
  // prissätta, och API:et hade ändå svarat 409.
  const canBid =
    Boolean(data) && !isBuyer && !myBid && data?.status === 'open' && Boolean(published);

  return (
    <>
      <Notice error={error} />
      {!data ? null : (
        <>
          <h1 data-testid="request-title">{data.title}</h1>
          <div className="meta" style={{ marginBottom: '1.5rem' }}>
            <Status value={data.status} />
            <span>
              <span className="eyebrow">Budget</span>{' '}
              <span className="amount">
                {data.budget ? formatAmount(data.budget.amountMinor, data.budget.currency) : '—'}
              </span>
            </span>
            <span>
              <span className="eyebrow">Sista dag</span> {formatDate(data.deadlineAt)}
            </span>
            <span className="mono">{data.id}</span>
          </div>

          <p>{data.description}</p>

          <SpecPanel
            requestId={requestId}
            spec={spec.data}
            isBuyer={isBuyer}
            canBid={canBid}
          />

          {canBid && <BidForm requestId={requestId} token={token} onDone={reload} />}

          <section className="section">
            <h2>Anbud ({data.bids.length})</h2>
            {data.bids.length === 0 ? (
              // Säljaren ser bara sitt eget anbud i svaret — "inga har lämnats" vore ett
              // påstående om andras anbud som sidan inte har täckning för.
              <Empty>{isBuyer ? 'Inga anbud har lämnats än.' : 'Inga anbud att visa.'}</Empty>
            ) : (
              <div data-testid="bids">
                {data.bids.map((bid) => (
                  <article className="record" key={bid.id} data-testid="bid" data-id={bid.id}>
                    <div className="record__head">
                      <h2 className="record__title">
                        <Link to={`/bids/${bid.id}`}>{bid.sellerDisplayName}</Link>
                      </h2>
                      <Status value={bid.status} />
                    </div>
                    <div className="record__body">
                      <p style={{ marginTop: 0 }}>{bid.plan}</p>
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
                      <div className="actions" style={{ marginTop: '1rem' }}>
                        <Link to={`/bids/${bid.id}`}>
                          <button className="secondary" data-testid="open-bid">
                            Öppna anbudet
                          </button>
                        </Link>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {isBuyer && <Permissions requestId={requestId} token={token} />}
        </>
      )}
    </>
  );
}

/**
 * Kravspecen på förfrågningssidan.
 *
 * För köparen är den vägen in i intervjun och den påminnelse som säger varför inga anbud
 * kommer. För alla andra är den det som ska prissättas — och den ligger därför läsbar
 * innan anbudsformuläret, inte efter.
 */
function SpecPanel({
  requestId,
  spec,
  isBuyer,
  canBid,
}: {
  requestId: string;
  spec: Spec | null | undefined;
  isBuyer: boolean;
  canBid: boolean;
}) {
  if (spec === undefined) return null;

  const published = spec?.version.status === 'published' ? spec : null;

  if (isBuyer) {
    return (
      <section className="section" data-testid="spec-panel">
        <h2>Kravspec</h2>
        {!spec ? (
          <>
            <div className="notice" role="status" data-testid="spec-missing">
              <strong>Kravspecen är inte fastställd.</strong>
              <p className="notice__detail">
                Ingen kan lämna anbud förrän du sagt vilken sorts uppdrag det är, svarat på
                frågorna och godkänt acceptanskriterierna.
              </p>
            </div>
            <div className="actions">
              <Link to={`/requests/${requestId}/spec`}>
                <button data-testid="go-spec">Fastställ kravspecen</button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="meta">
              <span data-testid="spec-version">
                <span className="eyebrow">Version</span> v{spec.version.version}
              </span>
              <Status value={spec.version.status} />
              <span className="mono" data-testid="spec-progress">
                {spec.completeness.answeredRequired}/{spec.completeness.requiredQuestions} frågor ·{' '}
                {spec.completeness.approvedCriteria}/{spec.completeness.criteria} kriterier godkända
              </span>
            </div>
            <div className="actions" style={{ marginTop: '1rem' }}>
              <Link to={`/requests/${requestId}/spec`}>
                <button className="secondary" data-testid="go-spec">
                  {spec.version.status === 'draft' ? 'Fortsätt intervjun' : 'Öppna kravspecen'}
                </button>
              </Link>
            </div>
            {published && <SpecReading spec={published} />}
          </>
        )}
      </section>
    );
  }

  if (!published) {
    return (
      <section className="section" data-testid="spec-panel">
        <h2>Kravspec</h2>
        <div className="notice" role="status" data-testid="spec-missing">
          <strong>Köparen har inte fastställt kravspecen än.</strong>
          <p className="notice__detail">
            Uppdraget går inte att lämna anbud på förrän omfattningen och
            acceptanskriterierna är publicerade.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="section" data-testid="spec-panel">
      <h2>Kravspec v{published.version.version}</h2>
      <p className="lede">
        Det här är vad anbudet avser. {canBid ? 'Läs igenom raderna innan du prissätter.' : ''}
      </p>
      <SpecReading spec={published} />
    </section>
  );
}

function BidForm({
  requestId,
  token,
  onDone,
}: {
  requestId: string;
  token: string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'fixed' | 'hourly'>('hourly');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await call(`/requests/${requestId}/bids`, {
        token,
        body: {
          plan: form.get('plan'),
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
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2>Lämna anbud</h2>
      <Notice error={error} />
      <form className="stack" onSubmit={submit} data-testid="bid-form">
        <label>
          <span>Genomförandeplan</span>
          <textarea name="plan" required data-testid="plan" />
        </label>

        <label style={{ maxWidth: '16rem' }}>
          <span>Ersättningsform</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'fixed' | 'hourly')}
            data-testid="compensation-type"
          >
            <option value="hourly">Timpris</option>
            <option value="fixed">Fast pris</option>
          </select>
        </label>

        {kind === 'fixed' ? (
          <label style={{ maxWidth: '16rem' }}>
            <span>Fast pris i kronor</span>
            <input name="amount" type="number" min="0.01" step="0.01" required data-testid="amount" />
          </label>
        ) : (
          <div className="field-row">
            <label>
              <span>Timpris i kronor</span>
              <input name="rate" type="number" min="0.01" step="0.01" required data-testid="rate" />
            </label>
            <label>
              <span>Uppskattade timmar</span>
              <input name="hours" type="number" min="0.25" step="0.25" required data-testid="hours" />
            </label>
          </div>
        )}

        <div className="actions">
          <button type="submit" disabled={busy} data-testid="submit-bid">
            Lämna anbud
          </button>
        </div>
      </form>
    </section>
  );
}

/** Läsrätt till förfrågan. Endast köparen ser och når det här. */
function Permissions({ requestId, token }: { requestId: string; token: string }) {
  const [error, setError] = useState<unknown>(null);
  const { data, reload } = useLoader(
    () => call<{ items: Permission[] }>(`/requests/${requestId}/permissions`, { token }),
    [requestId],
  );

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get('email'));
    setError(null);
    try {
      await call(`/requests/${requestId}/permissions`, { token, body: { email } });
      form.reset();
      reload();
    } catch (cause) {
      setError(cause);
    }
  }

  async function revoke(userId: string) {
    setError(null);
    try {
      await call(`/requests/${requestId}/permissions/${userId}`, { token, method: 'DELETE' });
      reload();
    } catch (cause) {
      setError(cause);
    }
  }

  return (
    <section className="section">
      <h2>Vem mer får läsa</h2>
      <p className="lede">
        Den du bjuder in når förfrågan, anbuden och deras dokument — men kan varken lämna
        anbud, signera eller bjuda in fler.
      </p>

      <Notice error={error instanceof ApiError ? error : undefined} />

      <form className="actions" onSubmit={grant} data-testid="grant-form">
        <label style={{ flex: 1, maxWidth: '22rem' }}>
          <span>E-postadress</span>
          <input type="email" name="email" required data-testid="grant-email" />
        </label>
        <button type="submit" data-testid="grant-submit">
          Ge läsrätt
        </button>
      </form>

      <ul className="plain-list" style={{ marginTop: '1rem' }} data-testid="permissions">
        {data?.items.length === 0 && <Empty>Ingen annan har läsrätt.</Empty>}
        {data?.items.map((permission) => (
          <li className="line-item" key={permission.userId} data-testid="permission">
            <span>
              {permission.displayName} <span className="mono">{permission.email}</span>
            </span>
            <button
              className="quiet"
              onClick={() => void revoke(permission.userId)}
              data-testid="revoke"
            >
              Ta tillbaka
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
