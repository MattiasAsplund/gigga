import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';

/** Belopp lagras i öre. Här — och bara här — blir de läsbara. */
export function formatAmount(minor: number, currency = 'SEK'): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status--${value}`} data-status={value}>
      {value.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Felsvaret som det ser ut för användaren. Problem Details bär både en rubrik och
 * fältvisa fel — båda hjälper, så båda visas.
 */
export function Notice({ error, message }: { error?: unknown; message?: string }) {
  if (!error && !message) return null;

  if (error instanceof ApiError) {
    return (
      <div className="notice notice--error" role="alert" data-testid="notice">
        <strong>{error.problem.title}</strong>
        <p className="notice__detail">
          {error.problem.detail}
          {error.fieldErrors && ` (${error.fieldErrors})`}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="notice notice--error" role="alert" data-testid="notice">
        <strong>{String((error as Error).message ?? error)}</strong>
      </div>
    );
  }

  return (
    <div className="notice" role="status" data-testid="notice">
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="empty" data-testid="empty">
      {children}
    </p>
  );
}

/** Hämtar data när sidan öppnas och ger ett sätt att hämta om efter en ändring. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    load()
      .then((result) => current && (setData(result), setError(null)))
      .catch((cause) => current && setError(cause));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  return { data, error, reload: () => setVersion((n) => n + 1) };
}
