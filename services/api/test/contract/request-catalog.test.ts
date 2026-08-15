import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;
let otherBuyer: Actor;
let seller: Actor;
let otherSeller: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  otherBuyer = await actor(ctx.app, 'annan-kopare');
  seller = await actor(ctx.app, 'saljare');
  otherSeller = await actor(ctx.app, 'annan-saljare');
});

afterAll(async () => {
  await ctx.close();
});

interface CatalogItem {
  id: string;
  buyerId: string;
  buyerDisplayName: string;
  title: string;
  description: string;
  compensationPref: string;
  budget: { amountMinor: number; currency: string } | null;
  deadlineAt: string | null;
  status: string;
  bidCount: number;
  hasMyBid: boolean;
  canBid: boolean;
  createdAt: string;
}

interface Page {
  items: CatalogItem[];
  nextCursor: string | null;
}

const inFuture = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

async function createRequest(
  as: Actor,
  title: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await as.post('/api/v1/requests', {
    title,
    description: 'Distansuppdrag.',
    compensationPref: 'any',
    deadlineAt: inFuture(30),
    ...overrides,
  });
  if (res.statusCode !== 201) throw new Error(`skapa förfrågan: ${res.body}`);
  return res.json<{ id: string }>().id;
}

const bidBody = {
  plan: 'Min genomförandeplan.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

const catalog = (as: Actor, query = '') =>
  as.get(`/api/v1/requests${query}`);

test('L8.1 en säljare ser öppna förfrågningar från andra', async () => {
  const id = await createRequest(buyer, 'Öppet uppdrag att hitta');

  const res = await catalog(seller);

  expect(res.statusCode).toBe(200);
  const item = res.json<Page>().items.find((i) => i.id === id);
  expect(item).toBeDefined();
  expect(item!.buyerId).toBe(buyer.id);
  expect(item!.buyerDisplayName).toBe('kopare');
  expect(item!.status).toBe('open');
  expect(item!.canBid).toBe(true);
});

test('L8.2 utan token ger 401', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/requests' });

  expect(res.statusCode).toBe(401);
});

test('L8.3 tilldelade förfrågningar visas inte', async () => {
  const id = await createRequest(buyer, 'Uppdrag som tilldelas');
  const bidId = await (async () => {
    const res = await seller.post(`/api/v1/requests/${id}/bids`, bidBody);
    return res.json<{ id: string }>().id;
  })();
  await buyer.post(`/api/v1/bids/${bidId}/contract/signatures`);
  await seller.post(`/api/v1/bids/${bidId}/contract/signatures`);

  const ids = (await catalog(otherSeller)).json<Page>().items.map((i) => i.id);

  expect(ids).not.toContain(id);
});

test('L8.4 förfrågningar med passerad deadline visas inte', async () => {
  const id = await createRequest(buyer, 'Uppdrag med passerad deadline');
  await ctx.sql`
    UPDATE requests SET deadline_at = now() - interval '1 minute' WHERE id = ${id}
  `;

  const ids = (await catalog(seller)).json<Page>().items.map((i) => i.id);

  expect(ids).not.toContain(id);
});

test('L8.4 förfrågan helt utan deadline visas', async () => {
  const id = await createRequest(buyer, 'Uppdrag utan deadline', { deadlineAt: undefined });

  const ids = (await catalog(seller)).json<Page>().items.map((i) => i.id);

  expect(ids).toContain(id);
});

test('L8.5 bidCount räknar anbuden och hasMyBid speglar mitt eget', async () => {
  const id = await createRequest(buyer, 'Uppdrag med två anbud');
  await seller.post(`/api/v1/requests/${id}/bids`, bidBody);
  await otherSeller.post(`/api/v1/requests/${id}/bids`, bidBody);

  const mine = (await catalog(seller)).json<Page>().items.find((i) => i.id === id);
  const third = await actor(ctx.app, 'tredje-saljare');
  const theirs = (await catalog(third)).json<Page>().items.find((i) => i.id === id);

  expect(mine!.bidCount).toBe(2);
  expect(mine!.hasMyBid).toBe(true);
  expect(theirs!.bidCount).toBe(2);
  expect(theirs!.hasMyBid).toBe(false);
});

