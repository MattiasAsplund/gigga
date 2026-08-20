import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';

let ctx: TestApp;
let buyer: Actor;
let outsider: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  outsider = await actor(ctx.app, 'utomstaende');
});

afterAll(async () => {
  await ctx.close();
});

interface Problem {
  type: string;
  status: number;
  errors?: { path: string; message: string }[];
}

interface Question {
  key: string;
  prompt: string;
  helpText: string | null;
  kind: string;
  options: { key: string; label: string }[];
  config: Record<string, unknown>;
  required: boolean;
  condition: { question: string; notEquals?: unknown; in?: unknown[] } | null;
  templateKey: string;
  visible: boolean;
  answered: boolean;
}

interface Criterion {
  id: string;
  kind: string;
  statement: string;
  verification: string | null;
  origin: string;
  sourceTemplateKey: string | null;
  status: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

interface Spec {
  requestId: string;
  version: { id: string; version: number; status: string; publishedAt: string | null };
  gigTypes: { key: string; name: string }[];
  questions: Question[];
  answers: { questionKey: string; prompt: string; value: unknown; answeredAt: string }[];
  criteria: Criterion[];
  completeness: {
    requiredQuestions: number;
    answeredRequired: number;
    criteria: number;
    approvedCriteria: number;
    publishable: boolean;
    blockers: { code: string; path: string | null; detail: string }[];
  };
}

async function createRequest(): Promise<string> {
  const res = await buyer.post('/api/v1/requests', {
    title: 'Nattlig import av kundregister',
    description: 'Från CSV in i kundtabellen, varje natt.',
    compensationPref: 'fixed',
  });
  if (res.statusCode !== 201) throw new Error(`Kunde inte lägga förfrågan: ${res.body}`);
  return res.json<{ id: string }>().id;
}

const patch = (as: Actor, url: string, payload: unknown) =>
  ctx.app.inject({ method: 'PATCH', url, payload: payload as never, headers: as.headers });

const put = (as: Actor, url: string, payload: unknown) =>
  ctx.app.inject({ method: 'PUT', url, payload: payload as never, headers: as.headers });

/** Ett svar som duger för frågans form — samma trick som intervjun får i gränssnittet. */
function sampleAnswer(question: Question): unknown {
  switch (question.kind) {
    case 'bool':
      return true;
    case 'integer':
      return typeof question.config['minimum'] === 'number' ? question.config['minimum'] : 1;
    case 'date':
      return '2026-09-01';
    case 'choice':
      return question.options[0]?.key;
    case 'multichoice':
      return [question.options[0]?.key];
    default:
      return 'Ett svar som duger.';
  }
}

/** Öppnar kravspecen, besvarar allt synligt och godkänner varje kriterierad. */
async function readySpec(typeKeys = ['data-migration']): Promise<{ requestId: string; spec: Spec }> {
  const requestId = await createRequest();
  const opened = await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: typeKeys });
  if (opened.statusCode !== 201) throw new Error(`Kunde inte öppna kravspecen: ${opened.body}`);

  const spec = opened.json<Spec>();
  await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: spec.questions
      .filter((question) => question.visible)
      .map((question) => ({ questionKey: question.key, value: sampleAnswer(question) })),
  });

  for (const criterion of spec.criteria.filter((row) => row.kind === 'criterion')) {
    await buyer.post(
      `/api/v1/requests/${requestId}/spec/criteria/${criterion.id}/approval`,
      {},
    );
  }

  const current = await buyer.get(`/api/v1/requests/${requestId}/spec`);
  return { requestId, spec: current.json<Spec>() };
}

// ---------------------------------------------------------------- I.1

