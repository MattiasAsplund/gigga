import type { SQL } from 'bun';
import type { ObjectStore } from './object-store.ts';

/**
 * Städning av föräldralösa objekt.
 *
 * Ett anbudsdokument skrivs i två steg: objektet först, raden sedan. Dör processen
 * däremellan blir objektet kvar utan rad — skräp som ingen kan nå och som ingen städar.
 * Det här är sopjobbet.
 */

export const ATTACHMENT_PREFIX = 'bids/';

/** Objekt yngre än så här rörs inte — se `olderThanMs` nedan. */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export interface SweepOptions {
  /**
   * Hur gammalt ett objekt måste vara för att räknas som skräp.
   *
   * Fristen skyddar uppladdningen som *just nu* ligger mellan `put` och `INSERT`.
   * Utan den skulle sopjobbet kunna radera en fil mitt under uppladdningen.
   */
  olderThanMs?: number;
  pageSize?: number;
  now?: Date;
}

export interface SweepResult {
  /** Objekt under prefixet som var äldre än fristen och alltså prövades. */
  scanned: number;
  deleted: number;
  /** Satt när städningen avstod från att göra något alls. */
  skippedReason?: 'empty-attachment-table';
}

/** Vilka av nycklarna som faktiskt hör till ett dokument. */
async function knownKeys(sql: SQL, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();

  const rows = (await sql`
    SELECT storage_key FROM bid_attachments WHERE storage_key IN ${sql(candidates)}
  `) as { storage_key: string }[];

  return new Set(rows.map((row) => row.storage_key));
}

export async function sweepOrphanedObjects(
  sql: SQL,
  store: ObjectStore,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const cutoff = (options.now ?? new Date()).getTime() - (options.olderThanMs ?? DEFAULT_GRACE_MS);

  /*
   * Skyddet: ett tomt dokumentregister plus objekt i lagringen är mycket troligare en
   * felkonfiguration — tjänsten pekar på fel databas — än en bucket som råkar bestå av
   * enbart skräp. Raderingen är oåterkallelig, så vi avstår hellre.
   *
   * Priset är att den ovanliga situationen "alla dokument raderade, skräp kvar" inte
   * städas. Det felar åt rätt håll.
   */
  const [counted] = (await sql`
    SELECT count(*)::int AS n FROM bid_attachments
  `) as { n: number }[];

  if ((counted?.n ?? 0) === 0) {
    return { scanned: 0, deleted: 0, skippedReason: 'empty-attachment-table' };
  }

  let scanned = 0;
  let deleted = 0;

  for await (const page of store.listPages(ATTACHMENT_PREFIX, options.pageSize)) {
    const candidates = page
      .filter((object) => object.lastModified.getTime() <= cutoff)
      .map((object) => object.key);

    scanned += candidates.length;
    if (candidates.length === 0) continue;

    // En fråga per sida, inte per objekt, och aldrig hela registret i minnet.
    const known = await knownKeys(sql, candidates);

    for (const key of candidates) {
      if (known.has(key)) continue;
      await store.delete(key);
      deleted++;
    }
  }

  return { scanned, deleted };
}
