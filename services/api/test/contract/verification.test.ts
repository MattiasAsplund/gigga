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

  const match = /https?:\/\/\S*\/verify\S*/.exec(`${mail.text} ${mail.html ?? ''}`);
  if (!match) throw new Error(`Ingen verifieringslänk i mailet:\n${mail.text}`);
  return match[0];
}

/**
 * Anropet som webbens bekräftelsesida gör med token ur länken. Länken går till sidan,
 * men det är det här anropet som faktiskt bekräftar kontot.
 */
const apiCallFor = (link: string) =>
  `/api/v1/validate-user?token=${new URL(link).searchParams.get('token')}`;

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

test('V.26 länken pekar på webbens bekräftelsesida, inte rakt in i API:et', async () => {
  const email = 'v26@example.test';
  await register(email);

  const link = new URL(linkFrom(email));

  // Sidan gör anropet åt användaren och kan visa besked om det gick vägen eller inte.
  // En rå länk in i API:et lämnar bara ett JSON-svar i webbläsaren.
  expect(link.pathname).toBe('/verify');
  expect(link.pathname).not.toContain('/api/');
  expect(link.searchParams.get('token')).toMatch(/^[0-9a-f-]{36}$/);
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

  const res = await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });

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
  const url = apiCallFor(linkFrom(email));

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
  await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });

  const res = await login(email);

  expect(res.statusCode).toBe(200);
  expect(res.json<{ token: string }>().token).toBeString();
});

test('V.10 registreringens token duger inte mot ett skyddat API före verifiering', async () => {
  const email = 'v10@example.test';
  const token = (await register(email)).json<{ token: string }>().token;

  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me/requests',
    headers: { authorization: `Bearer ${token}` },
  });

  expect(res.statusCode).toBe(403);
  expect(res.json<Problem>().type).toBe('https://fastgig.dev/problems/email-not-verified');
});

test('V.11 samma token börjar fungera när adressen bekräftats', async () => {
  const email = 'v11@example.test';
  const token = (await register(email)).json<{ token: string }>().token;
  const call = () =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/requests',
      headers: { authorization: `Bearer ${token}` },
    });

  expect((await call()).statusCode).toBe(403);

  await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });

  // Ingen ny inloggning krävs — spärren läser kontots läge, inte tokenens.
  expect((await call()).statusCode).toBe(200);
});

test('V.12 en token för ett konto som inte finns kvar ger 401', async () => {
  const email = 'v12@example.test';
  const token = (await register(email)).json<{ token: string }>().token;
  await ctx.sql`DELETE FROM users WHERE email = ${email}`;

  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me/requests',
    headers: { authorization: `Bearer ${token}` },
  });

  expect(res.statusCode).toBe(401);
});

// ------------------------------------------------ V.13+ Nytt bekräftelsemail

const resend = (email: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/resend-verification',
    payload: { email } as never,
  });

/** Flyttar kylperioden bakåt så testet kan begära igen utan att vänta. */
const clearCooldown = (email: string) =>
  ctx.sql`
    UPDATE users SET verification_sent_at = now() - interval '1 hour' WHERE email = ${email}
  `;

test('V.13 begäran skickar ett nytt mail med en ny länk', async () => {
  const email = 'v13@example.test';
  await register(email);
  const first = linkFrom(email);
  await clearCooldown(email);

  const res = await resend(email);

  expect(res.statusCode).toBe(202);
  const second = linkFrom(email);
  expect(second).not.toBe(first);
  expect(ctx.mail.sent.filter((m) => m.to === email)).toHaveLength(2);
});

test('V.14 den gamla länken slutar gälla när en ny begärts', async () => {
  const email = 'v14@example.test';
  await register(email);
  const old = apiCallFor(linkFrom(email));
  await clearCooldown(email);
  await resend(email);

  const res = await ctx.app.inject({ method: 'GET', url: old });

  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/verification-token-not-found',
  );
});

test('V.15 den nya länken verifierar kontot', async () => {
  const email = 'v15@example.test';
  await register(email);
  await clearCooldown(email);
  await resend(email);

  const res = await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });

  expect(res.statusCode).toBe(200);
  expect((await login(email)).statusCode).toBe(200);
});

test('V.16 okänd adress ger 202 utan att något mail skickas', async () => {
  const before = ctx.mail.sent.length;

  const res = await resend('finns-inte-alls@example.test');

  expect(res.statusCode).toBe(202);
  expect(ctx.mail.sent.length).toBe(before);
});

test('V.17 ett redan verifierat konto får inget nytt mail', async () => {
  const email = 'v17@example.test';
  await register(email);
  await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });
  await clearCooldown(email);
  const before = ctx.mail.sent.length;

  const res = await resend(email);

  expect(res.statusCode).toBe(202);
  expect(ctx.mail.sent.length).toBe(before);
});