test('I.1 katalogen listar de valbara uppdragstyperna, inte basmallen', async () => {
  const res = await buyer.get('/api/v1/gig-types');

  expect(res.statusCode).toBe(200);
  const body = res.json<{ items: { key: string; name: string; questionCount: number }[] }>();

  const keys = body.items.map((item) => item.key);
  expect(keys).toContain('integration');
  expect(keys).toContain('bugfix');
  expect(keys).toContain('other');
  // Basmallen gäller alltid och är inget kunden väljer.
  expect(keys).not.toContain('base');

  const bugfix = body.items.find((item) => item.key === 'bugfix');
  expect(bugfix?.name).toBeTruthy();
  expect(bugfix?.questionCount).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- I.2

test('I.2 katalogen kräver token', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/gig-types' });

  expect(res.statusCode).toBe(401);
  expect(res.json<Problem>().type).toContain('unauthorized');
});

// ---------------------------------------------------------------- I.3

test('I.3 intervjun för flera typer slås ihop utan dubbletter', async () => {
  const res = await buyer.get('/api/v1/gig-types/interview?types=data-migration,automation');

  expect(res.statusCode).toBe(200);
  const body = res.json<{ types: { key: string }[]; questions: Question[]; clauses: unknown[] }>();

  expect(body.types.map((type) => type.key)).toEqual(['data-migration', 'automation']);

  const keys = body.questions.map((question) => question.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.filter((key) => key === 'shared.rerun-allowed')).toHaveLength(1);

  // Basmallens frågor först, och alternativ och villkor följer med.
  expect(body.questions[0]?.templateKey).toBe('base');
  const deployment = body.questions.find((question) => question.key === 'base.deployment');
  expect(deployment?.options.length).toBeGreaterThan(1);
  const environment = body.questions.find(
    (question) => question.key === 'base.deployment-environment',
  );
  expect(environment?.condition).toEqual({ question: 'base.deployment', notEquals: 'none' });

  expect(body.clauses.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- I.4

test('I.4 en okänd uppdragstyp ⇒ 422 med fältpekare', async () => {
  const res = await buyer.get('/api/v1/gig-types/interview?types=blockkedja');

  expect(res.statusCode).toBe(422);
  const problem = res.json<Problem>();
  expect(problem.type).toContain('validation-failed');
  expect(problem.errors?.[0]?.path).toBe('types');
});

// ---------------------------------------------------------------- I.5

test('I.5 kravspecen öppnas med valda typer och kriterieutkast ur mallarna', async () => {
  const requestId = await createRequest();
  const res = await buyer.post(`/api/v1/requests/${requestId}/spec`, {
    gigTypes: ['data-migration'],
  });

  expect(res.statusCode).toBe(201);
  const spec = res.json<Spec>();

  expect(spec.version.version).toBe(1);
  expect(spec.version.status).toBe('draft');
  expect(spec.gigTypes.map((type) => type.key)).toEqual(['data-migration']);
  expect(spec.criteria.some((row) => row.sourceTemplateKey === 'data-migration')).toBe(true);
  expect(spec.criteria.some((row) => row.kind === 'exclusion')).toBe(true);
  expect(spec.completeness.publishable).toBe(false);
  expect(spec.completeness.answeredRequired).toBe(0);
  expect(spec.completeness.requiredQuestions).toBeGreaterThan(0);
});

test('I.5 en okänd typ när kravspecen öppnas ⇒ 422', async () => {
  const requestId = await createRequest();
  const res = await buyer.post(`/api/v1/requests/${requestId}/spec`, {
    gigTypes: ['data-migration', 'blockkedja'],
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.[0]?.path).toBe('gigTypes');
});

// ---------------------------------------------------------------- I.6

test('I.6 bara förfrågans köpare får öppna och ändra kravspecen', async () => {
  const requestId = await createRequest();

  const opened = await outsider.post(`/api/v1/requests/${requestId}/spec`, {
    gigTypes: ['bugfix'],
  });
  expect(opened.statusCode).toBe(403);
  expect(opened.json<Problem>().type).toContain('not-request-owner');

  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });
  const answered = await put(outsider, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [{ questionKey: 'context.stack', value: 'Node' }],
  });
  expect(answered.statusCode).toBe(403);
});

// ---------------------------------------------------------------- I.7

test('I.7 en andra kravspec på samma förfrågan ⇒ 409', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });

  const again = await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['screen'] });
  expect(again.statusCode).toBe(409);
  expect(again.json<Problem>().type).toContain('spec-exists');
});

// ---------------------------------------------------------------- I.8

