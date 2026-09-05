import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';
import { publishSpecFor } from '../helpers/spec.ts';

let ctx: TestApp;
let buyer: Actor;
let otherBuyer: Actor;
let seller: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  otherBuyer = await actor(ctx.app, 'annan-kopare');
  seller = await actor(ctx.app, 'saljare');
});

afterAll(async () => {
  await ctx.close();
});

interface BidSummary {
  id: string;
  sellerId: string;
  sellerDisplayName: string;
  plan: string;
  compensation: Record<string, unknown>;
  estimatedTotalMinor: number;
  status: string;
  contract: {
    id: string;
    status: string;
    buyerSignedAt: string | null;
    sellerSignedAt: string | null;
  } | null;
  createdAt: string;
}

interface RequestItem {
  id: string;
  title: string;
  status: string;
  bids: BidSummary[];
}

interface Page {
  items: RequestItem[];
  nextCursor: string | null;
}

async function createRequest(as: Actor, title: string): Promise<string> {
  const res = await as.post('/api/v1/requests', {
    title,
    description: 'Distansuppdrag.',
    compensationPref: 'any',
  });
  if (res.statusCode !== 201) throw new Error(`skapa förfrågan: ${res.body}`);

  const requestId = res.json<{ id: string }>().id;
  // Anbud kräver publicerad kravspec (F6.9); intervjun har egna testfall.
  await publishSpecFor(ctx.sql, requestId);
  return requestId;
}

const fixedBid = {
  plan: 'Min genomförandeplan i tre steg.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

test('L3.1 returnerar bara egna förfrågningar, aldrig andras', async () => {
  const mine = await createRequest(buyer, 'Min egen förfrågan');
  const theirs = await createRequest(otherBuyer, 'Någon annans förfrågan');

  const res = await buyer.get('/api/v1/me/requests');

  expect(res.statusCode).toBe(200);
  const ids = res.json<Page>().items.map((i) => i.id);
  expect(ids).toContain(mine);
  expect(ids).not.toContain(theirs);
});

test('L3.2 inkluderar inlämnade anbud med plan, ersättning och status', async () => {
  const requestId = await createRequest(buyer, 'Förfrågan med anbud');
  const bid = await seller.post(`/api/v1/requests/${requestId}/bids`, fixedBid);
  expect(bid.statusCode).toBe(201);

  const res = await buyer.get('/api/v1/me/requests');
  const item = res.json<Page>().items.find((i) => i.id === requestId);

  expect(item).toBeDefined();
  expect(item!.bids).toHaveLength(1);
  const summary = item!.bids[0]!;
  expect(summary.sellerId).toBe(seller.id);
  expect(summary.sellerDisplayName).toBe('saljare');
  expect(summary.plan).toBe(fixedBid.plan);
  expect(summary.compensation).toEqual(fixedBid.compensation);
  expect(summary.estimatedTotalMinor).toBe(4500000);
  expect(summary.status).toBe('submitted');
});

test('L3.2 anbud på andras förfrågningar läcker inte in', async () => {
  const theirs = await createRequest(otherBuyer, 'Annans förfrågan med anbud');
  expect((await seller.post(`/api/v1/requests/${theirs}/bids`, fixedBid)).statusCode).toBe(201);

  const res = await buyer.get('/api/v1/me/requests');
  const allBidIds = res.json<Page>().items.flatMap((i) => i.bids.map((b) => b.id));

  const theirBids = (await ctx.sql`
    SELECT id FROM bids WHERE request_id = ${theirs}
  `) as { id: string }[];
  for (const { id } of theirBids) expect(allBidIds).not.toContain(id);
});

test('L3.3 förfrågan utan anbud ger tom lista, inte utelämnat fält', async () => {
  const requestId = await createRequest(buyer, 'Förfrågan utan anbud');

  const res = await buyer.get('/api/v1/me/requests');
  const item = res.json<Page>().items.find((i) => i.id === requestId);

  expect(item).toBeDefined();
  expect(item!.bids).toEqual([]);
});

test('L3.4 limit respekteras och cursor ger nästa sida utan dubbletter', async () => {
  const pagerBuyer = await actor(ctx.app, 'sidbrytare');
  const created: string[] = [];
  for (let i = 0; i < 5; i++) created.push(await createRequest(pagerBuyer, `Uppdrag ${i}`));

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const url: string = cursor
      ? `/api/v1/me/requests?limit=2&cursor=${encodeURIComponent(cursor)}`
      : '/api/v1/me/requests?limit=2';
    const res = await pagerBuyer.get(url);
    expect(res.statusCode).toBe(200);

    const page = res.json<Page>();
    expect(page.items.length).toBeLessThanOrEqual(2);
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);

  expect(new Set(seen).size).toBe(seen.length); // inga dubbletter
  expect(seen.sort()).toEqual([...created].sort()); // och inget tappat
  expect(pages).toBe(3); // 2 + 2 + 1
});

test('L3.4 nyaste först', async () => {
  const sortBuyer = await actor(ctx.app, 'sorterare');
  const first = await createRequest(sortBuyer, 'Äldst');
  const second = await createRequest(sortBuyer, 'Nyast');

  const items = (await sortBuyer.get('/api/v1/me/requests')).json<Page>().items;

  expect(items.map((i) => i.id)).toEqual([second, first]);
});

test('L3.4 en trasig cursor ger 422', async () => {
  const res = await buyer.get('/api/v1/me/requests?cursor=inte-en-cursor');

  expect(res.statusCode).toBe(422);
  expect(res.json<{ errors?: { path: string }[] }>().errors?.map((e) => e.path)).toContain(
    'cursor',
  );
});

test('L3.4 limit utanför intervallet ger 422', async () => {
  expect((await buyer.get('/api/v1/me/requests?limit=0')).statusCode).toBe(422);
  expect((await buyer.get('/api/v1/me/requests?limit=101')).statusCode).toBe(422);
});

test('L3.5 utan token ger 401', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/requests' });

  expect(res.statusCode).toBe(401);
});

test('L3.6 anbudet bär avtalets läge, så köparen ser sin egen signatur igen', async () => {
  const requestId = await createRequest(buyer, 'Förfrågan som ska signeras');
  const bidId = (
    await seller.post(`/api/v1/requests/${requestId}/bids`, fixedBid)
  ).json<{ id: string }>().id;

  // Utan avtal är fältet null — utelämnas det kan köparens sida inte skilja
  // "inget avtal" från "vet inte".
  const before = (await buyer.get('/api/v1/me/requests')).json<Page>();
  const bidBefore = before.items.find((i) => i.id === requestId)!.bids[0]!;
  expect(bidBefore.contract).toBeNull();

  await buyer.post(`/api/v1/bids/${bidId}/contract/signatures`, {});

  const after = (await buyer.get('/api/v1/me/requests')).json<Page>();
  const bidAfter = after.items.find((i) => i.id === requestId)!.bids[0]!;
  expect(bidAfter.contract).not.toBeNull();
  expect(bidAfter.contract!.status).toBe('pending_signatures');
  expect(bidAfter.contract!.buyerSignedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(bidAfter.contract!.sellerSignedAt).toBeNull();
});