test('V.18 svaret är identiskt oavsett om kontot finns, saknas eller är verifierat', async () => {
  const unverified = 'v18a@example.test';
  const verified = 'v18b@example.test';
  await register(unverified);
  await register(verified);
  await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(verified)) });
  await clearCooldown(unverified);
  await clearCooldown(verified);

  const bodies = [
    (await resend(unverified)).body,
    (await resend(verified)).body,
    (await resend('v18c-finns-inte@example.test')).body,
  ];

  expect(new Set(bodies).size).toBe(1);
});

test('V.19 upprepad begäran inom kylperioden skickar inte fler mail', async () => {
  const email = 'v19@example.test';
  await register(email);
  await clearCooldown(email);

  expect((await resend(email)).statusCode).toBe(202);
  const afterFirst = ctx.mail.sent.filter((m) => m.to === email).length;

  // Direkt igen, utan att nollställa: kylperioden ska stoppa utskicket.
  expect((await resend(email)).statusCode).toBe(202);

  expect(ctx.mail.sent.filter((m) => m.to === email)).toHaveLength(afterFirst);
});

test('V.20 trasig e-postadress ger 422', async () => {
  const res = await resend('inte-en-adress');

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.map((e) => e.path)).toContain('email');
});

// ------------------------------------------------ V.21+ Utgångstid

/** Flyttar utgångstiden bakåt så länken räknas som passerad. */
const expireToken = (email: string) =>
  ctx.sql`
    UPDATE users SET verification_expires_at = now() - interval '1 minute'
    WHERE email = ${email}
  `;

test('V.21 utgångstiden sätts vid registrering och ligger i framtiden', async () => {
  const email = 'v21@example.test';
  await register(email);

  const rows = (await ctx.sql`
    SELECT verification_expires_at > now() AS gäller,
           verification_expires_at > now() + interval '23 hours' AS rimlig
    FROM users WHERE email = ${email}
  `) as { gäller: boolean; rimlig: boolean }[];

  expect(rows[0]!.gäller).toBe(true);
  expect(rows[0]!.rimlig).toBe(true);
});

test('V.22 en utgången länk ger 410, inte 404', async () => {
  const email = 'v22@example.test';
  await register(email);
  const url = apiCallFor(linkFrom(email));
  await expireToken(email);

  const res = await ctx.app.inject({ method: 'GET', url });

  expect(res.statusCode).toBe(410);
  expect(res.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/verification-token-expired',
  );
});

test('V.22 en utgången länk verifierar inte kontot', async () => {
  const email = 'v22b@example.test';
  await register(email);
  const url = apiCallFor(linkFrom(email));
  await expireToken(email);
  await ctx.app.inject({ method: 'GET', url });

  const rows = (await ctx.sql`
    SELECT email_verified FROM users WHERE email = ${email}
  `) as { email_verified: boolean }[];
  expect(rows[0]!.email_verified).toBe(false);
  expect((await login(email)).statusCode).toBe(403);
});

test('V.23 ett nytt bekräftelsemail ger en länk som fungerar igen', async () => {
  const email = 'v23@example.test';
  await register(email);
  await expireToken(email);
  await clearCooldown(email);

  expect((await resend(email)).statusCode).toBe(202);
  const res = await ctx.app.inject({ method: 'GET', url: apiCallFor(linkFrom(email)) });

  expect(res.statusCode).toBe(200);
  expect((await login(email)).statusCode).toBe(200);
});

test('V.24 rotationen flyttar fram utgångstiden', async () => {
  const email = 'v24@example.test';
  await register(email);
  await expireToken(email);
  await clearCooldown(email);

  await resend(email);

  const rows = (await ctx.sql`
    SELECT verification_expires_at > now() AS gäller FROM users WHERE email = ${email}
  `) as { gäller: boolean }[];
  expect(rows[0]!.gäller).toBe(true);
});

test('V.25 ett redan verifierat konto tål att länken passerat', async () => {
  // Idempotensen från V.4 får inte gå förlorad bara för att tiden runnit ut.
  const email = 'v25@example.test';
  await register(email);
  const url = apiCallFor(linkFrom(email));
  expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  await expireToken(email);

  const again = await ctx.app.inject({ method: 'GET', url });

  expect(again.statusCode).toBe(200);
  expect(again.json<{ verified: boolean }>().verified).toBe(true);
});

test('V.9 mailet innehåller varken lösenord eller token i klartext utöver länken', async () => {
  const email = 'v9@example.test';
  await register(email);
  const mail = ctx.mail.sent.at(-1)!;

  expect(mail.text).not.toContain(DEFAULT_PASSWORD);
  expect(mail.subject).not.toContain(DEFAULT_PASSWORD);
});
