import { useState } from 'react';
import { Link } from 'react-router-dom';
import { call, type CatalogItem } from '../api.ts';
import { useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';

export function Catalog() {
  const token = useToken();
  const [pref, setPref] = useState('');

  const query = pref ? `?compensationPref=${pref}` : '';
  const { data, error } = useLoader(
    () => call<{ items: CatalogItem[] }>(`/requests${query}`, { token }),
    [query],
  );

  return (
    <>
      <h1>Katalog</h1>
      <p className="lede">
        Uppdrag som går att lämna anbud på just nu: öppna, med sista anbudsdag kvar.
      </p>

      <Notice error={error} />

      <form className="actions" style={{ marginBottom: '1.5rem' }}>
        <label style={{ maxWidth: '16rem' }}>
          <span>Ersättningsform</span>
          <select
            value={pref}
            onChange={(e) => setPref(e.target.value)}
            data-testid="filter-compensationPref"
          >
            <option value="">Alla</option>
            <option value="fixed">Fast pris</option>
            <option value="hourly">Timpris</option>
            <option value="any">Spelar ingen roll</option>
          </select>
        </label>
      </form>

      {data && data.items.length === 0 && (
        <Empty>Inga öppna uppdrag just nu. Publicera en förfrågan så syns den här.</Empty>
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
                  <span className="eyebrow">Köpare</span> {item.buyerDisplayName}
                </span>
                <span>
                  <span className="eyebrow">Budget</span>{' '}
                  <span className="amount">
                    {item.budget ? formatAmount(item.budget.amountMinor, item.budget.currency) : '—'}
                  </span>
                </span>
                <span>
                  <span className="eyebrow">Sista dag</span> {formatDate(item.deadlineAt)}
                </span>
                <span data-testid="bid-count">
                  <span className="eyebrow">Anbud</span> {item.bidCount}
                </span>
              </div>
              <div className="actions" style={{ marginTop: '1rem' }}>
                {item.canBid ? (
                  <Link to={`/requests/${item.id}`}>
                    <button className="secondary" data-testid="go-bid">
                      Lämna anbud
                    </button>
                  </Link>
                ) : (
                  <span className="mono" data-testid="cannot-bid">
                    {item.hasMyBid ? 'Du har redan lämnat anbud' : 'Din egen förfrågan'}
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
