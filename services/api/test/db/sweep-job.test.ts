import { test, expect, beforeAll, afterAll } from 'bun:test';
import { freshDatabase, type TestDatabase } from '../helpers/postgres.ts';
import { createMemoryObjectStore } from '../../src/storage/object-store.ts';
import { createMemoryMailer } from '../../src/mail/mailer.ts';
import { runStorageSweep } from '../../src/storage/sweep-job.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.close();
});

const ALERT_TO = 'drift@fastgig.test';

/** Ett anbud med `count` dokumentrader vars objekt aldrig lagts upp. */
async function brokenAttachments(count: number, prefix: string): Promise<string> {
  const [user] = (await db.sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${`${prefix}-${crypto.randomUUID()}@example.test`}, 'h', 'S')
    RETURNING id
  `) as { id: string }[];
  const [request] = (await db.sql`
    INSERT INTO requests (buyer_id, title, description, compensation_pref)
    VALUES (${user!.id}, 'T', 'D', 'any') RETURNING id
  `) as { id: string }[];
  const [bid] = (await db.sql`
    INSERT INTO bids (request_id, seller_id, plan, compensation_type, fixed_amount_minor)
    VALUES (${request!.id}, ${user!.id}, 'P', 'fixed', 1000) RETURNING id
  `) as { id: string }[];

  for (let i = 0; i < count; i++) {
    await db.sql`
      INSERT INTO bid_attachments (bid_id, filename, content_type, size_bytes, storage_key)
      VALUES (${bid!.id}, ${`${prefix}-${i}.md`}, 'text/markdown', 3,
              ${`bids/${bid!.id}/${crypto.randomUUID()}`})
    `;
  }
  return bid!.id;
}

/** En lagring som innehåller minst ett objekt, så tom-bucket-skyddet inte slår till. */
function storeWithAnchor() {
  const store = createMemoryObjectStore();
  store.objects.set('bids/ankare/ankare', {
    content: new Uint8Array([1]),
    contentType: 'text/markdown',
    lastModified: new Date(),
  });
  return store;
}

test('G.13 markerade dokument namnges i resultatet', async () => {
  const bidId = await brokenAttachments(2, 'namnges');

  const result = await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer: createMemoryMailer(),
    alertEmail: ALERT_TO,
  });

  const mine = result.marked.filter((m) => m.bidId === bidId);
  expect(mine).toHaveLength(2);
  expect(mine.map((m) => m.filename).sort()).toEqual(['namnges-0.md', 'namnges-1.md']);
});

test('G.14 ett larm skickas när något markeras', async () => {
  await brokenAttachments(1, 'larmar');
  const mailer = createMemoryMailer();

  await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer,
    alertEmail: ALERT_TO,
  });

  expect(mailer.sent).toHaveLength(1);
  expect(mailer.sent[0]!.to).toBe(ALERT_TO);
  expect(mailer.sent[0]!.subject).toContain('saknas');
  expect(mailer.sent[0]!.text).toContain('larmar-0.md');
});

test('G.15 ett larm per körning, inte ett per dokument', async () => {
  // Ett lagringsfel kan slå ut tusen dokument på en gång. Tusen mail vore obrukbart.
  await brokenAttachments(25, 'manga');
  const mailer = createMemoryMailer();

  const result = await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer,
    alertEmail: ALERT_TO,
  });

  expect(result.markedMissing).toBeGreaterThanOrEqual(25);
  expect(mailer.sent).toHaveLength(1);
  // Antalet ska framgå även när listan är avkortad.
  expect(mailer.sent[0]!.text).toContain(String(result.markedMissing));
});

test('G.16 inget larm när inget markeras', async () => {
  const mailer = createMemoryMailer();

  // Andra körningen: allt trasigt är redan markerat och markeras inte om igen.
  await runStorageSweep({ sql: db.sql, objects: storeWithAnchor(), mailer, alertEmail: ALERT_TO });

  expect(mailer.sent).toHaveLength(0);
});

test('G.17 utan konfigurerad larmadress skickas inget', async () => {
  await brokenAttachments(1, 'tyst');
  const mailer = createMemoryMailer();

  const result = await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer,
    alertEmail: '',
  });

  expect(result.markedMissing).toBeGreaterThanOrEqual(1);
  expect(mailer.sent).toHaveLength(0);
});

test('G.18 ett misslyckat larm fäller inte städningen', async () => {
  await brokenAttachments(1, 'trasig-post');
  const mailer = createMemoryMailer();
  mailer.send = async () => {
    throw new Error('SMTP nere');
  };

  const result = await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer,
    alertEmail: ALERT_TO,
  });

  // Markeringen är gjord och rapporterad; att posten inte gick fram ändrar inte det.
  expect(result.markedMissing).toBeGreaterThanOrEqual(1);
  expect(result.alertFailed).toBe(true);
});

test('G.19 larmet är avkortat men säger hur mycket som utelämnats', async () => {
  await brokenAttachments(30, 'avkortat');
  const mailer = createMemoryMailer();

  await runStorageSweep({
    sql: db.sql,
    objects: storeWithAnchor(),
    mailer,
    alertEmail: ALERT_TO,
  });

  const text = mailer.sent[0]!.text;
  expect(text).toContain('till');
  // Inte alla trettio radas upp.
  expect(text.split('\n').length).toBeLessThan(40);
});
