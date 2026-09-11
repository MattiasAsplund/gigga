import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { call, type RequestSummary } from '../api.ts';
import { useToken } from '../auth.tsx';
import { Notice } from '../components/ui.tsx';
import { _ } from '../i18n.ts';

export function NewRequest() {
  const token = useToken();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const budget = String(form.get('budget') ?? '').trim();
    const deadline = String(form.get('deadlineAt') ?? '').trim();

    setBusy(true);
    setError(null);
    try {
      const created = await call<RequestSummary>('/requests', {
        token,
        body: {
          title: form.get('title'),
          description: form.get('description'),
          compensationPref: form.get('compensationPref'),
          // Kronor i formuläret, öre i API:et — omräkningen sker här och ingen annanstans.
          ...(budget ? { budget: { amountMinor: Math.round(Number(budget) * 100), currency: 'SEK' } } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).toISOString() } : {}),
        },
      });
      navigate(`/requests/${created.id}`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{_('newRequest.title')}</h1>
      <p className="lede">{_('newRequest.lede')}</p>

      <Notice error={error} />

      <form className="stack" onSubmit={submit}>
        <label>
          <span>{_('newRequest.titleField')}</span>
          <input name="title" required maxLength={120} data-testid="title" />
        </label>
        <label>
          <span>{_('newRequest.description')}</span>
          <textarea name="description" required data-testid="description" />
        </label>
        <div className="field-row">
          <label>
            <span>{_('newRequest.compensationPref')}</span>
            <select name="compensationPref" defaultValue="any" data-testid="compensationPref">
              <option value="any">{_('newRequest.prefAny')}</option>
              <option value="fixed">{_('newRequest.prefFixed')}</option>
              <option value="hourly">{_('newRequest.prefHourly')}</option>
            </select>
          </label>
          <label>
            <span>{_('newRequest.budget')}</span>
            <input name="budget" type="number" min="1" step="0.01" data-testid="budget" />
          </label>
          <label>
            <span>{_('newRequest.deadline')}</span>
            <input name="deadlineAt" type="date" data-testid="deadlineAt" />
          </label>
        </div>
        <div className="actions">
          <button type="submit" disabled={busy} data-testid="submit">
            {_('newRequest.submit')}
          </button>
        </div>
      </form>
    </>
  );
}