test('L8.6 canBid är false för egen förfrågan', async () => {
  const id = await createRequest(buyer, 'Min egen förfrågan i katalogen');

  const item = (await catalog(buyer)).json<Page>().items.find((i) => i.id === id);

  expect(item).toBeDefined();
  expect(item!.canBid).toBe(false);
  expect(item!.hasMyBid).toBe(false);
});

test('L8.6 canBid är false när jag redan lämnat anbud', async () => {
  const id = await createRequest(buyer, 'Uppdrag jag redan lagt anbud på');
  await seller.post(`/api/v1/requests/${id}/bids`, bidBody);

  const item = (await catalog(seller)).json<Page>().items.find((i) => i.id === id);

  expect(item!.canBid).toBe(false);
  expect(item!.hasMyBid).toBe(true);
});

test('L8.7 inga anbudsdetaljer läcker ut', async () => {
  const id = await createRequest(buyer, 'Uppdrag vars anbud är hemliga');
  await otherSeller.post(`/api/v1/requests/${id}/bids`, {
    plan: 'HEMLIG PLAN SOM INTE FÅR SYNAS',
    compensation: { type: 'fixed', amountMinor: 1234567, currency: 'SEK' },
  });

  const res = await catalog(seller);

  expect(res.body).not.toContain('HEMLIG PLAN');
  expect(res.body).not.toContain('1234567');
  const item = res.json<Page>().items.find((i) => i.id === id);
  expect(item).not.toHaveProperty('bids');
});

test('L8.8 ?compensationPref filtrerar', async () => {
  const filterBuyer = await actor(ctx.app, 'filter-kopare');
  const fixed = await createRequest(filterBuyer, 'Bara fastpris', {
    compensationPref: 'fixed',
  });
  const hourly = await createRequest(filterBuyer, 'Bara timpris', {
    compensationPref: 'hourly',
  });

  const onlyFixed = (await catalog(seller, '?compensationPref=fixed')).json<Page>().items;
  const ids = onlyFixed.map((i) => i.id);

  expect(ids).toContain(fixed);
  expect(ids).not.toContain(hourly);
});

test('L8.8 okänd compensationPref ger 422', async () => {
  const res = await catalog(seller, '?compensationPref=barter');

  expect(res.statusCode).toBe(422);
  expect(res.json<{ errors?: { path: string }[] }>().errors?.map((e) => e.path)).toContain(
    'compensationPref',
  );
});

test('L8.9 sidbrytning ger alla poster utan dubbletter', async () => {
  const pageBuyer = await actor(ctx.app, 'katalog-kopare');
  const created: string[] = [];
  for (let i = 0; i < 5; i++) {
    created.push(await createRequest(pageBuyer, `Katalogsida ${i}`));
  }
  const viewer = await actor(ctx.app, 'katalog-lasare');

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const url: string = cursor
      ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
      : '?limit=2';
    const page = (await catalog(viewer, url)).json<Page>();
    expect(page.items.length).toBeLessThanOrEqual(2);
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 20);

  expect(new Set(seen).size).toBe(seen.length);
  for (const id of created) expect(seen).toContain(id);
});

test('L8.9 nyaste först', async () => {
  const sortBuyer = await actor(ctx.app, 'katalog-sorterare');
  const first = await createRequest(sortBuyer, 'Katalog äldst');
  const second = await createRequest(sortBuyer, 'Katalog nyast');

  const items = (await catalog(seller)).json<Page>().items;
  const positions = [first, second].map((id) => items.findIndex((i) => i.id === id));

  expect(positions[0]).toBeGreaterThan(positions[1]!);
});
