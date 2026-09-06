import { test, expect, beforeAll, afterAll } from 'bun:test';
import { insertUser } from '../helpers/rows.ts';
import { freshDatabase, type TestDatabase } from '../helpers/postgres.ts';
import { createMemoryObjectStore } from '../../src/storage/object-store.ts';
import { sweepOrphanedObjects } from '../../src/storage/sweeper.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.close();
});

const HOUR = 60 * 60 * 1000;

/** Ett anbud att hänga dokumentrader på. */
async function bid(): Promise<string> {
  const user = await insertUser(db.sql);
  const [request] = (await db.sql`
    INSERT INTO requests (buyer_id, buyer_organization_id, title, description, compensation_pref)
    VALUES (${user.id}, ${user.organizationId}, 'T', 'D', 'any') RETURNING id
  `) as { id: string }[];
  const [row] = (await db.sql`
    INSERT INTO bids (request_id, seller_id, seller_organization_id, plan,
                      compensation_type, fixed_amount_minor)
    VALUES (${request!.id}, ${user.id}, ${user.organizationId}, 'P', 'fixed', 1000) RETURNING id
  `) as { id: string }[];

  return row!.id;
}

/** Registrerar ett dokument i databasen och lägger objektet i lagringen. */
async function attachment(bidId: string, filename: string): Promise<string> {
  const id = crypto.randomUUID();
  const key = `bids/${bidId}/${id}`;
  await db.sql`
    INSERT INTO bid_attachments (id, bid_id, filename, content_type, size_bytes, storage_key)
    VALUES (${id}, ${bidId}, ${filename}, 'text/markdown', 3, ${key})
  `;
  return key;
}

const store = (entries: { key: string; ageMs: number }[]) => {
  const memory = createMemoryObjectStore();
  const now = Date.now();
  for (const entry of entries) {
    memory.objects.set(entry.key, {
      content: new Uint8Array([1, 2, 3]),
      contentType: 'text/markdown',
      lastModified: new Date(now - entry.ageMs),
    });
  }
  return memory;
};

test('G.1 ett föräldralöst objekt äldre än fristen raderas', async () => {
  const bidId = await bid();
  await attachment(bidId, 'kvar.md');
  const memory = store([
    { key: `bids/${bidId}/${crypto.randomUUID()}`, ageMs: 3 * HOUR },
    ...[...(await db.sql`SELECT storage_key FROM bid_attachments WHERE bid_id = ${bidId}`)].map(
      (r: { storage_key: string }) => ({ key: r.storage_key, ageMs: 3 * HOUR }),
    ),
  ]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result.deleted).toBe(1);
  expect(result.scanned).toBe(2);
  expect(memory.objects.size).toBe(1);
});

