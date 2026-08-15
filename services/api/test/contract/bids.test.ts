import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;
let seller: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  seller = await actor(ctx.app, 'saljare');
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
  errors?: { path: string; message: string }[];
}

interface BidBody {
  id: string;
  requestId: string;
  sellerId: string;
  plan: string;
  compensation:
    | { type: 'fixed'; amountMinor: number; currency: string }
    | { type: 'hourly'; rateMinor: number; estimatedHours: number; currency: string };
  estimatedTotalMinor: number;
  status: string;
  createdAt: string;
}

const inFuture = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/** Skapar en förfrågan som köparen äger och returnerar dess id. */
async function createRequest(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
    title: 'Uppdrag att lämna anbud på',
    description: 'Distansuppdrag med tydlig avgränsning.',
    compensationPref: 'any',
    deadlineAt: inFuture(30),
    ...overrides,
  });
  if (res.statusCode !== 201) throw new Error(`Kunde inte skapa förfrågan: ${res.body}`);
  return res.json<{ id: string }>().id;
}

const fixedBid = {
  plan: 'Jag börjar med en kartläggning, levererar i tre steg och testar löpande.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

const hourlyBid = {
  plan: 'Löpande arbete i sprintar om två veckor, avstämning varje fredag.',
  compensation: { type: 'hourly', rateMinor: 95000, estimatedHours: 7.5, currency: 'SEK' },
};

const bidsUrl = (requestId: string) => `/api/v1/requests/${requestId}/bids`;

test('F6.1 fastprisanbud ger 201 med status submitted', async () => {
  const requestId = await createRequest();

  const res = await seller.post(bidsUrl(requestId), fixedBid);

  expect(res.statusCode).toBe(201);
  const body = res.json<BidBody>();
  expect(body.requestId).toBe(requestId);
  expect(body.sellerId).toBe(seller.id);
  expect(body.status).toBe('submitted');
  expect(body.compensation).toEqual({ type: 'fixed', amountMinor: 4500000, currency: 'SEK' });
  expect(body.estimatedTotalMinor).toBe(4500000);

  const rows = (await ctx.sql`
    SELECT compensation_type, fixed_amount_minor, hourly_rate_minor, estimated_hours
    FROM bids WHERE id = ${body.id}
  `) as {
    compensation_type: string;
    fixed_amount_minor: string | null;
    hourly_rate_minor: string | null;
    estimated_hours: string | null;
  }[];
  expect(rows[0]!.compensation_type).toBe('fixed');
  expect(rows[0]!.fixed_amount_minor).toBe('4500000');
  expect(rows[0]!.hourly_rate_minor).toBeNull();
  expect(rows[0]!.estimated_hours).toBeNull();
});

test('F6.2 timanbud med rate och estimatedHours ger 201', async () => {
  const requestId = await createRequest();

  const res = await seller.post(bidsUrl(requestId), hourlyBid);

  expect(res.statusCode).toBe(201);
  const body = res.json<BidBody>();
  expect(body.compensation).toEqual({
    type: 'hourly',
    rateMinor: 95000,
    estimatedHours: 7.5,
    currency: 'SEK',
  });
  // 950,00 kr × 7,5 h = 7 125,00 kr
  expect(body.estimatedTotalMinor).toBe(712500);
});

test('F6.3 fastpris med rateMinor i kroppen ger 422', async () => {
  const requestId = await createRequest();

  const res = await seller.post(bidsUrl(requestId), {
    plan: 'Blandar ihop ersättningsformerna.',
    compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK', rateMinor: 95000 },
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/validation-failed');
});

test('F6.3 timpris utan estimatedHours ger 422', async () => {
  const requestId = await createRequest();

  const res = await seller.post(bidsUrl(requestId), {
    plan: 'Timpris men inga timmar.',
    compensation: { type: 'hourly', rateMinor: 95000, currency: 'SEK' },
  });

  expect(res.statusCode).toBe(422);
});

test('F6.4 anbud på egen förfrågan ger 403', async () => {
  const requestId = await createRequest();

  const res = await buyer.post(bidsUrl(requestId), fixedBid);

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/own-request');
});

test('F6.5 andra anbudet från samma säljare ger 409', async () => {
  const requestId = await createRequest();

  const first = await seller.post(bidsUrl(requestId), fixedBid);
  expect(first.statusCode).toBe(201);

  const second = await seller.post(bidsUrl(requestId), hourlyBid);

  expect(second.statusCode).toBe(409);
  expect(second.json<Problem>().type).toBe('https://fastgig.dev/problems/bid-exists');
});

test('F6.5 en annan säljare får lämna anbud på samma förfrågan', async () => {
  const requestId = await createRequest();
  const other = await actor(ctx.app, 'annan-saljare');

  expect((await seller.post(bidsUrl(requestId), fixedBid)).statusCode).toBe(201);
  expect((await other.post(bidsUrl(requestId), hourlyBid)).statusCode).toBe(201);
});

test('F6.6 anbud efter deadline ger 422', async () => {
  const requestId = await createRequest();
  // API:et vägrar skapa en förfrågan med passerad deadline (F5.3), så vi flyttar den bakåt.
  await ctx.sql`
    UPDATE requests SET deadline_at = now() - interval '1 minute' WHERE id = ${requestId}
  `;

  const res = await seller.post(bidsUrl(requestId), fixedBid);

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('deadlineAt');
});

test('F6.7 anbud på okänd förfrågan ger 404', async () => {
  const res = await seller.post(
    bidsUrl('00000000-0000-4000-8000-000000000000'),
    fixedBid,
  );

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/request-not-found');
});

test('F6.7 ett requestId som inte är en uuid ger 422', async () => {
  const res = await seller.post(bidsUrl('inte-en-uuid'), fixedBid);

  expect(res.statusCode).toBe(422);
});

test('F6.8 anbud på en awarded förfrågan ger 422', async () => {
  const requestId = await createRequest();
  // Avtalsflödet finns först i etapp 6 — tills dess sätts statusen direkt.
  await ctx.sql`UPDATE requests SET status = 'awarded' WHERE id = ${requestId}`;

  const res = await seller.post(bidsUrl(requestId), fixedBid);

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('status');
});

test('F6.2 anbud utan token ger 401', async () => {
  const requestId = await createRequest();

  const res = await ctx.app.inject({
    method: 'POST',
    url: bidsUrl(requestId),
    payload: fixedBid,
  });

  expect(res.statusCode).toBe(401);
});
