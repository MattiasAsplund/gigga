import type { SQL } from 'bun';
import type { ObjectStore } from './object-store.ts';

/**
 * Städning av föräldralösa objekt.
 *
 * Ett anbudsdokument skrivs i två steg: objektet först, raden sedan. Dör processen
 * däremellan blir objektet kvar utan rad — skräp som ingen kan nå och som ingen städar.
 *
 * Motsatsen finns också: en rad vars objekt saknas. Den behandlas helt annorlunda.
 * Ett föräldralöst objekt är skräp och kan raderas; en rad utan objekt är ett *fel* som
 * någon behöver få veta om. Raden är beviset på att säljaren bifogat något, så den
 * markeras i stället för att raderas, och API:et redovisar dokumentet som otillgängligt.
 *
 * Båda avgörs i samma genomgång av bucketen.
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

/** Ett dokument som just konstaterats sakna sitt innehåll. */
export interface MarkedAttachment {
  id: string;
  bidId: string;
  filename: string;
}

export interface SweepResult {
  /** Objekt under prefixet som var äldre än fristen och alltså prövades. */
  scanned: number;
  deleted: number;
  /** Rader vars objekt saknades och som nu är markerade som otillgängliga. */
  markedMissing: number;
  /** Vilka de var — underlaget till larmet. */
  marked: MarkedAttachment[];
  /** Rader som var markerade men vars objekt kommit tillbaka. */
  restored: number;
  /** Satt när något av stegen avstod från att göra något alls. */
  skippedReason?: 'empty-attachment-table' | 'empty-bucket';
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
    return {
      scanned: 0,
      deleted: 0,
      markedMissing: 0,
      marked: [],
      restored: 0,
      skippedReason: 'empty-attachment-table',
    };
  }

  let scanned = 0;
  let deleted = 0;

  /*
   * Nycklarna samlas under samma genomgång som skräpletandet, så avstämningen mot
   * databasen kostar inga extra anrop. Minnet växer med antalet objekt i bucketen —
   * bara strängar, men värt att veta: alternativet vore ett HEAD-anrop per rad.
   */
  const seen = new Set<string>();

  for await (const page of store.listPages(ATTACHMENT_PREFIX, options.pageSize)) {
    for (const object of page) seen.add(object.key);

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
      seen.delete(key);
    }
  }

  /*
   * Spegelvänt skydd mot det i början: en bucket utan ett enda objekt, medan databasen
   * har dokumentrader, är troligare fel bucket än att varenda fil försvunnit. Att
   * markera allt som trasigt vore lika fel som att radera allt.
   */
  if (seen.size === 0) {
    return {
      scanned,
      deleted,
      markedMissing: 0,
      marked: [],
      restored: 0,
      skippedReason: 'empty-bucket',
    };
  }

  const keys = [...seen];

  const marked = (await sql`
    UPDATE bid_attachments
    SET content_missing_since = now()
    WHERE content_missing_since IS NULL
      AND storage_key NOT IN ${sql(keys)}
    RETURNING id, bid_id, filename
  `) as { id: string; bid_id: string; filename: string }[];

  const restored = (await sql`
    UPDATE bid_attachments
    SET content_missing_since = NULL
    WHERE content_missing_since IS NOT NULL
      AND storage_key IN ${sql(keys)}
    RETURNING id
  `) as { id: string }[];

  return {
    scanned,
    deleted,
    markedMissing: marked.length,
    marked: marked.map((row) => ({
      id: row.id,
      bidId: row.bid_id,
      filename: row.filename,
    })),
    restored: restored.length,
  };
}
