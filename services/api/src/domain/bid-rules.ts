import { fromMinorColumn, fromNumericColumn, toMinorColumn } from './money.ts';

export type CompensationType = 'fixed' | 'hourly';

/**
 * Ersättningen i ett anbud. Formen är diskriminerad på `type` — ett fastprisanbud har
 * aldrig ett timpris och tvärtom, varken i API:et, i domänen eller i databasen.
 */
export type Compensation =
  | { type: 'fixed'; amountMinor: number; currency: string }
  | { type: 'hourly'; rateMinor: number; estimatedHours: number; currency: string };

export interface CompensationColumns {
  compensationType: CompensationType;
  fixedAmountMinor: number | null;
  hourlyRateMinor: number | null;
  estimatedHours: number | null;
  currency: string;
}

export interface CompensationRow {
  compensation_type: CompensationType;
  fixed_amount_minor: string | number | null;
  hourly_rate_minor: string | number | null;
  estimated_hours: string | number | null;
  currency: string;
}

const MAX_ESTIMATED_HOURS = 9999.99;

function assertHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_ESTIMATED_HOURS) {
    throw new Error(`Antalet timmar ${hours} måste vara större än 0 och högst ${MAX_ESTIMATED_HOURS}.`);
  }
  return hours;
}

/** Domänform → kolumner. Kastar om formen bryts, så en trasig rad aldrig skrivs. */
export function toCompensationColumns(compensation: Compensation): CompensationColumns {
  if (compensation.type === 'fixed') {
    return {
      compensationType: 'fixed',
      fixedAmountMinor: toMinorColumn(compensation.amountMinor),
      hourlyRateMinor: null,
      estimatedHours: null,
      currency: compensation.currency,
    };
  }

  return {
    compensationType: 'hourly',
    fixedAmountMinor: null,
    hourlyRateMinor: toMinorColumn(compensation.rateMinor),
    estimatedHours: assertHours(compensation.estimatedHours),
    currency: compensation.currency,
  };
}

/** Kolumner → domänform. Motsvarar CHECK-villkoret i 003_bids.sql. */
export function fromCompensationColumns(row: CompensationRow): Compensation {
  const currency = row.currency.trim();

  if (row.compensation_type === 'fixed') {
    const amountMinor = fromMinorColumn(row.fixed_amount_minor);
    if (amountMinor === null) {
      throw new Error('Fastprisanbud utan fixed_amount_minor — raden bryter mot formen.');
    }
    return { type: 'fixed', amountMinor, currency };
  }

  const rateMinor = fromMinorColumn(row.hourly_rate_minor);
  const estimatedHours = fromNumericColumn(row.estimated_hours);
  if (rateMinor === null || estimatedHours === null) {
    throw new Error('Timanbud utan rate eller timmar — raden bryter mot formen.');
  }
  return { type: 'hourly', rateMinor, estimatedHours, currency };
}

/**
 * Vad anbudet beräknas landa på totalt, i minorenhet.
 *
 * Multiplikationen sker i öre och avrundas direkt — annars vandrar flyttalsdriften
 * vidare in i jämförelser och summeringar.
 */
export function estimatedTotalMinor(compensation: Compensation): number {
  if (compensation.type === 'fixed') return compensation.amountMinor;
  return Math.round(compensation.rateMinor * compensation.estimatedHours);
}
