import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { call, type RequestSummary } from '../api.ts';
import { useToken } from '../auth.tsx';
import { Notice } from '../components/ui.tsx';

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
      <h1>Ny förfrågan</h1>
      <p className="lede">
        Beskriv uppdraget så att någon kan lämna anbud på det. Du blir köpare och kan
        senare signera avtal med det anbud du väljer.
      </p>

      <Notice error={error} />

      <form className="stack" onSubmit={submit}>
        <label>
          <span>Rubrik</span>
          <input name="title" required maxLength={120} data-testid="title" />
        </label>
        <label>
          <span>Beskrivning</span>
          <textarea name="description" required data-testid="description" />
        </label>
        <div className="field-row">
          <label>
            <span>Ersättningsform</span>
            <select name="compensationPref" defaultValue="any" data-testid="compensationPref">
              <option value="any">Spelar ingen roll</option>
              <option value="fixed">Fast pris</option>
              <option value="hourly">Timpris</option>
            </select>
          </label>
          <label>
            <span>Budget i kronor</span>
            <input name="budget" type="number" min="1" step="0.01" data-testid="budget" />
          </label>
          <label>
            <span>Sista anbudsdag</span>
            <input name="deadlineAt" type="date" data-testid="deadlineAt" />
          </label>
        </div>
        <div className="actions">
          <button type="submit" disabled={busy} data-testid="submit">
            Publicera förfrågan
          </button>
        </div>
      </form>
    </>
  );
}
