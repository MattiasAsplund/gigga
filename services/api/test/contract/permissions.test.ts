import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;
let colleague: Actor;
let outsider: Actor;
let seller: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  colleague = await actor(ctx.app, 'kollega');
  outsider = await actor(ctx.app, 'utomstaende');
  seller = await actor(ctx.app, 'saljare');
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
}

interface Permission {
  requestId: string;
  userId: string;
  email: string;
  displayName: string;
  level: string;
  grantedAt: string;
}

async function createRequest(title = 'Förfrågan att dela'): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
    title,
    description: 'Distansuppdrag.',
    compensationPref: 'any',
  });
  if (res.statusCode !== 201) throw new Error(`skapa förfrågan: ${res.body}`);
  return res.json<{ id: string }>().id;
}

const grant = (as: Actor, requestId: string, email: unknown) =>
  as.post(`/api/v1/requests/${requestId}/permissions`, { email });

const list = (as: Actor, requestId: string) =>
  as.get(`/api/v1/requests/${requestId}/permissions`);

const revoke = (as: Actor, requestId: string, userId: string) =>
  as.del(`/api/v1/requests/${requestId}/permissions/${userId}`);

const readRequest = (as: Actor, requestId: string) =>
  as.get(`/api/v1/requests/${requestId}`);

test('P.1 köparen kan ge en kollega läsrätt', async () => {
  const requestId = await createRequest();

  const res = await grant(buyer, requestId, colleague.email);

  expect(res.statusCode).toBe(201);
  const body = res.json<Permission>();
  expect(body.requestId).toBe(requestId);
  expect(body.userId).toBe(colleague.id);
  expect(body.email).toBe(colleague.email);
  expect(body.level).toBe('read');
});

test('P.2 dubbel tilldelning är idempotent', async () => {
  const requestId = await createRequest();
  const first = await grant(buyer, requestId, colleague.email);
  expect(first.statusCode).toBe(201);

  const second = await grant(buyer, requestId, colleague.email);

  expect(second.statusCode).toBe(200);
  expect(second.json<Permission>().grantedAt).toBe(first.json<Permission>().grantedAt);
});

test('P.3 okänd e-postadress ger 404', async () => {
  const requestId = await createRequest();

  const res = await grant(buyer, requestId, 'finns-inte@example.test');

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/user-not-found');
});

test('P.4 köparen kan inte tilldela sig själv', async () => {
  const requestId = await createRequest();

  const res = await grant(buyer, requestId, buyer.email);

  expect(res.statusCode).toBe(422);
});

test('P.5 bara ägaren får tilldela', async () => {
  const requestId = await createRequest();

  const res = await grant(outsider, requestId, colleague.email);

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/not-request-owner');
});

test('P.5 en behörig får inte dela vidare', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  const res = await grant(colleague, requestId, outsider.email);

  expect(res.statusCode).toBe(403);
});

test('P.6 okänd förfrågan ger 404', async () => {
  const res = await grant(buyer, '00000000-0000-4000-8000-000000000000', colleague.email);

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/request-not-found');
});

test('P.7 ägaren ser sina tilldelade rättigheter', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  const res = await list(buyer, requestId);

  expect(res.statusCode).toBe(200);
  const items = res.json<{ items: Permission[] }>().items;
  expect(items).toHaveLength(1);
  expect(items[0]!.email).toBe(colleague.email);
});

test('P.7 andra får inte se listan', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  expect((await list(colleague, requestId)).statusCode).toBe(403);
  expect((await list(outsider, requestId)).statusCode).toBe(403);
});

test('P.8 rättigheten går att ta tillbaka', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  const res = await revoke(buyer, requestId, colleague.id);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ revoked: boolean }>().revoked).toBe(true);
  expect((await list(buyer, requestId)).json<{ items: Permission[] }>().items).toHaveLength(0);
});

test('P.8 återkallande av något som inte finns ger 404', async () => {
  const requestId = await createRequest();

  const res = await revoke(buyer, requestId, colleague.id);

  expect(res.statusCode).toBe(404);
});

test('P.8 bara ägaren får återkalla', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  expect((await revoke(colleague, requestId, colleague.id)).statusCode).toBe(403);
});

// ------------------------------------------------ Vad läsrätten öppnar

test('P.9 ägaren kan läsa sin förfrågan med anbud', async () => {
  const requestId = await createRequest();
  await seller.post(`/api/v1/requests/${requestId}/bids`, {
    plan: 'Min plan.',
    compensation: { type: 'fixed', amountMinor: 100000, currency: 'SEK' },
  });

  const res = await readRequest(buyer, requestId);

  expect(res.statusCode).toBe(200);
  const body = res.json<{ id: string; bids: { plan: string }[] }>();
  expect(body.id).toBe(requestId);
  expect(body.bids).toHaveLength(1);
  expect(body.bids[0]!.plan).toBe('Min plan.');
});

test('P.10 en behörig kan läsa förfrågan och dess anbud', async () => {
  const requestId = await createRequest();
  await seller.post(`/api/v1/requests/${requestId}/bids`, {
    plan: 'Synlig för behörig.',
    compensation: { type: 'fixed', amountMinor: 100000, currency: 'SEK' },
  });
  await grant(buyer, requestId, colleague.email);

  const res = await readRequest(colleague, requestId);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ bids: { plan: string }[] }>().bids[0]!.plan).toBe('Synlig för behörig.');
});

test('P.11 utan rättighet går förfrågan inte att läsa', async () => {
  const requestId = await createRequest();

  const res = await readRequest(outsider, requestId);

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/no-request-access');
});

test('P.12 återkallad rättighet stänger läsningen omedelbart', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);
  expect((await readRequest(colleague, requestId)).statusCode).toBe(200);

  await revoke(buyer, requestId, colleague.id);

  expect((await readRequest(colleague, requestId)).statusCode).toBe(403);
});

test('P.13 läsrätt påverkar inte rätten att lägga anbud', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  const res = await colleague.post(`/api/v1/requests/${requestId}/bids`, {
    plan: 'Försöker ändå.',
    compensation: { type: 'fixed', amountMinor: 100000, currency: 'SEK' },
  });

  // Behörigheten gäller läsning och ger varken extra rättigheter eller hinder:
  // anbud styrs av sina egna regler (F6), och kollegan är inte köpare.
  expect(res.statusCode).toBe(201);
});

test('P.14 rättigheter försvinner med förfrågan', async () => {
  const requestId = await createRequest();
  await grant(buyer, requestId, colleague.email);

  await ctx.sql`DELETE FROM requests WHERE id = ${requestId}`;

  const rows = (await ctx.sql`
    SELECT count(*)::int AS n FROM request_permissions WHERE request_id = ${requestId}
  `) as { n: number }[];
  expect(rows[0]!.n).toBe(0);
});
