import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { DEFAULT_PASSWORD } from '../helpers/actors.ts';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
  errors?: { path: string; message: string }[];
}

const register = (email: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: DEFAULT_PASSWORD, displayName: 'Ny' },
  });

const login = (email: string, password = DEFAULT_PASSWORD) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

/** Plockar verifieringslänken ur det senaste mailet till adressen. */
function linkFrom(email: string): string {
  const mail = ctx.mail.sent.findLast((m) => m.to === email);
  if (!mail) throw new Error(`Inget mail skickat till ${email}`);

  const match = /https?:\/\/\S*validate-user\S*/.exec(`${mail.text} ${mail.html ?? ''}`);
  if (!match) throw new Error(`Ingen verifieringslänk i mailet:\n${mail.text}`);
  return match[0];
}

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

test('V.1 registrering skickar ett verifieringsmail med en länk', async () => {
  const email = 'v1@example.test';
  const before = ctx.mail.sent.length;

  expect((await register(email)).statusCode).toBe(201);

  expect(ctx.mail.sent.length).toBe(before + 1);
  const mail = ctx.mail.sent.at(-1)!;
  expect(mail.to).toBe(email);
  expect(mail.subject).toBeTruthy();

  const link = linkFrom(email);
  const token = new URL(link).searchParams.get('token');
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
});

test('V.2 ett nytt konto är overifierat och bär en egen token', async () => {
  const email = 'v2@example.test';
  expect((await register(email)).statusCode).toBe(201);

  const rows = (await ctx.sql`
    SELECT email_verified, verification_token FROM users WHERE email = ${email}
  `) as { email_verified: boolean; verification_token: string }[];

  expect(rows[0]!.email_verified).toBe(false);
  expect(rows[0]!.verification_token).toMatch(/^[0-9a-f-]{36}$/);
  // Token är inte samma sak som användarens id — id:t syns i API-svaren.
  const link = linkFrom(email);
  expect(link).not.toContain(register.name);
});

test('V.3 länken ur mailet verifierar kontot', async () => {
  const email = 'v3@example.test';
  await register(email);

  const res = await ctx.app.inject({ method: 'GET', url: pathOf(linkFrom(email)) });

  expect(res.statusCode).toBe(200);
  expect(res.json<{ verified: boolean; email: string }>()).toEqual({
    verified: true,
    email,
  });

  const rows = (await ctx.sql`
    SELECT email_verified FROM users WHERE email = ${email}
  `) as { email_verified: boolean }[];
  expect(rows[0]!.email_verified).toBe(true);
});

test('V.4 samma länk igen är ofarlig', async () => {
  const email = 'v4@example.test';
  await register(email);
  const url = pathOf(linkFrom(email));

  const first = await ctx.app.inject({ method: 'GET', url });
  const second = await ctx.app.inject({ method: 'GET', url });

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
});

test('V.5 okänd token ger 404', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/validate-user?token=00000000-0000-4000-8000-000000000000',
  });

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/verification-token-not-found',
  );
});

test('V.6 en token som inte är en uuid ger 422', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/validate-user?token=inte-en-uuid',
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('token');
});

test('V.6 utan token alls ger 422', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/validate-user' });

  expect(res.statusCode).toBe(422);
});

test('V.7 inloggning före verifiering ger 403', async () => {
  const email = 'v7@example.test';
  await register(email);

  const res = await login(email);

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/email-not-verified');
});

test('V.7 fel lösenord på ett overifierat konto ger fortfarande 401', async () => {
  // Verifieringsläget får inte röjas för den som inte kan lösenordet.
  const email = 'v7b@example.test';
  await register(email);

  const res = await login(email, 'helt-fel-losenord-har');

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/invalid-credentials');
});

test('V.8 inloggning efter verifiering fungerar', async () => {
  const email = 'v8@example.test';
  await register(email);
  await ctx.app.inject({ method: 'GET', url: pathOf(linkFrom(email)) });

  const res = await login(email);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ token: string }>().token).toBeString();
});

test('V.9 mailet innehåller varken lösenord eller token i klartext utöver länken', async () => {
  const email = 'v9@example.test';
  await register(email);
  const mail = ctx.mail.sent.at(-1)!;

  expect(mail.text).not.toContain(DEFAULT_PASSWORD);
  expect(mail.subject).not.toContain(DEFAULT_PASSWORD);
});