test('G.2 ett objekt med rad i databasen rörs inte', async () => {
  const bidId = await bid();
  const key = await attachment(bidId, 'har-rad.md');
  const memory = store([{ key, ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result.deleted).toBe(0);
  expect(memory.objects.has(key)).toBe(true);
});

test('G.3 ett nyligen uppladdat objekt rörs inte, även utan rad', async () => {
  // Skyddar uppladdningen som ligger mellan `put` och `INSERT` just nu.
  const bidId = await bid();
  await attachment(bidId, 'behovs.md');
  const fresh = `bids/${bidId}/${crypto.randomUUID()}`;
  const memory = store([{ key: fresh, ageMs: 5_000 }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result.deleted).toBe(0);
  expect(memory.objects.has(fresh)).toBe(true);
});

test('G.4 objekt utanför prefixet rörs inte', async () => {
  const bidId = await bid();
  await attachment(bidId, 'nagot.md');
  const memory = store([{ key: 'annat/skrap', ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result.scanned).toBe(0);
  expect(memory.objects.has('annat/skrap')).toBe(true);
});

test('G.5 en tom dokumenttabell stoppar städningen helt', async () => {
  // Tomt register plus objekt i lagringen är mycket troligare en felkonfiguration —
  // fel databas — än en bucket full av skräp. Att radera vore oåterkalleligt.
  const scratch = await freshDatabase();
  try {
    const memory = store([
      { key: 'bids/a/1', ageMs: 5 * HOUR },
      { key: 'bids/b/2', ageMs: 5 * HOUR },
    ]);

    const result = await sweepOrphanedObjects(scratch.sql, memory, { olderThanMs: HOUR });

    expect(result.deleted).toBe(0);
    expect(result.skippedReason).toBe('empty-attachment-table');
    expect(memory.objects.size).toBe(2);
  } finally {
    await scratch.close();
  }
});

test('G.6 städningen klarar fler objekt än en sida', async () => {
  const bidId = await bid();
  await attachment(bidId, 'ankare.md');

  const orphans = Array.from({ length: 25 }, () => ({
    key: `bids/${bidId}/${crypto.randomUUID()}`,
    ageMs: 5 * HOUR,
  }));
  const known = (await db.sql`
    SELECT storage_key FROM bid_attachments WHERE bid_id = ${bidId}
  `) as { storage_key: string }[];
  const memory = store([
    ...orphans,
    ...known.map((r) => ({ key: r.storage_key, ageMs: 5 * HOUR })),
  ]);

  const result = await sweepOrphanedObjects(db.sql, memory, {
    olderThanMs: HOUR,
    pageSize: 10,
  });

  expect(result.scanned).toBe(26);
  expect(result.deleted).toBe(25);
  expect(memory.objects.size).toBe(1);
});

// ------------------------------------------------ Rader utan objekt

/** Raden som databasen känner till, men vars innehåll saknas i lagringen. */
async function missingRow(bidId: string, filename: string): Promise<string> {
  const key = await attachment(bidId, filename);
  return key;
}

const missingSince = async (key: string): Promise<Date | null> => {
  const [row] = (await db.sql`
    SELECT content_missing_since FROM bid_attachments WHERE storage_key = ${key}
  `) as { content_missing_since: Date | null }[];
  return row?.content_missing_since ?? null;
};

test('G.8 en rad vars objekt saknas markeras', async () => {
  const bidId = await bid();
  const present = await attachment(bidId, 'finns.md');
  const absent = await missingRow(bidId, 'saknas.md');
  const memory = store([{ key: present, ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  // Jobbet stämmer av hela tabellen, så det globala talet räknar även rader som
  // tidigare testfall lämnat efter sig. Assertionen gäller det här anbudet.
  expect(result.markedMissing).toBeGreaterThanOrEqual(1);
  expect(await missingSince(absent)).toBeInstanceOf(Date);
  expect(await missingSince(present)).toBeNull();

  const marked = (await db.sql`
    SELECT count(*)::int AS n FROM bid_attachments
    WHERE bid_id = ${bidId} AND content_missing_since IS NOT NULL
  `) as { n: number }[];
  expect(marked[0]!.n).toBe(1);
});

test('G.9 en markerad rad raderas aldrig automatiskt', async () => {
  // Raden är beviset på att dokumentet funnits. Att tyst radera den vore att låta
  // ett lagringsfel se ut som om säljaren aldrig bifogat något.
  const bidId = await bid();
  const absent = await missingRow(bidId, 'kvar-trots-allt.md');
  await attachment(bidId, 'annan.md');
  const memory = store([]);

  await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  const kept = (await db.sql`
    SELECT count(*)::int AS n FROM bid_attachments WHERE storage_key = ${absent}
  `) as { n: number }[];
  expect(kept[0]!.n).toBe(1);
});

test('G.10 markeringen tas bort om objektet dyker upp igen', async () => {
  const bidId = await bid();
  const key = await missingRow(bidId, 'aterfunnen.md');
  await db.sql`
    UPDATE bid_attachments SET content_missing_since = now() - interval '1 day'
    WHERE storage_key = ${key}
  `;
  const memory = store([{ key, ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result.restored).toBe(1);
  expect(await missingSince(key)).toBeNull();
});

test('G.11 en markerad rad markeras inte om igen', async () => {
  const bidId = await bid();
  const key = await missingRow(bidId, 'redan-markerad.md');
  await sweepOrphanedObjects(db.sql, store([]), { olderThanMs: HOUR });
  const first = await missingSince(key);

  const result = await sweepOrphanedObjects(db.sql, store([]), { olderThanMs: HOUR });

  expect(result.markedMissing).toBe(0);
  expect(await missingSince(key)).toEqual(first);
});

test('G.12 en tom bucket markerar ingenting', async () => {
  // Rader utan ett enda objekt i lagringen är troligare fel bucket än att varenda
  // fil försvunnit. Att markera allt som trasigt vore lika fel som att radera.
  const scratch = await freshDatabase();
  try {
    const user = await insertUser(scratch.sql);
    const [request] = (await scratch.sql`
      INSERT INTO requests (buyer_id, buyer_organization_id, title, description, compensation_pref)
      VALUES (${user.id}, ${user.organizationId}, 'T', 'D', 'any') RETURNING id
    `) as { id: string }[];
    const [row] = (await scratch.sql`
      INSERT INTO bids (request_id, seller_id, seller_organization_id, plan,
                        compensation_type, fixed_amount_minor)
      VALUES (${request!.id}, ${user.id}, ${user.organizationId}, 'P', 'fixed', 1000) RETURNING id
    `) as { id: string }[];
    await scratch.sql`
      INSERT INTO bid_attachments (bid_id, filename, content_type, size_bytes, storage_key)
      VALUES (${row!.id}, 'a.md', 'text/markdown', 3, ${`bids/${row!.id}/x`})
    `;

    const result = await sweepOrphanedObjects(scratch.sql, store([]), { olderThanMs: HOUR });

    expect(result.markedMissing).toBe(0);
    expect(result.skippedReason).toBe('empty-bucket');
  } finally {
    await scratch.close();
  }
});

test('G.7 en körning utan skräp rapporterar noll raderade', async () => {
  const bidId = await bid();
  const key = await attachment(bidId, 'enda.md');
  const memory = store([{ key, ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result).toMatchObject({ scanned: 1, deleted: 0 });
  expect(result.skippedReason).toBeUndefined();
});
