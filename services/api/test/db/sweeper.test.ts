import { test, expect, beforeAll, afterAll } from 'bun:test';
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
  const [user] = (await db.sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${`sweep-${crypto.randomUUID()}@example.test`}, 'h', 'S')
    RETURNING id
  `) as { id: string }[];
  const [request] = (await db.sql`
    INSERT INTO requests (buyer_id, title, description, compensation_pref)
    VALUES (${user!.id}, 'T', 'D', 'any') RETURNING id
  `) as { id: string }[];
  const [row] = (await db.sql`
    INSERT INTO bids (request_id, seller_id, plan, compensation_type, fixed_amount_minor)
    VALUES (${request!.id}, ${user!.id}, 'P', 'fixed', 1000) RETURNING id
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

test('G.7 en körning utan skräp rapporterar noll raderade', async () => {
  const bidId = await bid();
  const key = await attachment(bidId, 'enda.md');
  const memory = store([{ key, ageMs: 5 * HOUR }]);

  const result = await sweepOrphanedObjects(db.sql, memory, { olderThanMs: HOUR });

  expect(result).toMatchObject({ scanned: 1, deleted: 0 });
  expect(result.skippedReason).toBeUndefined();
});
