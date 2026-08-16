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

/** Registrerar och bekräftar ett konto. */
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

/** En färsk session. Två anrop ger två olika tokens för samma konto. */
async function session(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: DEFAULT_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login: ${res.body}`);
  return res.json<{ token: string }>().token;
}

const logout = (token?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

const callProtected = (token: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me/requests',
    headers: { authorization: `Bearer ${token}` },
  });

test('U.1 utloggning gör token oanvändbar', async () => {
  const email = 'u1@example.test';
  await account(email);
  const token = await session(email);
  expect((await callProtected(token)).statusCode).toBe(200);

  const res = await logout(token);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ loggedOut: boolean }>().loggedOut).toBe(true);

  const after = await callProtected(token);
  expect(after.statusCode).toBe(401);
  expect(after.json<Problem>().type).toBe('https://fastgig.dev/problems/session-ended');
});

test('U.2 utloggning utan token ger 401', async () => {
  expect((await logout()).statusCode).toBe(401);
});

test('U.3 samma token loggar inte ut två gånger', async () => {
  const email = 'u3@example.test';
  await account(email);
  const token = await session(email);
  expect((await logout(token)).statusCode).toBe(200);

  const second = await logout(token);

  expect(second.statusCode).toBe(401);
  expect(second.json<Problem>().type).toBe('https://fastgig.dev/problems/session-ended');
});

test('U.4 andra sessioner för samma användare påverkas inte', async () => {
  const email = 'u4@example.test';
  await account(email);
  const phone = await session(email);
  const laptop = await session(email);
  expect(phone).not.toBe(laptop);

  expect((await logout(phone)).statusCode).toBe(200);

  expect((await callProtected(phone)).statusCode).toBe(401);
  expect((await callProtected(laptop)).statusCode).toBe(200);
});

test('U.5 andra användare påverkas inte', async () => {
  const mine = 'u5a@example.test';
  const theirs = 'u5b@example.test';
  await account(mine);
  await account(theirs);
  const myToken = await session(mine);
  const theirToken = await session(theirs);

  await logout(myToken);

  expect((await callProtected(theirToken)).statusCode).toBe(200);
});

test('U.6 ny inloggning efter utloggning fungerar', async () => {
  const email = 'u6@example.test';
  await account(email);
  await logout(await session(email));

  const fresh = await session(email);

  expect((await callProtected(fresh)).statusCode).toBe(200);
});

test('U.7 utloggning städar bort utgångna rader', async () => {
  const email = 'u7@example.test';
  await account(email);
  const rows = (await ctx.sql`SELECT id FROM users WHERE email = ${email}`) as {
    id: string;
  }[];

  // En rad som redan passerat sin utgångstid — token kan ändå inte användas längre.
  const stale = '11111111-1111-4111-8111-111111111111';
  await ctx.sql`
    INSERT INTO revoked_tokens (jti, user_id, expires_at)
    VALUES (${stale}, ${rows[0]!.id}, now() - interval '1 hour')
  `;

  await logout(await session(email));

  const left = (await ctx.sql`
    SELECT count(*)::int AS n FROM revoked_tokens WHERE jti = ${stale}
  `) as { n: number }[];
  expect(left[0]!.n).toBe(0);
});

test('U.8 lösenordsbyte och utloggning krockar inte', async () => {
  const email = 'u8@example.test';
  await account(email);
  const token = await session(email);
  await logout(token);

  // Token är redan utloggad; ett lösenordsbyte höjer dessutom tokenversionen.
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

  // Ett av skälen räcker; svaret ska vara 401 oavsett vilket som råkar avgöra.
  expect((await callProtected(token)).statusCode).toBe(401);
});
