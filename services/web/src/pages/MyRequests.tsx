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
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
