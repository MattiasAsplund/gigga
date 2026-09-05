import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';
import { publishSpecFor } from '../helpers/spec.ts';

let ctx: TestApp;
let buyer: Actor;
let seller: Actor;
let otherSeller: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  seller = await actor(ctx.app, 'saljare');
  otherSeller = await actor(ctx.app, 'annan-saljare');
});

afterAll(async () => {
  await ctx.close();
});

interface BidItem {
  id: string;
  requestId: string;
  requestTitle: string;
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

interface Page {
  items: BidItem[];
  nextCursor: string | null;
}

const fixedBid = {
  plan: 'Genomförandeplan.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

async function createRequest(title: string): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
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

async function placeBid(as: Actor, requestId: string): Promise<string> {
  const res = await as.post(`/api/v1/requests/${requestId}/bids`, fixedBid);
  if (res.statusCode !== 201) throw new Error(`lämna anbud: ${res.body}`);
  return res.json<{ id: string }>().id;
}

test('L4.1 returnerar bara egna anbud', async () => {
  const requestId = await createRequest('Uppdrag med två anbud');
  const mine = await placeBid(seller, requestId);
  const theirs = await placeBid(otherSeller, requestId);

  const res = await seller.get('/api/v1/me/bids');

  expect(res.statusCode).toBe(200);
  const ids = res.json<Page>().items.map((i) => i.id);
  expect(ids).toContain(mine);
  expect(ids).not.toContain(theirs);
});

test('L4.1 anbudet bär förfrågans titel', async () => {
  const requestId = await createRequest('Titel som ska följa med');
  const bidId = await placeBid(seller, requestId);

  const item = (await seller.get('/api/v1/me/bids')).json<Page>().items.find(
    (i) => i.id === bidId,
  );

  expect(item).toBeDefined();
  expect(item!.requestTitle).toBe('Titel som ska följa med');
  expect(item!.requestId).toBe(requestId);
  expect(item!.estimatedTotalMinor).toBe(4500000);
});

test('L4.2 status speglar avtalsflödet', async () => {
  const requestId = await createRequest('Uppdrag som tilldelas');
  const accepted = await placeBid(seller, requestId);
  const rejected = await placeBid(otherSeller, requestId);

  // Genom det riktiga flödet: båda signaturerna aktiverar avtalet och avgör anbuden.
  await buyer.post(`/api/v1/bids/${accepted}/contract/signatures`);
  await seller.post(`/api/v1/bids/${accepted}/contract/signatures`);

  const mine = (await seller.get('/api/v1/me/bids')).json<Page>().items;
  const theirs = (await otherSeller.get('/api/v1/me/bids')).json<Page>().items;

  expect(mine.find((i) => i.id === accepted)!.status).toBe('accepted');
  expect(theirs.find((i) => i.id === rejected)!.status).toBe('rejected');
});

test('L4.3 contract är null innan avtal finns', async () => {
  const requestId = await createRequest('Uppdrag utan avtal');
  const bidId = await placeBid(seller, requestId);

  const item = (await seller.get('/api/v1/me/bids')).json<Page>().items.find(
    (i) => i.id === bidId,
  );

  expect(item!.contract).toBeNull();
});

test('L4.3b contract bär signaturernas tidpunkter när avtal finns', async () => {
  const requestId = await createRequest('Uppdrag med påbörjat avtal');
  const bidId = await placeBid(seller, requestId);

  // Köparens signatur skapar avtalet; säljaren har inte signerat än.
  const signed = await buyer.post(`/api/v1/bids/${bidId}/contract/signatures`);
  expect(signed.statusCode).toBe(200);
  const contractId = signed.json<{ contractId: string }>().contractId;

  const item = (await seller.get('/api/v1/me/bids')).json<Page>().items.find(
    (i) => i.id === bidId,
  );

  // Tidpunkten, inte bara ett ja/nej: avtalet är ett dokument, och när en part skrev
  // under hör till det. En boolean tvingar dessutom sidan att hitta på en tidpunkt.
  expect(item!.contract!.id).toBe(contractId);
  expect(item!.contract!.status).toBe('pending_signatures');
  expect(item!.contract!.buyerSignedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(item!.contract!.sellerSignedAt).toBeNull();
});

test('L4.4 ?status filtrerar', async () => {
  const filterSeller = await actor(ctx.app, 'filtrerare');
  const openRequest = await createRequest('Filter: kvar som submitted');
  const awardedRequest = await createRequest('Filter: blir accepted');

  const submitted = await placeBid(filterSeller, openRequest);
  const accepted = await placeBid(filterSeller, awardedRequest);
  await ctx.sql`UPDATE bids SET status = 'accepted' WHERE id = ${accepted}`;

  const onlySubmitted = (
    await filterSeller.get('/api/v1/me/bids?status=submitted')
  ).json<Page>().items;
  const onlyAccepted = (
    await filterSeller.get('/api/v1/me/bids?status=accepted')
  ).json<Page>().items;

  expect(onlySubmitted.map((i) => i.id)).toEqual([submitted]);
  expect(onlyAccepted.map((i) => i.id)).toEqual([accepted]);
});

test('L4.4 okänd status ger 422', async () => {
  const res = await seller.get('/api/v1/me/bids?status=funderar');

  expect(res.statusCode).toBe(422);
  expect(res.json<{ errors?: { path: string }[] }>().errors?.map((e) => e.path)).toContain(
    'status',
  );
});

test('L4.4 sidbrytning fungerar som för förfrågningar', async () => {
  const pager = await actor(ctx.app, 'anbudssidbrytare');
  const created: string[] = [];
  for (let i = 0; i < 5; i++) {
    created.push(await placeBid(pager, await createRequest(`Sidbrytning ${i}`)));
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const url: string = cursor
      ? `/api/v1/me/bids?limit=2&cursor=${encodeURIComponent(cursor)}`
      : '/api/v1/me/bids?limit=2';
    const page = (await pager.get(url)).json<Page>();
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);

  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.sort()).toEqual([...created].sort());
  expect(pages).toBe(3);
});

test('L4.1 utan token ger 401', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/bids' });

  expect(res.statusCode).toBe(401);
});
