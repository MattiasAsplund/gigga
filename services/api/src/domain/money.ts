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

/** Läser en bigint-kolumn. Kastar hellre än tappar precision tyst. */
export function fromMinorColumn(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Beloppet ${value} är inte ett säkert heltal i minorenhet.`);
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