test('I.8 svar sparas och fullständighetsindikatorn följer med', async () => {
  const requestId = await createRequest();
  const opened = await buyer.post(`/api/v1/requests/${requestId}/spec`, {
    gigTypes: ['automation'],
  });
  const before = opened.json<Spec>().completeness;

  const res = await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [
      { questionKey: 'automation.schedule', value: 'Varje natt klockan 02.' },
      { questionKey: 'automation.log-retention-days', value: 30 },
    ],
  });

  expect(res.statusCode).toBe(200);
  const body = res.json<{ answers: { questionKey: string; value: unknown }[]; completeness: Spec['completeness'] }>();
  expect(body.answers).toHaveLength(2);
  expect(body.answers.find((a) => a.questionKey === 'automation.log-retention-days')?.value).toBe(30);
  expect(body.completeness.answeredRequired).toBe(before.answeredRequired + 2);

  const spec = (await buyer.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>();
  expect(spec.questions.find((q) => q.key === 'automation.schedule')?.answered).toBe(true);
});

// ---------------------------------------------------------------- I.9

test('I.9 ett svar som bryter mot frågans form ⇒ 422 med frågan som pekare', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['automation'] });

  const res = await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [{ questionKey: 'automation.log-retention-days', value: '30' }],
  });

  expect(res.statusCode).toBe(422);
  const problem = res.json<Problem>();
  expect(problem.type).toContain('validation-failed');
  expect(problem.errors?.[0]?.path).toBe('automation.log-retention-days');
});

// ---------------------------------------------------------------- I.10

test('I.10 en fråga som de valda typerna inte ställer ⇒ 422', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['automation'] });

  const res = await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [{ questionKey: 'bugfix.reproduction', value: 'Steg ett, steg två.' }],
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<Problem>().errors?.[0]?.path).toBe('bugfix.reproduction');
});

// ---------------------------------------------------------------- I.11

test('I.11 kunden lägger till, skriver om och stryker egna kriterierader', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['other'] });

  const added = await buyer.post(`/api/v1/requests/${requestId}/spec/criteria`, {
    kind: 'criterion',
    statement: 'När importfilen saknar kolumnen postort, ska raden avvisas med felkod 12.',
    verification: 'Körs med en testfil som saknar kolumnen.',
  });
  expect(added.statusCode).toBe(201);
  const criterion = added.json<Criterion>();
  expect(criterion.origin).toBe('custom');
  expect(criterion.sourceTemplateKey).toBeNull();

  await buyer.post(`/api/v1/requests/${requestId}/spec/criteria/${criterion.id}/approval`, {});

  const changed = await patch(
    buyer,
    `/api/v1/requests/${requestId}/spec/criteria/${criterion.id}`,
    { statement: 'När importfilen saknar postort, ska raden avvisas och övriga importeras.' },
  );
  expect(changed.statusCode).toBe(200);
  expect(changed.json<Criterion>().statement).toContain('övriga importeras');
  // En omskriven rad ska godkännas på nytt.
  expect(changed.json<Criterion>().approvedAt).toBeNull();

  const removed = await buyer.del(
    `/api/v1/requests/${requestId}/spec/criteria/${criterion.id}`,
  );
  expect(removed.statusCode).toBe(200);
  expect(removed.json<{ removed: boolean }>().removed).toBe(true);

  const spec = (await buyer.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>();
  expect(spec.criteria.some((row) => row.id === criterion.id)).toBe(false);
});

test('I.11 en kriterierad som inte finns ⇒ 404', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['other'] });

  const res = await patch(
    buyer,
    `/api/v1/requests/${requestId}/spec/criteria/${crypto.randomUUID()}`,
    { statement: 'Finns inte.' },
  );
  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toContain('criterion-not-found');
});

// ---------------------------------------------------------------- I.12

test('I.12 godkännandet av en rad tidsstämplas med kunden', async () => {
  const requestId = await createRequest();
  const opened = await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });
  const criterion = opened.json<Spec>().criteria.find((row) => row.kind === 'criterion')!;

  const res = await buyer.post(
    `/api/v1/requests/${requestId}/spec/criteria/${criterion.id}/approval`,
    {},
  );

  expect(res.statusCode).toBe(200);
  const approved = res.json<Criterion>();
  expect(approved.approvedBy).toBe(buyer.id);
  expect(approved.approvedAt).toBeTruthy();
});

// ---------------------------------------------------------------- I.13

