/**
 * Belopp hanteras som heltal i minorenhet (öre) — aldrig float, aldrig decimal i JS.
 *
 * Bun.SQL returnerar `bigint`-kolumner som `string`. All konvertering sker här, så att
 * en route aldrig råkar skicka vidare en sträng där ett tal förväntas (D.4 i planen).
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

/**
 * Valutan är valfri i API:et och fylls i här istället för med `default` i schemat:
 * Ajv applicerar inte defaults inuti `anyOf`-grenar, och en default som bara ibland
 * gäller är värre än ingen alls.
 */
export const DEFAULT_CURRENCY = 'SEK';

export const currencyOr = (currency: string | undefined): string =>
  currency ?? DEFAULT_CURRENCY;

/** Läser en bigint-kolumn. Kastar hellre än tappar precision tyst. */
export function fromMinorColumn(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Beloppet ${value} är inte ett säkert heltal i minorenhet.`);
  }
  return parsed;
}

/**
 * Läser en `numeric`-kolumn (t.ex. `estimated_hours`). Bun.SQL ger även dessa som string,
 * med efterföljande nollor: '7.50' → 7.5.
 */
export function fromNumericColumn(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Värdet ${value} är inte ett tal.`);
  }
  return parsed;
}

/** Kontrollerar ett belopp på väg in i databasen. */
export function toMinorColumn(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Beloppet ${value} måste vara ett positivt heltal i minorenhet.`);
  }
  return value;
}

export function money(amountMinor: number | null, currency: string): Money | null {
  return amountMinor === null ? null : { amountMinor, currency: currency.trim() };
}
