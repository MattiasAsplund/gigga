import { Link } from 'react-router-dom';
import { call, type MyBid } from '../api.ts';
import { useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';

export function MyBids() {
  const token = useToken();
  const { data, error } = useLoader(() => call<{ items: MyBid[] }>('/me/bids', { token }));

  return (
    <>
      <h1>Mina anbud</h1>
      <p className="lede">Anbud du har lämnat, med avtalets läge när ett är påbörjat.</p>

      <Notice error={error} />

      {data && data.items.length === 0 && (
        <Empty>
          Du har inte lämnat något anbud än. <Link to="/requests">Titta i katalogen.</Link>
        </Empty>
      )}

      <div data-testid="my-bids">
        {data?.items.map((bid) => (
          <article className="record" key={bid.id} data-testid="my-bid" data-id={bid.id}>
            <div className="record__head">
              <h2 className="record__title">
                <Link to={`/bids/${bid.id}`}>{bid.requestTitle}</Link>
              </h2>
              <Status value={bid.status} />
            </div>
            <div className="record__body">
              <p style={{ marginTop: 0 }}>{bid.plan}</p>
              <div className="meta">
                <span>
                  <span className="eyebrow">Beräknat totalt</span>{' '}
                  <span className="amount">{formatAmount(bid.estimatedTotalMinor)}</span>
                </span>
                <span>
                  <span className="eyebrow">Lämnat</span> {formatDate(bid.createdAt)}
                </span>
                <span data-testid="contract-state">
                  <span className="eyebrow">Avtal</span>{' '}
                  {bid.contract ? (
                    <Status value={bid.contract.status} />
                  ) : (
                    <span className="mono">inget påbörjat</span>
                  )}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