test('I.13 publicering utan svar och godkännanden ⇒ 422 som pekar ut varje brist', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });

  const res = await buyer.post(`/api/v1/requests/${requestId}/spec/publication`, {});

  expect(res.statusCode).toBe(422);
  const problem = res.json<Problem>();
  expect(problem.type).toContain('spec-not-publishable');
  expect(problem.errors?.some((error) => error.path === 'bugfix.reproduction')).toBe(true);
  expect(problem.errors!.length).toBeGreaterThan(1);

  // Och kravspecen står kvar som utkast.
  const spec = (await buyer.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>();
  expect(spec.version.status).toBe('draft');
});

// ---------------------------------------------------------------- I.14

test('I.14 en fullständig kravspec publiceras och blir läsbar för alla inloggade', async () => {
  const { requestId, spec } = await readySpec();
  expect(spec.completeness.publishable).toBe(true);

  const res = await buyer.post(`/api/v1/requests/${requestId}/spec/publication`, {});
  expect(res.statusCode).toBe(200);
  const published = res.json<Spec>();
  expect(published.version.status).toBe('published');
  expect(published.version.publishedAt).toBeTruthy();

  const asSeller = await outsider.get(`/api/v1/requests/${requestId}/spec`);
  expect(asSeller.statusCode).toBe(200);
  const seen = asSeller.json<Spec>();
  expect(seen.version.version).toBe(1);
  expect(seen.criteria.length).toBeGreaterThan(0);
  expect(seen.answers.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- I.15

test('I.15 ett utkast syns inte för utomstående före publicering', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });

  const res = await outsider.get(`/api/v1/requests/${requestId}/spec`);
  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toContain('spec-not-found');
});

// ---------------------------------------------------------------- I.16

test('I.16 en publicerad kravspec går inte att ändra ⇒ 409', async () => {
  const { requestId } = await readySpec();
  await buyer.post(`/api/v1/requests/${requestId}/spec/publication`, {});

  const res = await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [{ questionKey: 'context.stack', value: 'Något annat.' }],
  });

  expect(res.statusCode).toBe(409);
  expect(res.json<Problem>().type).toContain('spec-not-draft');
});

// ---------------------------------------------------------------- I.17

test('I.17 en revision öppnar nästa utkast, och den gällande lydelsen står kvar', async () => {
  const { requestId } = await readySpec();
  await buyer.post(`/api/v1/requests/${requestId}/spec/publication`, {});

  const res = await buyer.post(`/api/v1/requests/${requestId}/spec/revisions`, {});
  expect(res.statusCode).toBe(201);
  const draft = res.json<Spec>();
  expect(draft.version.version).toBe(2);
  expect(draft.version.status).toBe('draft');
  expect(draft.answers.length).toBeGreaterThan(0);

  // Köparen arbetar i utkastet, säljaren ser fortfarande v1.
  expect((await buyer.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>().version.version).toBe(2);
  expect(
    (await outsider.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>().version.version,
  ).toBe(1);

  const again = await buyer.post(`/api/v1/requests/${requestId}/spec/revisions`, {});
  expect(again.statusCode).toBe(409);
});

test('I.17 en revision utan publicerad version ⇒ 404', async () => {
  const requestId = await createRequest();
  await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['bugfix'] });

  const res = await buyer.post(`/api/v1/requests/${requestId}/spec/revisions`, {});
  expect(res.statusCode).toBe(404);
  expect(res.json<Problem>().type).toContain('no-published-spec');
});

// ---------------------------------------------------------------- I.18

test('I.18 en dold fråga är varken synlig eller obligatorisk i indikatorn', async () => {
  const requestId = await createRequest();
  const opened = await buyer.post(`/api/v1/requests/${requestId}/spec`, { gigTypes: ['screen'] });
  const spec = opened.json<Spec>();

  const source = spec.questions.find((question) => question.key === 'screen.design-source');
  expect(source?.visible).toBe(false);

  await put(buyer, `/api/v1/requests/${requestId}/spec/answers`, {
    answers: [{ questionKey: 'screen.design', value: 'sketch' }],
  });

  const after = (await buyer.get(`/api/v1/requests/${requestId}/spec`)).json<Spec>();
  expect(after.questions.find((q) => q.key === 'screen.design-source')?.visible).toBe(true);
  expect(after.completeness.requiredQuestions).toBe(spec.completeness.requiredQuestions + 1);
});
