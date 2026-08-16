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

const NEW_PASSWORD = 'ett-helt-nytt-losenord';

/** Registrerar och bekräftar ett konto, så inloggning bara hänger på lösenordet. */
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

const forgot = (email: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email } as never,
  });

const reset = (token: unknown, password: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    payload: { token, password } as never,
  });

const login = (email: string, password: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

/** Plockar återställningstoken ur det senaste mailet till adressen. */
function tokenFrom(email: string): string {
  const mail = ctx.mail.sent.findLast((m) => m.to === email);
  if (!mail) throw new Error(`Inget mail till ${email}`);

  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(mail.text);
  if (!match) throw new Error(`Ingen token i mailet:\n${mail.text}`);
  return match[0];
}

const clearCooldown = (email: string) =>
  ctx.sql`
    UPDATE users SET password_reset_sent_at = now() - interval '1 hour' WHERE email = ${email}
  `;

const expireToken = (email: string) =>
  ctx.sql`
    UPDATE users SET password_reset_expires_at = now() - interval '1 minute'
    WHERE email = ${email}
  `;

test('R.1 begäran skickar ett mail med en återställningstoken', async () => {
  const email = 'r1@example.test';
  await account(email);
  const before = ctx.mail.sent.length;

  const res = await forgot(email);

  expect(res.statusCode).toBe(202);
  expect(ctx.mail.sent.length).toBe(before + 1);
  const mail = ctx.mail.sent.at(-1)!;
  expect(mail.to).toBe(email);
  expect(tokenFrom(email)).toMatch(/^[0-9a-f-]{36}$/);
  // Återställningsmailet får inte innehålla det gamla lösenordet.
  expect(mail.text).not.toContain(DEFAULT_PASSWORD);
});

test('R.2 okänd adress ger 202 utan att något mail skickas', async () => {
  const before = ctx.mail.sent.length;

  const res = await forgot('r2-finns-inte@example.test');

  expect(res.statusCode).toBe(202);
  expect(ctx.mail.sent.length).toBe(before);
});

test('R.3 svaret är identiskt för känd och okänd adress', async () => {
  const email = 'r3@example.test';
  await account(email);

  const known = await forgot(email);
  const unknown = await forgot('r3-finns-inte@example.test');

  expect(known.body).toBe(unknown.body);
  expect(known.statusCode).toBe(unknown.statusCode);
});

test('R.4 upprepad begäran inom kylperioden skickar inte fler mail', async () => {
  const email = 'r4@example.test';
  await account(email);

  expect((await forgot(email)).statusCode).toBe(202);
  const afterFirst = ctx.mail.sent.filter((m) => m.to === email).length;

  expect((await forgot(email)).statusCode).toBe(202);

  expect(ctx.mail.sent.filter((m) => m.to === email)).toHaveLength(afterFirst);
});

test('R.5 token ur mailet sätter ett nytt lösenord', async () => {
  const email = 'r5@example.test';
  await account(email);
  await forgot(email);

  const res = await reset(tokenFrom(email), NEW_PASSWORD);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ reset: boolean }>().reset).toBe(true);
  expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
});

test('R.6 det gamla lösenordet slutar fungera', async () => {
  const email = 'r6@example.test';
  await account(email);
  await forgot(email);
  await reset(tokenFrom(email), NEW_PASSWORD);

  const res = await login(email, DEFAULT_PASSWORD);

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/invalid-credentials');
});

test('R.7 token går bara att använda en gång', async () => {
  const email = 'r7@example.test';
  await account(email);
  await forgot(email);
  const token = tokenFrom(email);

  expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
  const second = await reset(token, 'ytterligare-ett-losenord');

  expect(second.statusCode).toBe(404);
  expect(second.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/reset-token-not-found',
  );
  // Och lösenordet från det första anropet gäller fortfarande.
  expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
});

test('R.8 en utgången token ger 410', async () => {
  const email = 'r8@example.test';
  await account(email);
  await forgot(email);
  const token = tokenFrom(email);
  await expireToken(email);

  const res = await reset(token, NEW_PASSWORD);

  expect(res.statusCode).toBe(410);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/reset-token-expired');
  expect((await login(email, DEFAULT_PASSWORD)).statusCode).toBe(200);
});

test('R.9 okänd token ger 404', async () => {
  const res = await reset('00000000-0000-4000-8000-000000000000', NEW_PASSWORD);

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/reset-token-not-found');
});

