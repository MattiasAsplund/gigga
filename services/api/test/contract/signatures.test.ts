import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;
let seller: Actor;
let otherSeller: Actor;
let stranger: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  seller = await actor(ctx.app, 'saljare');
  otherSeller = await actor(ctx.app, 'annan-saljare');
  stranger = await actor(ctx.app, 'utomstaende');
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
  errors?: { path: string; message: string }[];
}

interface ContractBody {
  contractId: string;
  status: 'pending_signatures' | 'active' | 'void';
  buyerSignedAt: string | null;
  sellerSignedAt: string | null;
  terms: {
    bidId: string;
    requestId: string;
    buyerId: string;
    sellerId: string;
    requestTitle: string;
    plan: string;
    compensation: Record<string, unknown>;
    estimatedTotalMinor: number;
    frozenAt: string;
  };
}

const fixedBid = {
  plan: 'Kartläggning, bygge, överlämning.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

const hourlyBid = {
  plan: 'Löpande arbete i sprintar.',
  compensation: { type: 'hourly', rateMinor: 95000, estimatedHours: 7.5, currency: 'SEK' },
};

const signUrl = (bidId: string) => `/api/v1/bids/${bidId}/contract/signatures`;

async function createRequest(title = 'Uppdrag att teckna avtal om'): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
    title,
    description: 'Distansuppdrag.',
    compensationPref: 'any',
  });
  if (res.statusCode !== 201) throw new Error(`skapa förfrågan: ${res.body}`);
  return res.json<{ id: string }>().id;
}

async function placeBid(
  as: Actor,
  requestId: string,
  body: { plan: string; compensation: Record<string, unknown> } = fixedBid,
): Promise<string> {
  const res = await as.post(`/api/v1/requests/${requestId}/bids`, body);
  if (res.statusCode !== 201) throw new Error(`lämna anbud: ${res.body}`);
  return res.json<{ id: string }>().id;
}

/** Förfrågan med ett anbud från `seller`. */
async function setup(): Promise<{ requestId: string; bidId: string }> {
  const requestId = await createRequest();
  return { requestId, bidId: await placeBid(seller, requestId) };
}

test('S7.1 köparens signatur skapar avtalet med frysta villkor', async () => {
  const { requestId, bidId } = await setup();

  const res = await buyer.post(signUrl(bidId));

  expect(res.statusCode).toBe(200);
  const body = res.json<ContractBody>();
  expect(body.status).toBe('pending_signatures');
  expect(body.buyerSignedAt).not.toBeNull();
  expect(body.sellerSignedAt).toBeNull();

  expect(body.terms.bidId).toBe(bidId);
  expect(body.terms.requestId).toBe(requestId);
  expect(body.terms.buyerId).toBe(buyer.id);
  expect(body.terms.sellerId).toBe(seller.id);
  expect(body.terms.plan).toBe(fixedBid.plan);
  expect(body.terms.compensation).toEqual(fixedBid.compensation);
  expect(body.terms.estimatedTotalMinor).toBe(4500000);

  // Förfrågan är fortfarande öppen — ett avtal utan båda signaturerna binder ingen.
  const rows = (await ctx.sql`SELECT status FROM requests WHERE id = ${requestId}`) as {
    status: string;
  }[];
  expect(rows[0]!.status).toBe('open');
});

test('S7.2 säljarens signatur därefter aktiverar avtalet', async () => {
  const { bidId } = await setup();
  expect((await buyer.post(signUrl(bidId))).statusCode).toBe(200);

  const res = await seller.post(signUrl(bidId));

  expect(res.statusCode).toBe(200);
  const body = res.json<ContractBody>();
  expect(body.status).toBe('active');
  expect(body.buyerSignedAt).not.toBeNull();
  expect(body.sellerSignedAt).not.toBeNull();
});

test('S7.3 aktivt avtal tilldelar förfrågan och avslår övriga anbud', async () => {
  const requestId = await createRequest();
  const winning = await placeBid(seller, requestId);
  const losing = await placeBid(otherSeller, requestId, hourlyBid);

  await buyer.post(signUrl(winning));
  expect((await seller.post(signUrl(winning))).statusCode).toBe(200);

  const [request] = (await ctx.sql`
    SELECT status FROM requests WHERE id = ${requestId}
  `) as { status: string }[];
  expect(request!.status).toBe('awarded');

  const bids = (await ctx.sql`
    SELECT id, status FROM bids WHERE request_id = ${requestId}
  `) as { id: string; status: string }[];
  expect(bids.find((b) => b.id === winning)!.status).toBe('accepted');
  expect(bids.find((b) => b.id === losing)!.status).toBe('rejected');
});

test('S7.4 säljaren kan inte signera först — det finns inget avtal än', async () => {
  const { bidId } = await setup();

  const res = await seller.post(signUrl(bidId));

  expect(res.statusCode).toBe(409);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/no-contract-yet');
});

test('S7.5 en utomstående får 403', async () => {
  const { bidId } = await setup();
  await buyer.post(signUrl(bidId));

  const res = await stranger.post(signUrl(bidId));

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/not-a-party');
});

