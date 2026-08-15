import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
  errors?: { path: string; message: string }[];
}

interface RequestBody {
  id: string;
  buyerId: string;
  title: string;
  description: string;
  compensationPref: string;
  budget: { amountMinor: number; currency: string } | null;
  deadlineAt: string | null;
  status: string;
  createdAt: string;
}

const inFuture = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const validRequest = () => ({
  title: 'Bygg en integration mot Fortnox',
  description: 'Vi behöver synka fakturor en gång i timmen. Allt arbete sker på distans.',
  compensationPref: 'any',
  budget: { amountMinor: 4500000, currency: 'SEK' },
  deadlineAt: inFuture(14),
});

test('F5.1 giltig förfrågan ger 201 med status open och anroparen som köpare', async () => {
  const res = await buyer.post('/api/v1/requests', validRequest());

  expect(res.statusCode).toBe(201);
  const body = res.json<RequestBody>();
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.buyerId).toBe(buyer.id);
  expect(body.status).toBe('open');
  expect(body.title).toBe('Bygg en integration mot Fortnox');
  expect(body.compensationPref).toBe('any');

  // Beloppet ska komma tillbaka som number — Bun.SQL ger bigint som string (D.4).
  expect(body.budget).toEqual({ amountMinor: 4500000, currency: 'SEK' });
  expect(typeof body.budget!.amountMinor).toBe('number');

  // Och ligga rätt i databasen.
  const rows = (await ctx.sql`
    SELECT buyer_id, status, budget_minor FROM requests WHERE id = ${body.id}
  `) as { buyer_id: string; status: string; budget_minor: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.buyer_id).toBe(buyer.id);
  expect(rows[0]!.status).toBe('open');
});

test('F5.1 budget och deadline är valfria', async () => {
  const res = await buyer.post('/api/v1/requests', {
    title: 'Kort uppdrag utan budget',
    description: 'Ingen budget angiven, ingen deadline.',
    compensationPref: 'hourly',
  });

  expect(res.statusCode).toBe(201);
  const body = res.json<RequestBody>();
  expect(body.budget).toBeNull();
  expect(body.deadlineAt).toBeNull();
});

test('F5.2 utan token ger 401', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/requests',
    payload: validRequest(),
  });

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/unauthorized');
});

test('F5.3 deadline i dåtid ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    deadlineAt: new Date(Date.now() - 60_000).toISOString(),
  });

  expect(res.statusCode).toBe(422);
  const problem = res.json<Problem>();
  expect(problem.type).toBe('https://fastgig.dev/problems/validation-failed');
  expect(problem.errors?.map((e) => e.path)).toContain('deadlineAt');
});

test('F5.4 negativ budget ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    budget: { amountMinor: -100, currency: 'SEK' },
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('budget.amountMinor');
});

test('F5.4 nollbudget ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    budget: { amountMinor: 0, currency: 'SEK' },
  });

  expect(res.statusCode).toBe(422);
});

test('F5.4 ett belopp som sträng i kroppen typtvingas inte utan ger 422', async () => {
  // Query-parametrar typtvingas (?limit=2 → 2), men kroppar ska aldrig städas upp:
  // ett belopp som sträng är ett klientfel vi vill se. Se plugins/validation.ts.
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    budget: { amountMinor: '4500000', currency: 'SEK' },
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('budget.amountMinor');
});

test('F5.5 titel över maxlängd ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    title: 'x'.repeat(121),
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('title');
});

test('F5.5 tom titel ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', { ...validRequest(), title: '' });

  expect(res.statusCode).toBe(422);
});

test('F5.5 okänd compensationPref ger 422', async () => {
  const res = await buyer.post('/api/v1/requests', {
    ...validRequest(),
    compensationPref: 'barter',
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('compensationPref');
});