test('R.10 för kort nytt lösenord ger 422', async () => {
  const email = 'r10@example.test';
  await account(email);
  await forgot(email);

  const res = await reset(tokenFrom(email), 'kort');

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('password');
  // Och token brändes inte av det misslyckade försöket.
  expect((await reset(tokenFrom(email), NEW_PASSWORD)).statusCode).toBe(200);
});

test('R.11 en ny begäran ogiltigförklarar den förra token', async () => {
  const email = 'r11@example.test';
  await account(email);
  await forgot(email);
  const first = tokenFrom(email);
  await clearCooldown(email);
  await forgot(email);
  const second = tokenFrom(email);

  expect(second).not.toBe(first);
  expect((await reset(first, NEW_PASSWORD)).statusCode).toBe(404);
  expect((await reset(second, NEW_PASSWORD)).statusCode).toBe(200);
});

test('R.12 trasig e-postadress ger 422', async () => {
  const res = await forgot('inte-en-adress');

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('email');
});

test('R.13 en token som inte är uuid ger 422', async () => {
  const res = await reset('inte-en-uuid', NEW_PASSWORD);

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('token');
});

/** Loggar in och returnerar en färsk access-token. */
async function tokenFor(email: string, password: string): Promise<string> {
  const res = await login(email, password);
  if (res.statusCode !== 200) throw new Error(`login: ${res.statusCode} ${res.body}`);
  return res.json<{ token: string }>().token;
}

const callProtected = (token: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me/requests',
    headers: { authorization: `Bearer ${token}` },
  });

test('R.15 en token utfärdad före återställningen slutar gälla', async () => {
  const email = 'r15@example.test';
  await account(email);
  const oldToken = await tokenFor(email, DEFAULT_PASSWORD);
  expect((await callProtected(oldToken)).statusCode).toBe(200);

  await forgot(email);
  await reset(tokenFrom(email), NEW_PASSWORD);

  const res = await callProtected(oldToken);
  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/token-revoked');
});

test('R.16 en token utfärdad efter återställningen fungerar', async () => {
  const email = 'r16@example.test';
  await account(email);
  await forgot(email);
  await reset(tokenFrom(email), NEW_PASSWORD);

  const fresh = await tokenFor(email, NEW_PASSWORD);

  expect((await callProtected(fresh)).statusCode).toBe(200);
});

test('R.17 andra användares tokens påverkas inte', async () => {
  const mine = 'r17a@example.test';
  const theirs = 'r17b@example.test';
  await account(mine);
  await account(theirs);
  const otherToken = await tokenFor(theirs, DEFAULT_PASSWORD);

  await forgot(mine);
  await reset(tokenFrom(mine), NEW_PASSWORD);

  expect((await callProtected(otherToken)).statusCode).toBe(200);
});

test('R.18 en token utan versionsanspråk avvisas', async () => {
  const email = 'r18@example.test';
  await account(email);
  const rows = (await ctx.sql`SELECT id FROM users WHERE email = ${email}`) as {
    id: string;
  }[];

  // Signerad med rätt nyckel, men utan `ver` — som en token från före den här ändringen.
  const legacy = ctx.app.jwt.sign({ sub: rows[0]!.id } as never);

  expect((await callProtected(legacy)).statusCode).toBe(401);
});

test('R.19 varje återställning ogiltigförklarar den föregående sessionen', async () => {
  const email = 'r19@example.test';
  await account(email);

  await forgot(email);
  await reset(tokenFrom(email), NEW_PASSWORD);
  const afterFirst = await tokenFor(email, NEW_PASSWORD);
  expect((await callProtected(afterFirst)).statusCode).toBe(200);

  await clearCooldown(email);
  await forgot(email);
  await reset(tokenFrom(email), 'ett-tredje-losenord-har');

  expect((await callProtected(afterFirst)).statusCode).toBe(401);
});

test('R.14 återställning bekräftar inte adressen', async () => {
  // Att kunna läsa mailen bevisar kontroll över brevlådan, men de två flödena hålls
  // isär: den som glömt lösenordet före bekräftelsen får bekräfta separat.
  const email = 'r14@example.test';
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: DEFAULT_PASSWORD, displayName: 'Obekräftad' },
  });
  expect(res.statusCode).toBe(201);

  await forgot(email);
  expect((await reset(tokenFrom(email), NEW_PASSWORD)).statusCode).toBe(200);

  const login403 = await login(email, NEW_PASSWORD);
  expect(login403.statusCode).toBe(403);
  expect(login403.json<Problem>().type).toBe('https://fastgig.dev/problems/email-not-verified');
});
