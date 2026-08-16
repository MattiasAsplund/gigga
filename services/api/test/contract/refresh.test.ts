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
}

interface Session {
  token: string;
  refreshToken: string;
  refreshExpiresIn: number;
}

async function account(email: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: DEFAULT_PASSWORD, displayName: 'Konto' },
  });
  if (res.statusCode !== 201) throw new Error(`register: ${res.body}`);

  const rows = (await ctx.sql`
    SELECT verification_token FROM users WHERE email = ${email}
  `) as { verification_token: string }[];
  await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/validate-user?token=${rows[0]!.verification_token}`,
  });
}

async function login(email: string, password = DEFAULT_PASSWORD): Promise<Session> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login: ${res.statusCode} ${res.body}`);
  return res.json<Session>();
}

const refresh = (refreshToken: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refreshToken } as never,
  });

const callProtected = (token: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me/requests',
    headers: { authorization: `Bearer ${token}` },
  });

const logout = (token: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { authorization: `Bearer ${token}` },
  });

test('T.1 inloggning returnerar en refresh-token med egen livslängd', async () => {
  const email = 't1@example.test';
  await account(email);

  const session = await login(email);

  expect(session.refreshToken).toBeString();
  expect(session.refreshToken.length).toBeGreaterThan(32);
  // Betydligt längre än access-tokenens timme.
  expect(session.refreshExpiresIn).toBeGreaterThan(60 * 60 * 24);
});

test('T.2 registrering returnerar också en refresh-token', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 't2@example.test', password: DEFAULT_PASSWORD, displayName: 'Ny' },
  });

  expect(res.statusCode).toBe(201);
  expect(res.json<Session>().refreshToken).toBeString();
});

test('T.3 refresh ger en ny access-token som fungerar', async () => {
  const email = 't3@example.test';
  await account(email);
  const first = await login(email);

  const res = await refresh(first.refreshToken);

  expect(res.statusCode).toBe(200);
  const next = res.json<Session>();
  expect(next.token).not.toBe(first.token);
  expect((await callProtected(next.token)).statusCode).toBe(200);
});

test('T.3 refresh kräver ingen access-token — det är hela poängen', async () => {
  const email = 't3b@example.test';
  await account(email);
  const session = await login(email);

  // Ingen Authorization-header alls.
  const res = await refresh(session.refreshToken);

  expect(res.statusCode).toBe(200);
});

test('T.4 refresh roterar: den förbrukade token slutar gälla', async () => {
  const email = 't4@example.test';
  await account(email);
  const first = await login(email);

  const second = (await refresh(first.refreshToken)).json<Session>();

  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect((await refresh(second.refreshToken)).statusCode).toBe(200);
});

test('T.5 återanvänd token dödar hela sessionen', async () => {
  const email = 't5@example.test';
  await account(email);
  const first = await login(email);
  const second = (await refresh(first.refreshToken)).json<Session>();
  const third = (await refresh(second.refreshToken)).json<Session>();

  // Någon använder en token som redan roterats bort — den läckte.
  const reused = await refresh(first.refreshToken);

  expect(reused.statusCode).toBe(401);
  expect(reused.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/refresh-token-reused',
  );
  // Hela kedjan ska vara död, inklusive den senaste giltiga.
  expect((await refresh(third.refreshToken)).statusCode).toBe(401);
});

test('T.6 okänd refresh-token ger 401', async () => {
  const res = await refresh('en-token-som-aldrig-funnits-men-ar-lagom-lang-abcdefgh');

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/refresh-token-invalid');
});

test('T.6 tom refresh-token ger 422', async () => {
  expect((await refresh('')).statusCode).toBe(422);
});

test('T.7 utgången refresh-token ger 401', async () => {
  const email = 't7@example.test';
  await account(email);
  const session = await login(email);
  await ctx.sql`UPDATE refresh_tokens SET expires_at = now() - interval '1 day'`;

  const res = await refresh(session.refreshToken);

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/refresh-token-invalid');
});

test('T.8 utloggning gör att man inte kan refresha sig tillbaka in', async () => {
  const email = 't8@example.test';
  await account(email);
  const session = await login(email);

  expect((await logout(session.token)).statusCode).toBe(200);

  const res = await refresh(session.refreshToken);
  expect(res.statusCode).toBe(401);
  // Och inte "reused": den som loggat ut ska inte få beskedet att token läckt.
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/refresh-token-invalid');
  expect((await callProtected(session.token)).statusCode).toBe(401);
});

test('T.8 en oanvänd token från en avslutad session anklagas inte heller', async () => {
  const email = 't8b@example.test';
  await account(email);
  const session = await login(email);
  const rotated = (await refresh(session.refreshToken)).json<Session>();
  await logout(rotated.token);

  // Den senaste token var aldrig använd, bara återkallad av utloggningen.
  const res = await refresh(rotated.refreshToken);

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/refresh-token-invalid');
});

test('T.9 utloggning berör bara sin egen session', async () => {
  const email = 't9@example.test';
  await account(email);
  const phone = await login(email);
  const laptop = await login(email);

  await logout(phone.token);

  expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
  expect((await refresh(laptop.refreshToken)).statusCode).toBe(200);
});

test('T.10 lösenordsbyte dödar alla refresh-tokens utan att anklaga någon', async () => {
  const email = 't10@example.test';
  await account(email);
  const phone = await login(email);
  const laptop = await login(email);

  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email },
  });
  const mail = ctx.mail.sent.findLast((m) => m.to === email)!;
  const code = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
    mail.text,
  )![0];
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    payload: { token: code, password: 'ett-helt-nytt-losenord' },
  });

  const phoneRes = await refresh(phone.refreshToken);
  expect(phoneRes.statusCode).toBe(401);
  expect(phoneRes.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/refresh-token-invalid',
  );
  expect((await refresh(laptop.refreshToken)).statusCode).toBe(401);
});

test('T.11 refresh-token lagras aldrig i klartext', async () => {
  const email = 't11@example.test';
  await account(email);
  const session = await login(email);

  const rows = (await ctx.sql`
    SELECT token_hash FROM refresh_tokens
  `) as { token_hash: string }[];

  for (const row of rows) expect(row.token_hash).not.toBe(session.refreshToken);
  expect(rows.some((r) => r.token_hash.includes(session.refreshToken))).toBe(false);
});

test('T.12 en refresh-token från ett annat konto duger inte till mitt', async () => {
  const mine = 't12a@example.test';
  const theirs = 't12b@example.test';
  await account(mine);
  await account(theirs);
  const theirSession = await login(theirs);

  const res = await refresh(theirSession.refreshToken);

  // Den fungerar — men för sitt eget konto, inte mitt.
  expect(res.statusCode).toBe(200);
  const token = res.json<Session>().token;
  const me = await callProtected(token);
  expect(me.statusCode).toBe(200);

  const rows = (await ctx.sql`SELECT id FROM users WHERE email = ${theirs}`) as {
    id: string;
  }[];
  const decoded = ctx.app.jwt.decode<{ sub: string }>(token);
  expect(decoded?.sub).toBe(rows[0]!.id);
});
