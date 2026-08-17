import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
/** Samma värde som config har som grundvärde i drift — lågt nog att pröva på riktigt. */
const RESEND_LIMIT_PER_WINDOW = 5;

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp({ authRateLimitPerWindow: RESEND_LIMIT_PER_WINDOW });
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
}

/**
 * Anroparen skiljs åt på x-forwarded-for, vilket kräver att Fastify kör med trustProxy.
 * Varje test använder sin egen adress så att räknarna inte spiller över på varandra.
 */
const from = (ip: string, url: string, email = 'nagon@example.test') =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: { email },
    headers: { 'x-forwarded-for': ip },
  });

const RESEND = '/api/v1/auth/resend-verification';
const FORGOT = '/api/v1/auth/forgot-password';

test('K.1 anrop upp till gränsen släpps igenom', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    const res = await from('198.51.100.1', RESEND, `k1-${i}@example.test`);
    expect(res.statusCode).toBe(202);
  }
});

test('K.2 anropet över gränsen ger 429 med retry-after', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    await from('198.51.100.2', RESEND, `k2-${i}@example.test`);
  }

  const res = await from('198.51.100.2', RESEND, 'k2-over@example.test');

  expect(res.statusCode).toBe(429);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/too-many-requests');
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
});

test('K.3 gränsen är per anropare — en annan adress påverkas inte', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    await from('198.51.100.3', RESEND, `k3-${i}@example.test`);
  }
  expect((await from('198.51.100.3', RESEND)).statusCode).toBe(429);

  // Poängen med gränsen är att stoppa den som varierar adressen, inte alla andra.
  expect((await from('198.51.100.4', RESEND)).statusCode).toBe(202);
});

test('K.4 gränsen räknas per endpoint', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    await from('198.51.100.5', RESEND, `k4-${i}@example.test`);
  }
  expect((await from('198.51.100.5', RESEND)).statusCode).toBe(429);

  // Samma anropare, annan endpoint: en egen räknare.
  expect((await from('198.51.100.5', FORGOT)).statusCode).toBe(202);
});

test('K.4 forgot-password har samma gräns', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    const res = await from('198.51.100.6', FORGOT, `k4b-${i}@example.test`);
    expect(res.statusCode).toBe(202);
  }

  expect((await from('198.51.100.6', FORGOT)).statusCode).toBe(429);
});

test('K.5 gränsen rör inte andra endpoints', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    await from('198.51.100.7', RESEND, `k5-${i}@example.test`);
  }
  expect((await from('198.51.100.7', RESEND)).statusCode).toBe(429);

  // Inloggning är inte kvotad här: fel lösenord ska fortfarande ge 401, inte 429.
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'k5@example.test', password: 'ett-langt-losenord' },
    headers: { 'x-forwarded-for': '198.51.100.7' },
  });
  expect(login.statusCode).toBe(401);
});

test('K.5 en kvotad begäran skickar inget mail', async () => {
  for (let i = 0; i < RESEND_LIMIT_PER_WINDOW; i++) {
    await from('198.51.100.8', RESEND, `k5b-${i}@example.test`);
  }
  const before = ctx.mail.sent.length;

  expect((await from('198.51.100.8', RESEND)).statusCode).toBe(429);

  // Spärren sitter före hanteraren — annars vore den ingen spärr mot utskick.
  expect(ctx.mail.sent.length).toBe(before);
});
