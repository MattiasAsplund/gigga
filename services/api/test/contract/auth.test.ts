import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, DEFAULT_PASSWORD } from '../helpers/actors.ts';

let ctx: TestApp;

beforeAll(async () => {
  // En skyddad route som bara finns i testerna: requireAuth ska kunna prövas utan att
  // API-ytan växer utanför §6 i planen.
  ctx = await buildTestApp({
    extraRoutes: async (app) => {
      app.get('/__protected', { onRequest: app.requireAuth }, async (req) => ({
        userId: req.user.sub,
      }));
    },
  });
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

interface RegisterBody {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

const register = (payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: payload as never });

const login = (payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: payload as never });

/** Bekräftar adressen via den riktiga länken — inloggning kräver det sedan V-gruppen. */
async function verify(email: string): Promise<void> {
  const rows = (await ctx.sql`
    SELECT verification_token FROM users WHERE email = ${email}
  `) as { verification_token: string }[];
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/validate-user?token=${rows[0]!.verification_token}`,
  });
  if (res.statusCode !== 200) throw new Error(`verifiering misslyckades: ${res.body}`);
}

// ---------------------------------------------------------------- A1 Registrering

test('A1.1 giltig registrering ger 201 och läcker inte lösenordet', async () => {
  const res = await register({
    email: 'A1.1@Example.test',
    password: DEFAULT_PASSWORD,
    displayName: 'Alva',
  });

  expect(res.statusCode).toBe(201);
  const body = res.json<RegisterBody>();
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.email).toBe('a1.1@example.test'); // normaliserad
  expect(body.displayName).toBe('Alva');
  expect(body.token).toBeString();

  // Varken lösenordet eller en hash av det får finnas i svaret.
  expect(res.body).not.toContain(DEFAULT_PASSWORD);
  expect(res.body).not.toContain('password');

  // Token duger inte förrän adressen är bekräftad — se V.10 och V.11.
  const beforeVerification = await ctx.app.inject({
    method: 'GET',
    url: '/__protected',
    headers: { authorization: `Bearer ${body.token}` },
  });
  expect(beforeVerification.statusCode).toBe(403);

  await verify('a1.1@example.test');

  const afterVerification = await ctx.app.inject({
    method: 'GET',
    url: '/__protected',
    headers: { authorization: `Bearer ${body.token}` },
  });
  expect(afterVerification.statusCode).toBe(200);
  expect(afterVerification.json<{ userId: string }>().userId).toBe(body.id);
});

test('A1.2 dubblett-e-post ger 409, även med annan skiftlägesform', async () => {
  const first = await register({
    email: 'a1.2@example.test',
    password: DEFAULT_PASSWORD,
    displayName: 'Först',
  });
  expect(first.statusCode).toBe(201);

  const second = await register({
    email: 'A1.2@EXAMPLE.TEST',
    password: DEFAULT_PASSWORD,
    displayName: 'Sedan',
  });

  expect(second.statusCode).toBe(409);
  const problem = second.json<Problem>();
  expect(problem.status).toBe(409);
  expect(problem.type).toBe('https://fastgig.dev/problems/email-taken');
});

test('A1.3 lösenord under 12 tecken ger 422 med fältpekare', async () => {
  const res = await register({
    email: 'a1.3@example.test',
    password: 'kort',
    displayName: 'Kort',
  });

  expect(res.statusCode).toBe(422);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const problem = res.json<Problem>();
  expect(problem.type).toBe('https://fastgig.dev/problems/validation-failed');
  expect(problem.errors?.map((e) => e.path)).toContain('password');
});

test('A1.4 trasig e-postadress ger 422', async () => {
  const res = await register({
    email: 'inte-en-adress',
    password: DEFAULT_PASSWORD,
    displayName: 'Trasig',
  });

  expect(res.statusCode).toBe(422);
  const problem = res.json<Problem>();
  expect(problem.errors?.map((e) => e.path)).toContain('email');
});

test('A1.5 lösenordet lagras aldrig i klartext', async () => {
  const res = await register({
    email: 'a1.5@example.test',
    password: DEFAULT_PASSWORD,
    displayName: 'Hemlig',
  });
  expect(res.statusCode).toBe(201);

  const rows = (await ctx.sql`
    SELECT password_hash FROM users WHERE email = 'a1.5@example.test'
  `) as { password_hash: string }[];

  expect(rows).toHaveLength(1);
  expect(rows[0]!.password_hash).not.toContain(DEFAULT_PASSWORD);
  expect(rows[0]!.password_hash).toStartWith('$argon2id$');
});

// ---------------------------------------------------------------- A2 Inloggning

test('A2.1 rätt uppgifter ger 200 och en token som ett skyddat API accepterar', async () => {
  const registered = await register({
    email: 'a2.1@example.test',
    password: DEFAULT_PASSWORD,
    displayName: 'Inloggad',
  });
  expect(registered.statusCode).toBe(201);
  await verify('a2.1@example.test');

  const res = await login({ email: 'a2.1@example.test', password: DEFAULT_PASSWORD });

  expect(res.statusCode).toBe(200);
  const body = res.json<{ token: string; expiresIn: number }>();
  expect(body.expiresIn).toBeGreaterThan(0);

  const protectedRes = await ctx.app.inject({
    method: 'GET',
    url: '/__protected',
    headers: { authorization: `Bearer ${body.token}` },
  });
  expect(protectedRes.statusCode).toBe(200);
  expect(protectedRes.json<{ userId: string }>().userId).toBe(
    registered.json<RegisterBody>().id,
  );
});

test('A2.2 och A2.3 ger 401 med identisk kropp — fel lösenord och okänt konto', async () => {
  const registered = await register({
    email: 'a2.2@example.test',
    password: DEFAULT_PASSWORD,
    displayName: 'Finns',
  });
  expect(registered.statusCode).toBe(201);

  await verify('a2.2@example.test');

  // A2.2: kontot finns, lösenordet är fel.
  const wrongPassword = await login({
    email: 'a2.2@example.test',
    password: 'helt-fel-losenord-har',
  });
  // A2.3: kontot finns inte alls.
  const unknownAccount = await login({
    email: 'finns-inte@example.test',
    password: DEFAULT_PASSWORD,
  });

  expect(wrongPassword.statusCode).toBe(401);
  expect(unknownAccount.statusCode).toBe(401);

  // Svaret får inte röja vilket av fallen det var.
  expect(unknownAccount.body).toBe(wrongPassword.body);
  expect(wrongPassword.json<Problem>().type).toBe(
    'https://fastgig.dev/problems/invalid-credentials',
  );
});

test('A2.4 utgången eller manipulerad token avvisas med 401', async () => {
  const user = await actor(ctx.app, 'a2.4');

  // ver 0: kontot är nyregistrerat och har inte bytt lösenord.
  const expired = ctx.app.jwt.sign({ sub: user.id, ver: 0 }, { expiresIn: '-1h' });
  const tampered = `${user.token.slice(0, -3)}xyz`;

  for (const token of [expired, tampered, 'inte-ens-en-jwt']) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/__protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  }

  const missing = await ctx.app.inject({ method: 'GET', url: '/__protected' });
  expect(missing.statusCode).toBe(401);
});
