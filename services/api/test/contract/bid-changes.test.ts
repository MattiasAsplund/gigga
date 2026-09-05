import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';
import { publishSpecFor } from '../helpers/spec.ts';

let ctx: TestApp;
let buyer: Actor;
let seller: Actor;
let rival: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  seller = await actor(ctx.app, 'saljare');
  rival = await actor(ctx.app, 'konkurrent');
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
  plan: string;
  compensation:
    | { type: 'fixed'; amountMinor: number; currency: string }
    | { type: 'hourly'; rateMinor: number; estimatedHours: number; currency: string };
  estimatedTotalMinor: number;
  status: string;
}

const inFuture = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

async function createRequest(): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
    title: 'Uppdrag att lämna anbud på',
    description: 'Distansuppdrag med tydlig avgränsning.',
    compensationPref: 'any',
    deadlineAt: inFuture(30),
  });
  if (res.statusCode !== 201) throw new Error(`Kunde inte skapa förfrågan: ${res.body}`);

  const requestId = res.json<{ id: string }>().id;
  // Anbud kräver publicerad kravspec (F6.9); intervjun har egna testfall.
  await publishSpecFor(ctx.sql, requestId);
  return requestId;
}

const fixedBid = {
  plan: 'Jag börjar med en kartläggning, levererar i tre steg och testar löpande.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

/** Skapar en förfrågan med ett anbud från `seller` och returnerar båda id:na. */
async function requestWithBid(): Promise<{ requestId: string; bidId: string }> {
  const requestId = await createRequest();
  const res = await seller.post(`/api/v1/requests/${requestId}/bids`, fixedBid);
  if (res.statusCode !== 201) throw new Error(`Kunde inte lämna anbud: ${res.body}`);
  return { requestId, bidId: res.json<{ id: string }>().id };
}

const changeBid = (as: Actor, bidId: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/bids/${bidId}`,
    payload: payload as never,
    headers: as.headers,
  });

const withdrawBid = (as: Actor, bidId: string) =>
  as.post(`/api/v1/bids/${bidId}/withdrawal`, {});

// ------------------------------------------------ Ä.1+ Ändra anbud

test('Ä.1 säljaren kan ändra plan och ersättning', async () => {
  const { bidId } = await requestWithBid();

  const res = await changeBid(seller, bidId, {
    plan: 'Omarbetad plan: två steg i stället för tre.',
    compensation: { type: 'hourly', rateMinor: 95000, estimatedHours: 40, currency: 'SEK' },
  });

  expect(res.statusCode).toBe(200);
  const body = res.json<BidBody>();
  expect(body.id).toBe(bidId);
  expect(body.plan).toBe('Omarbetad plan: två steg i stället för tre.');
  expect(body.compensation).toEqual({
    type: 'hourly',
    rateMinor: 95000,
    estimatedHours: 40,
    currency: 'SEK',
  });
  // 950 kr × 40 tim, uträknat av API:et som vid registrering.
  expect(body.estimatedTotalMinor).toBe(3800000);
  // Ändringen rör innehållet, inte anbudets läge.
  expect(body.status).toBe('submitted');
});

test('Ä.2 fälten går att ändra var för sig', async () => {
  const { bidId } = await requestWithBid();

  const onlyPlan = await changeBid(seller, bidId, { plan: 'Bara planen är ny.' });
  expect(onlyPlan.statusCode).toBe(200);
  expect(onlyPlan.json<BidBody>().plan).toBe('Bara planen är ny.');
  // Ersättningen står kvar orörd.
  expect(onlyPlan.json<BidBody>().compensation).toEqual(fixedBid.compensation as never);

  const onlyCompensation = await changeBid(seller, bidId, {
    compensation: { type: 'fixed', amountMinor: 3000000, currency: 'SEK' },
  });
  expect(onlyCompensation.statusCode).toBe(200);
  expect(onlyCompensation.json<BidBody>().plan).toBe('Bara planen är ny.');
  expect(onlyCompensation.json<BidBody>().estimatedTotalMinor).toBe(3000000);
});

test('Ä.3 en kropp utan fält ger 422', async () => {
  const { bidId } = await requestWithBid();

  const res = await changeBid(seller, bidId, {});

  expect(res.statusCode).toBe(422);
});

test('Ä.4 en annan säljare får inte ändra anbudet', async () => {
  const { bidId } = await requestWithBid();

  const res = await changeBid(rival, bidId, { plan: 'Jag skriver om ditt anbud.' });

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/not-bid-owner');
});

test('Ä.4b köparen får inte heller ändra anbudet', async () => {
  const { bidId } = await requestWithBid();

  // Köparen äger förfrågan, men anbudet är säljarens.
  const res = await changeBid(buyer, bidId, { plan: 'Jag justerar ditt anbud åt dig.' });

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/not-bid-owner');
});

test('Ä.5 okänt anbud ger 404', async () => {
  const res = await changeBid(seller, '00000000-0000-4000-8000-000000000000', {
    plan: 'Finns inte.',
  });

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/bid-not-found');
});

test('Ä.6 ogiltig ersättning ger 422', async () => {
  const { bidId } = await requestWithBid();

  const res = await changeBid(seller, bidId, {
    compensation: { type: 'hourly', rateMinor: 95000, currency: 'SEK' },
  });

  expect(res.statusCode).toBe(422);
});

test('Ä.7 ändring efter deadline ger 422', async () => {
  const { requestId, bidId } = await requestWithBid();
  await ctx.sql`
    UPDATE requests SET deadline_at = now() - interval '1 minute' WHERE id = ${requestId}
  `;

  const res = await changeBid(seller, bidId, { plan: 'För sent.' });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('deadlineAt');
});

test('Ä.8 ändring när förfrågan inte längre är öppen ger 422', async () => {
  const { requestId, bidId } = await requestWithBid();
  await ctx.sql`UPDATE requests SET status = 'awarded' WHERE id = ${requestId}`;

  const res = await changeBid(seller, bidId, { plan: 'Loppet är kört.' });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('status');
});

test('Ä.9 ändring när avtalet finns ger 409', async () => {
  const { bidId } = await requestWithBid();
  const signed = await buyer.post(`/api/v1/bids/${bidId}/contract/signatures`, {});
  expect(signed.statusCode).toBe(200);

  const res = await changeBid(seller, bidId, { plan: 'Villkoren är redan frysta.' });

  expect(res.statusCode).toBe(409);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/contract-exists');
});

test('Ä.10 ett tillbakadraget anbud går inte att ändra', async () => {
  const { bidId } = await requestWithBid();
  expect((await withdrawBid(seller, bidId)).statusCode).toBe(200);

  const res = await changeBid(seller, bidId, { plan: 'Ångrade mig igen.' });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('status');
});

// ------------------------------------------------ Ä.11+ Dra tillbaka anbud

test('Ä.11 säljaren kan dra tillbaka sitt anbud', async () => {
  const { bidId } = await requestWithBid();

  const res = await withdrawBid(seller, bidId);

  expect(res.statusCode).toBe(200);
  expect(res.json<BidBody>().status).toBe('withdrawn');
});

test('Ä.12 tillbakadragande är idempotent', async () => {
  const { bidId } = await requestWithBid();

  const first = await withdrawBid(seller, bidId);
  const second = await withdrawBid(seller, bidId);

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
});

test('Ä.13 efter tillbakadragande går det att lämna ett nytt anbud', async () => {
  const { requestId, bidId } = await requestWithBid();
  await withdrawBid(seller, bidId);

  const res = await seller.post(`/api/v1/requests/${requestId}/bids`, {
    plan: 'Nytt försök med skarpare pris.',
    compensation: { type: 'fixed', amountMinor: 3900000, currency: 'SEK' },
  });

  // Det partiella unika indexet räknar bara anbud som inte är tillbakadragna.
  expect(res.statusCode).toBe(201);
  expect(res.json<BidBody>().id).not.toBe(bidId);
});

test('Ä.14 ett tillbakadraget anbud räknas inte i katalogen', async () => {
  const { requestId, bidId } = await requestWithBid();

  const before = await rival.get('/api/v1/requests');
  const countBefore = before
    .json<{ items: { id: string; bidCount: number }[] }>()
    .items.find((item) => item.id === requestId)!.bidCount;
  expect(countBefore).toBe(1);

  await withdrawBid(seller, bidId);

  const after = await rival.get('/api/v1/requests');
  expect(
    after
      .json<{ items: { id: string; bidCount: number }[] }>()
      .items.find((item) => item.id === requestId)!.bidCount,
  ).toBe(0);
});

test('Ä.15 bara säljaren får dra tillbaka anbudet', async () => {
  const { bidId } = await requestWithBid();

  const res = await withdrawBid(buyer, bidId);

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/not-bid-owner');
});

test('Ä.16 tillbakadragande när avtalet finns ger 409', async () => {
  const { bidId } = await requestWithBid();
  expect(
    (await buyer.post(`/api/v1/bids/${bidId}/contract/signatures`, {})).statusCode,
  ).toBe(200);

  const res = await withdrawBid(seller, bidId);

  // Säljaren som ångrar sig låter bli att signera; avtalet rivs inte under köparen.
  expect(res.statusCode).toBe(409);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/contract-exists');
});

test('Ä.17 tillbakadragande av okänt anbud ger 404', async () => {
  const res = await withdrawBid(seller, '00000000-0000-4000-8000-000000000000');

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/bid-not-found');
});