test('S7.5 en utomstående får 403 även innan avtalet finns', async () => {
  const { bidId } = await setup();

  const res = await stranger.post(signUrl(bidId));

  expect(res.statusCode).toBe(403);
});

test('S7.6 samma part två gånger ger 200 och oförändrade tidsstämplar', async () => {
  const { bidId } = await setup();

  const first = await buyer.post(signUrl(bidId));
  const second = await buyer.post(signUrl(bidId));

  expect(second.statusCode).toBe(200);
  const a = first.json<ContractBody>();
  const b = second.json<ContractBody>();
  expect(b.contractId).toBe(a.contractId);
  expect(b.buyerSignedAt).toBe(a.buyerSignedAt);
  expect(b.status).toBe('pending_signatures');

  const counted = (await ctx.sql`
    SELECT count(*)::int AS n FROM contracts WHERE bid_id = ${bidId}
  `) as { n: number }[];
  expect(counted[0]!.n).toBe(1);
});

test('S7.6 signatur på ett redan aktivt avtal ändrar ingenting', async () => {
  const { bidId } = await setup();
  await buyer.post(signUrl(bidId));
  const activated = (await seller.post(signUrl(bidId))).json<ContractBody>();

  const again = await buyer.post(signUrl(bidId));

  expect(again.statusCode).toBe(200);
  expect(again.json<ContractBody>().sellerSignedAt).toBe(activated.sellerSignedAt);
  expect(again.json<ContractBody>().buyerSignedAt).toBe(activated.buyerSignedAt);
});

test('S7.7 ett ändrat anbud påverkar inte avtalets villkor', async () => {
  const { bidId } = await setup();
  const created = (await buyer.post(signUrl(bidId))).json<ContractBody>();

  // Det finns inget API för att ändra anbud — vi går direkt på tabellen.
  await ctx.sql`
    UPDATE bids
    SET plan = 'Helt annan plan', fixed_amount_minor = 9900000
    WHERE id = ${bidId}
  `;

  const after = (await seller.post(signUrl(bidId))).json<ContractBody>();

  expect(after.terms.plan).toBe(fixedBid.plan);
  expect(after.terms.compensation).toEqual(fixedBid.compensation);
  expect(after.terms.frozenAt).toBe(created.terms.frozenAt);
});

test('S7.8 två samtidiga signaturer ger exakt ett avtal', async () => {
  const { bidId } = await setup();

  const [a, b] = await Promise.all([buyer.post(signUrl(bidId)), buyer.post(signUrl(bidId))]);

  expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  expect(a.json<ContractBody>().contractId).toBe(b.json<ContractBody>().contractId);

  const counted = (await ctx.sql`
    SELECT count(*)::int AS n FROM contracts WHERE bid_id = ${bidId}
  `) as { n: number }[];
  expect(counted[0]!.n).toBe(1);
});

test('S7.8 samtidiga signaturer från båda parter aktiverar avtalet en gång', async () => {
  const { requestId, bidId } = await setup();
  await buyer.post(signUrl(bidId));

  const [a, b] = await Promise.all([
    seller.post(signUrl(bidId)),
    seller.post(signUrl(bidId)),
  ]);

  expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  expect(a.json<ContractBody>().sellerSignedAt).toBe(b.json<ContractBody>().sellerSignedAt);

  const [request] = (await ctx.sql`
    SELECT status FROM requests WHERE id = ${requestId}
  `) as { status: string }[];
  expect(request!.status).toBe('awarded');
});

test('S7.1 tom kropp med content-type: application/json accepteras', async () => {
  // Vanliga HTTP-klienter sätter content-type på varje POST, även utan kropp. Utan
  // parsern i plugins/validation.ts blir routen 400 och därmed obrukbar från fetch/curl.
  const { bidId } = await setup();

  const res = await ctx.app.inject({
    method: 'POST',
    url: signUrl(bidId),
    headers: { ...buyer.headers, 'content-type': 'application/json' },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json<ContractBody>().status).toBe('pending_signatures');
});

test('S7.1 tom kropp där en kropp krävs ger 422, inte 400', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/requests',
    headers: { ...buyer.headers, 'content-type': 'application/json' },
  });

  expect(res.statusCode).toBe(422);
});

test('S7.1 trasig JSON ger 400', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/requests',
    headers: { ...buyer.headers, 'content-type': 'application/json' },
    payload: '{ trasig',
  });

  expect(res.statusCode).toBe(400);
});

test('S7.4 okänt anbud ger 404', async () => {
  const res = await buyer.post(signUrl('00000000-0000-4000-8000-000000000000'));

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/bid-not-found');
});

test('S7.4 utan token ger 401', async () => {
  const { bidId } = await setup();

  const res = await ctx.app.inject({ method: 'POST', url: signUrl(bidId) });

  expect(res.statusCode).toBe(401);
});

test('S7.3 ett avslaget anbud går inte att signera', async () => {
  const requestId = await createRequest();
  const winning = await placeBid(seller, requestId);
  const losing = await placeBid(otherSeller, requestId, hourlyBid);

  await buyer.post(signUrl(winning));
  await seller.post(signUrl(winning));

  const res = await buyer.post(signUrl(losing));

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('status');
});
