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
import { _ } from '../i18n.ts';

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
              <span className="eyebrow">{_('requestDetail.budget')}</span>{' '}
              <span className="amount">
                {data.budget ? formatAmount(data.budget.amountMinor, data.budget.currency) : '—'}
              </span>
            </span>
            <span>
              <span className="eyebrow">{_('requestDetail.deadline')}</span> {formatDate(data.deadlineAt)}
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
            <h2>{_('requestDetail.bidsHeading', { count: data.bids.length })}</h2>
            {data.bids.length === 0 ? (
              // Säljaren ser bara sitt eget anbud i svaret — "inga har lämnats" vore ett
              // påstående om andras anbud som sidan inte har täckning för.
              <Empty>{isBuyer ? _('requestDetail.noBidsBuyer') : _('requestDetail.noBidsOther')}</Empty>
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
                          <span className="eyebrow">{_('requestDetail.compensation')}</span>{' '}
                          {bid.compensation.type === 'fixed'
                            ? _('requestDetail.compensationFixed', { amount: formatAmount(bid.compensation.amountMinor) })
                            : _('requestDetail.compensationHourly', { rate: formatAmount(bid.compensation.rateMinor), hours: bid.compensation.estimatedHours })}
                        </span>
                        <span>
                          <span className="eyebrow">{_('requestDetail.estimatedTotal')}</span>{' '}
                          <span className="amount" data-testid="bid-total">
                            {formatAmount(bid.estimatedTotalMinor)}
                          </span>
                        </span>
                      </div>
                      <div className="actions" style={{ marginTop: '1rem' }}>
                        <Link to={`/bids/${bid.id}`}>
                          <button className="secondary" data-testid="open-bid">
                            {_('requestDetail.openBid')}
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
        <h2>{_('requestDetail.specHeading')}</h2>
        {!spec ? (
          <>
            <div className="notice" role="status" data-testid="spec-missing">
              <strong>{_('requestDetail.specMissingTitle')}</strong>
              <p className="notice__detail">{_('requestDetail.specMissingDetail')}</p>
            </div>
            <div className="actions">
              <Link to={`/requests/${requestId}/spec`}>
                <button data-testid="go-spec">{_('requestDetail.goSpec')}</button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="meta">
              <span data-testid="spec-version">
                <span className="eyebrow">{_('requestDetail.version')}</span>{' '}
                {_('requestDetail.versionValue', { version: spec.version.version })}
              </span>
              <Status value={spec.version.status} />
              <span className="mono" data-testid="spec-progress">
                {_('requestDetail.specProgress', {
                  answered: spec.completeness.answeredRequired,
                  required: spec.completeness.requiredQuestions,
                  approved: spec.completeness.approvedCriteria,
                  criteria: spec.completeness.criteria,
                })}
              </span>
            </div>
            <div className="actions" style={{ marginTop: '1rem' }}>
              <Link to={`/requests/${requestId}/spec`}>
                <button className="secondary" data-testid="go-spec">
                  {spec.version.status === 'draft' ? _('requestDetail.continueInterview') : _('requestDetail.openSpec')}
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
        <h2>{_('requestDetail.specHeading')}</h2>
        <div className="notice" role="status" data-testid="spec-missing">
          <strong>{_('requestDetail.specUnpublishedTitle')}</strong>
          <p className="notice__detail">{_('requestDetail.specUnpublishedDetail')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="section" data-testid="spec-panel">
      <h2>{_('requestDetail.specVersionHeading', { version: published.version.version })}</h2>
      <p className="lede">
        {_('requestDetail.specReadingLede')} {canBid ? _('requestDetail.specReadBeforePricing') : ''}
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
      <h2>{_('requestDetail.bidFormHeading')}</h2>
      <Notice error={error} />
      <form className="stack" onSubmit={submit} data-testid="bid-form">
        <label>
          <span>{_('requestDetail.plan')}</span>
          <textarea name="plan" required data-testid="plan" />
        </label>

        <label style={{ maxWidth: '16rem' }}>
          <span>{_('requestDetail.compensationType')}</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'fixed' | 'hourly')}
            data-testid="compensation-type"
          >
            <option value="hourly">{_('requestDetail.typeHourly')}</option>
            <option value="fixed">{_('requestDetail.typeFixed')}</option>
          </select>
        </label>

        {kind === 'fixed' ? (
          <label style={{ maxWidth: '16rem' }}>
            <span>{_('requestDetail.fixedAmount')}</span>
            <input name="amount" type="number" min="0.01" step="0.01" required data-testid="amount" />
          </label>
        ) : (
          <div className="field-row">
            <label>
              <span>{_('requestDetail.hourlyRate')}</span>
              <input name="rate" type="number" min="0.01" step="0.01" required data-testid="rate" />
            </label>
            <label>
              <span>{_('requestDetail.estimatedHours')}</span>
              <input name="hours" type="number" min="0.25" step="0.25" required data-testid="hours" />
            </label>
          </div>
        )}

        <div className="actions">
          <button type="submit" disabled={busy} data-testid="submit-bid">
            {_('requestDetail.submitBid')}
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
      <h2>{_('requestDetail.permissionsHeading')}</h2>
      <p className="lede">{_('requestDetail.permissionsLede')}</p>

      <Notice error={error instanceof ApiError ? error : undefined} />

      <form className="actions" onSubmit={grant} data-testid="grant-form">
        <label style={{ flex: 1, maxWidth: '22rem' }}>
          <span>{_('requestDetail.email')}</span>
          <input type="email" name="email" required data-testid="grant-email" />
        </label>
        <button type="submit" data-testid="grant-submit">
          {_('requestDetail.grant')}
        </button>
      </form>

      <ul className="plain-list" style={{ marginTop: '1rem' }} data-testid="permissions">
        {data?.items.length === 0 && <Empty>{_('requestDetail.noPermissions')}</Empty>}
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
              {_('requestDetail.revoke')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
