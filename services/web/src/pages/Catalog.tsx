import { useState } from 'react';
import { Link } from 'react-router-dom';
import { call, type CatalogItem } from '../api.ts';
import { useAuth, useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';
import { _ } from '../i18n.ts';

export function Catalog() {
  const token = useToken();
  const { account } = useAuth();
  const [pref, setPref] = useState('');

  const query = pref ? `?compensationPref=${pref}` : '';
  const { data, error } = useLoader(
    () => call<{ items: CatalogItem[] }>(`/requests${query}`, { token }),
    [query],
  );

  return (
    <>
      <h1>{_('catalog.title')}</h1>
      <p className="lede">{_('catalog.lede')}</p>

      <Notice error={error} />

      <form className="actions" style={{ marginBottom: '1.5rem' }}>
        <label style={{ maxWidth: '16rem' }}>
          <span>{_('catalog.compensationPref')}</span>
          <select
            value={pref}
            onChange={(e) => setPref(e.target.value)}
            data-testid="filter-compensationPref"
          >
            <option value="">{_('catalog.prefAll')}</option>
            <option value="fixed">{_('catalog.prefFixed')}</option>
            <option value="hourly">{_('catalog.prefHourly')}</option>
            <option value="any">{_('catalog.prefAny')}</option>
          </select>
        </label>
      </form>

      {data && data.items.length === 0 && (
        <Empty>{_('catalog.empty')}</Empty>
      )}

      <div data-testid="catalog">
        {data?.items.map((item) => (
          <article className="record" key={item.id} data-testid="catalog-item" data-id={item.id}>
            <div className="record__head">
              <h2 className="record__title">
                <Link to={`/requests/${item.id}`}>{item.title}</Link>
              </h2>
              <Status value={item.status} />
            </div>
            <div className="record__body">
              <p style={{ marginTop: 0 }}>{item.description}</p>
              <div className="meta">
                <span>
                  <span className="eyebrow">{_('catalog.buyer')}</span> {item.buyerDisplayName}
                </span>
                <span>
                  <span className="eyebrow">{_('catalog.budget')}</span>{' '}
                  <span className="amount">
                    {item.budget ? formatAmount(item.budget.amountMinor, item.budget.currency) : '—'}
                  </span>
                </span>
                <span>
                  <span className="eyebrow">{_('catalog.deadline')}</span> {formatDate(item.deadlineAt)}
                </span>
                <span data-testid="bid-count">
                  <span className="eyebrow">{_('catalog.bids')}</span> {item.bidCount}
                </span>
              </div>
              <div className="actions" style={{ marginTop: '1rem' }}>
                {item.canBid ? (
                  <Link to={`/requests/${item.id}`}>
                    <button className="secondary" data-testid="go-bid">
                      {_('catalog.goBid')}
                    </button>
                  </Link>
                ) : (
                  <span className="mono" data-testid="cannot-bid">
                    {/*
                      Ordningen följer API:ets: ägarskapet först, sedan eget anbud, sedan
                      kravspecen. Det är samma skäl anropet ändå hade avvisats med.
                    */}
                    {item.buyerOrganizationId === account?.organization.id
                      ? _('catalog.cannotBidOwn')
                      : item.hasMyBid
                        ? _('catalog.cannotBidAlready')
                        : _('catalog.cannotBidNoSpec')}
                  </span>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
