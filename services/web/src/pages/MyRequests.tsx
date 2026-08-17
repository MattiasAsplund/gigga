import { Link } from 'react-router-dom';
import { call, type RequestDetail } from '../api.ts';
import { useToken } from '../auth.tsx';
import { Empty, Notice, Status, formatAmount, formatDate, useLoader } from '../components/ui.tsx';

export function MyRequests() {
  const token = useToken();
  const { data, error } = useLoader(() =>
    call<{ items: RequestDetail[] }>('/me/requests', { token }),
  );

  return (
    <>
      <h1>Mina förfrågningar</h1>
      <p className="lede">Förfrågningar du har publicerat, med anbuden som kommit in.</p>

      <Notice error={error} />

      {data && data.items.length === 0 && (
        <Empty>
          Du har inte publicerat något än. <Link to="/requests/new">Skapa en förfrågan.</Link>
        </Empty>
      )}

      <div data-testid="my-requests">
        {data?.items.map((request) => (
          <article className="record" key={request.id} data-testid="request" data-id={request.id}>
            <div className="record__head">
              <h2 className="record__title">
                <Link to={`/requests/${request.id}`}>{request.title}</Link>
              </h2>
              <Status value={request.status} />
            </div>
            <div className="record__body">
              <div className="meta">
                <span>
                  <span className="eyebrow">Budget</span>{' '}
                  <span className="amount">
                    {request.budget ? formatAmount(request.budget.amountMinor) : '—'}
                  </span>
                </span>
                <span>
                  <span className="eyebrow">Sista dag</span> {formatDate(request.deadlineAt)}
                </span>
                <span data-testid="request-bid-count">
                  <span className="eyebrow">Anbud</span> {request.bids.length}
                </span>
              </div>

              {/*
                Anbuden listas här och inte bara som en siffra: att se att det kommit
                tre anbud utan att kunna öppna något av dem är inte att kunna granska
                dem. Varje rad går vidare till anbudet med dokument och avtal.
              */}
              {request.bids.length === 0 ? (
                <Empty>Inga anbud har kommit in än.</Empty>
              ) : (
                <ul className="plain-list" data-testid="request-bids">
                  {request.bids.map((bid) => (
                    <li className="line-item" key={bid.id} data-testid="request-bid" data-id={bid.id}>
                      <span>
                        <strong>{bid.sellerDisplayName}</strong>{' '}
                        <span className="amount" data-testid="request-bid-total">
                          {formatAmount(bid.estimatedTotalMinor)}
                        </span>{' '}
                        <Status value={bid.status} />
                      </span>
                      <Link to={`/bids/${bid.id}`}>
                        <button className="quiet" data-testid="inspect-bid">
                          Granska anbudet
                        </button>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
