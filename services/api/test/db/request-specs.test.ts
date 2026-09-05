import { test, expect, beforeAll, afterAll } from 'bun:test';
import { freshDatabase, type TestDatabase } from '../helpers/postgres.ts';
import { insertBid } from '../../src/db/bids.ts';
import { loadInterview } from '../../src/db/gig-catalog.ts';
import {
  addCriterion,
  approveCriterion,
  createDraftSpec,
  findDraftSpec,
  findPublishedSpec,
  getSpec,
  MIN_CRITERIA,
  openNextDraft,
  publishSpec,
  QuestionNotAskedError,
  saveAnswer,
  saveAnswers,
  SpecNotDraftError,
  UnknownGigTypeError,
  updateCriterion,
  type RequestSpec,
} from '../../src/db/request-specs.ts';
import { AnswerNotValidError } from '../../src/domain/gig-answers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.close();
});

async function buyer(): Promise<string> {
  const [row] = (await db.sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${`spec-${crypto.randomUUID()}@example.test`}, 'h', 'Köpare')
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function request(buyerId: string): Promise<string> {
  const [row] = (await db.sql`
    INSERT INTO requests (buyer_id, title, description, compensation_pref)
    VALUES (${buyerId}, 'Nattlig import', 'Beskrivning', 'fixed')
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

/** Besvarar allt som mallarna kräver, med ett värde som duger för frågans form. */
async function answerEverything(spec: RequestSpec): Promise<void> {
  const interview = await loadInterview(db.sql, spec.typeKeys);

  await saveAnswers(db.sql, {
    specVersionId: spec.version.id,
    answers: interview.map((question) => ({
      questionKey: question.key,
      value: sampleAnswer(question),
    })),
  });
}

function sampleAnswer(question: {
  kind: string;
  config: Record<string, unknown>;
  options: { key: string }[];
}): unknown {
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

async function approveAll(spec: RequestSpec, userId: string): Promise<void> {
  const current = await getSpec(db.sql, spec.version.id);
  for (const criterion of current?.criteria ?? []) {
    if (criterion.kind !== 'criterion') continue;
    await approveCriterion(db.sql, { criterionId: criterion.id, userId });
  }
}

/** En färdig kravspec som bara väntar på publicering. */
async function readyToPublish(typeKeys = ['data-migration']) {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys });
  await answerEverything(spec);
  await approveAll(spec, userId);
  return { userId, requestId, spec };
}

// ---------------------------------------------------------------- KS.1

test('KS.1 ett utkast bär de valda typerna och kriterieutkastet ur mallarna', async () => {
  const requestId = await request(await buyer());
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });

  expect(spec.version.version).toBe(1);
  expect(spec.version.status).toBe('draft');
  expect(spec.version.publishedAt).toBeNull();
  expect(spec.typeKeys).toEqual(['bugfix']);

  // Basmallens minimikrav och villkor plus typens acceptanspunkter, som egna rader.
  const kinds = new Set(spec.criteria.map((criterion) => criterion.kind));
  expect([...kinds].sort()).toEqual(['criterion', 'exclusion', 'minimum', 'term']);

  const fromBugfix = spec.criteria.filter((row) => row.sourceTemplateKey === 'bugfix');
  expect(fromBugfix.length).toBeGreaterThan(0);
  expect(fromBugfix.every((row) => row.origin === 'template')).toBe(true);
  expect(spec.criteria.every((row) => row.status === 'pending')).toBe(true);
  expect(spec.criteria.every((row) => row.approvedAt === null)).toBe(true);
});

test('KS.1 en okänd uppdragstyp avvisas', async () => {
  const requestId = await request(await buyer());

  await expect(
    createDraftSpec(db.sql, { requestId, typeKeys: ['blockkedja'] }),
  ).rejects.toThrow(UnknownGigTypeError);
});

// ---------------------------------------------------------------- KS.2

test('KS.2 ett svar prövas mot frågans egen form', async () => {
  const requestId = await request(await buyer());
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['automation'] });

  const saved = await saveAnswer(db.sql, {
    specVersionId: spec.version.id,
    questionKey: 'automation.log-retention-days',
    value: 30,
  });
  expect(saved.value).toBe(30);
  // Frågans lydelse fryses i svarsraden.
  expect(saved.prompt).toContain('loggarna');

  await expect(
    saveAnswer(db.sql, {
      specVersionId: spec.version.id,
      questionKey: 'automation.log-retention-days',
      value: '30',
    }),
  ).rejects.toThrow(AnswerNotValidError);

  await expect(
    saveAnswer(db.sql, {
      specVersionId: spec.version.id,
      questionKey: 'base.deployment',
      value: 'kanske',
    }),
  ).rejects.toThrow(AnswerNotValidError);
});

// ---------------------------------------------------------------- KS.3

test('KS.3 en fråga som de valda typerna inte ställer går inte att besvara', async () => {
  const requestId = await request(await buyer());
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['automation'] });

  await expect(
    saveAnswer(db.sql, {
      specVersionId: spec.version.id,
      questionKey: 'bugfix.reproduction',
      value: 'Steg ett, steg två.',
    }),
  ).rejects.toThrow(QuestionNotAskedError);
});

// ---------------------------------------------------------------- KS.4

test('KS.4 ett svar per fråga och version — ett nytt ersätter det gamla', async () => {
  const requestId = await request(await buyer());
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['automation'] });

  await saveAnswer(db.sql, {
    specVersionId: spec.version.id,
    questionKey: 'automation.schedule',
    value: 'Varje natt klockan 02.',
  });
  await saveAnswer(db.sql, {
    specVersionId: spec.version.id,
    questionKey: 'automation.schedule',
    value: 'Var femte minut.',
  });

  const after = await getSpec(db.sql, spec.version.id);
  const schedule = after?.answers.filter((answer) => answer.questionKey === 'automation.schedule');
  expect(schedule).toHaveLength(1);
  expect(schedule?.[0]?.value).toBe('Var femte minut.');
});

// ---------------------------------------------------------------- KS.5

test('KS.5 kundens godkännande av en rad tidsstämplas med användaren', async () => {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });

  const first = spec.criteria.find((criterion) => criterion.kind === 'criterion');
  const approved = await approveCriterion(db.sql, { criterionId: first!.id, userId });

  expect(approved?.approvedBy).toBe(userId);
  expect(approved?.approvedAt).toBeInstanceOf(Date);
});

// ---------------------------------------------------------------- KS.6

test('KS.6 en omskriven rad tappar sitt godkännande', async () => {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });

  const row = spec.criteria.find((criterion) => criterion.kind === 'criterion');
  await approveCriterion(db.sql, { criterionId: row!.id, userId });

  const rewritten = await updateCriterion(db.sql, {
    criterionId: row!.id,
    statement: 'När felet återskapas enligt steg 1–4, ska listan visas med samtliga rader.',
  });

  expect(rewritten?.statement).toContain('steg 1–4');
  expect(rewritten?.approvedAt).toBeNull();
  expect(rewritten?.approvedBy).toBeNull();
});

// ---------------------------------------------------------------- KS.7

test('KS.7 publicering vägras när en obligatorisk fråga saknar svar, och pekar ut den', async () => {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });
  await approveAll(spec, userId);

  const result = await publishSpec(db.sql, spec.version.id);

  expect(result.published).toBeUndefined();
  const unanswered = (result.blockers ?? []).filter(
    (blocker) => blocker.code === 'unanswered-question',
  );
  expect(unanswered.length).toBeGreaterThan(0);
  expect(unanswered.map((blocker) => blocker.path)).toContain('bugfix.reproduction');

  // Och versionen står kvar som utkast.
  expect((await getSpec(db.sql, spec.version.id))?.version.status).toBe('draft');
});

// ---------------------------------------------------------------- KS.8

test('KS.8 publicering vägras när kriterierna är för få eller inte godkända', async () => {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['other'] });
  await answerEverything(spec);

  const tooFew = await publishSpec(db.sql, spec.version.id);
  const codes = (tooFew.blockers ?? []).map((blocker) => blocker.code);
  // "Övrigt" bidrar med ett enda kriterium — under golvet på tre.
  expect(codes).toContain('too-few-criteria');
  expect(codes).toContain('criterion-not-approved');

  for (let i = 0; i < MIN_CRITERIA; i += 1) {
    await addCriterion(db.sql, {
      specVersionId: spec.version.id,
      kind: 'criterion',
      statement: `När testfall ${i + 1} körs, ska resultatet vara det avtalade.`,
      verification: 'Körs av verifieraren i testmiljön.',
    });
  }

  const notApproved = await publishSpec(db.sql, spec.version.id);
  expect((notApproved.blockers ?? []).map((blocker) => blocker.code)).not.toContain(
    'too-few-criteria',
  );
  expect((notApproved.blockers ?? []).map((blocker) => blocker.code)).toContain(
    'criterion-not-approved',
  );

  await approveAll(spec, userId);
  const published = await publishSpec(db.sql, spec.version.id);
  expect(published.blockers).toBeUndefined();
  expect(published.published?.status).toBe('published');
  expect(published.published?.publishedAt).toBeInstanceOf(Date);
});

// ---------------------------------------------------------------- KS.9

test('KS.9 en fråga som villkoret döljer blockerar inte publiceringen', async () => {
  const { spec } = await readyToPublish(['screen']);

  // screen.design-source ställs bara när det finns ett designunderlag. Svaret "free"
  // döljer den — men bara om villkoret faktiskt utvärderas vid publiceringskontrollen.
  await saveAnswer(db.sql, {
    specVersionId: spec.version.id,
    questionKey: 'screen.design',
    value: 'free',
  });
  await db.sql`
    DELETE FROM request_answers
    WHERE spec_version_id = ${spec.version.id} AND question_key = 'screen.design-source'
  `;

  const result = await publishSpec(db.sql, spec.version.id);
  expect(result.blockers).toBeUndefined();
  expect(result.published?.status).toBe('published');
});

// ---------------------------------------------------------------- KS.10

test('KS.10 en publicerad version går inte att ändra', async () => {
  const { userId, spec } = await readyToPublish();
  await publishSpec(db.sql, spec.version.id);

  await expect(
    saveAnswer(db.sql, {
      specVersionId: spec.version.id,
      questionKey: 'migration.source',
      value: 'Ett nytt svar.',
    }),
  ).rejects.toThrow(SpecNotDraftError);

  const criterion = (await getSpec(db.sql, spec.version.id))!.criteria[0]!;
  await expect(
    updateCriterion(db.sql, { criterionId: criterion.id, statement: 'Ny lydelse.' }),
  ).rejects.toThrow(SpecNotDraftError);
  await expect(
    approveCriterion(db.sql, { criterionId: criterion.id, userId }),
  ).rejects.toThrow(SpecNotDraftError);
  await expect(
    addCriterion(db.sql, {
      specVersionId: spec.version.id,
      kind: 'criterion',
      statement: 'När något händer, ska något annat hända.',
    }),
  ).rejects.toThrow(SpecNotDraftError);
});

// ---------------------------------------------------------------- KS.11

test('KS.11 nästa utkast är en kopia, och den publicerade lydelsen står kvar tills det publiceras', async () => {
  const { requestId, spec } = await readyToPublish();
  await publishSpec(db.sql, spec.version.id);
  const first = await getSpec(db.sql, spec.version.id);

  const next = await openNextDraft(db.sql, requestId);
  expect(next?.version.version).toBe(2);
  expect(next?.version.status).toBe('draft');
  expect(next?.typeKeys).toEqual(first!.typeKeys);
  expect(next?.answers).toHaveLength(first!.answers.length);
  expect(next?.criteria).toHaveLength(first!.criteria.length);
  // Godkännandena följer med — en oförändrad rad är fortfarande godkänd.
  expect(next?.criteria.every((row) => row.approvedAt !== null || row.kind !== 'criterion')).toBe(
    true,
  );

  // Version 1 gäller fortfarande: anbud som kommer in nu avser den.
  expect((await findPublishedSpec(db.sql, requestId))?.version.version).toBe(1);

  await publishSpec(db.sql, next!.version.id);
  expect((await findPublishedSpec(db.sql, requestId))?.version.version).toBe(2);
  expect((await getSpec(db.sql, spec.version.id))?.version.status).toBe('superseded');
});

// ---------------------------------------------------------------- KS.12

test('KS.12 en förfrågan har högst ett utkast och högst en gällande version', async () => {
  const { requestId, spec } = await readyToPublish();

  await expect(createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] })).rejects.toThrow();

  await publishSpec(db.sql, spec.version.id);
  expect((await findDraftSpec(db.sql, requestId))).toBeNull();

  await openNextDraft(db.sql, requestId);
  await expect(openNextDraft(db.sql, requestId)).rejects.toThrow();
});

// ---------------------------------------------------------------- KS.13

test('KS.13 ett anbud binds till den lydelse som gällde när det lämnades', async () => {
  const { requestId, spec } = await readyToPublish();

  const seller = await buyer();
  const before = await insertBid(db.sql, {
    requestId,
    sellerId: seller,
    plan: 'Innan kravspecen publicerats.',
    compensation: { type: 'fixed', amountMinor: 100000, currency: 'SEK' },
  });
  expect(before?.specVersionId).toBeNull();

  await publishSpec(db.sql, spec.version.id);

  const after = await insertBid(db.sql, {
    requestId,
    sellerId: await buyer(),
    plan: 'Efter publiceringen.',
    compensation: { type: 'fixed', amountMinor: 100000, currency: 'SEK' },
  });
  expect(after?.specVersionId).toBe(spec.version.id);

  // Nästa version flyttar inte anbudet.
  const next = await openNextDraft(db.sql, requestId);
  await publishSpec(db.sql, next!.version.id);

  const [row] = (await db.sql`
    SELECT spec_version_id FROM bids WHERE id = ${after!.id}
  `) as { spec_version_id: string }[];
  expect(row?.spec_version_id).toBe(spec.version.id);
});

// ---------------------------------------------------------------- KS.14

test('KS.14 kriterieraderna är kopior — mallen får ändras utan att kravspecen gör det', async () => {
  const requestId = await request(await buyer());
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });

  const before = spec.criteria.find((row) => row.sourceClauseKey === 'reproduction-gone');
  expect(before).toBeDefined();

  await db.sql`
    UPDATE gig_template_clauses SET statement = 'Något helt annat.'
    WHERE key = 'reproduction-gone'
  `;

  const after = await getSpec(db.sql, spec.version.id);
  const row = after?.criteria.find((criterion) => criterion.sourceClauseKey === 'reproduction-gone');
  expect(row?.statement).toBe(before?.statement);
  expect(row?.statement).not.toBe('Något helt annat.');
});

// ---------------------------------------------------------------- KS.15

test('KS.15 ett raderat konto tar inte med sig godkännandets tidsstämpel', async () => {
  const userId = await buyer();
  const requestId = await request(userId);
  const spec = await createDraftSpec(db.sql, { requestId, typeKeys: ['bugfix'] });

  const row = spec.criteria.find((criterion) => criterion.kind === 'criterion');
  const approved = await approveCriterion(db.sql, { criterionId: row!.id, userId });

  // Kontot försvinner — förfrågan ägs av någon annan, så kravspecen står kvar.
  await db.sql`UPDATE requests SET buyer_id = ${await buyer()} WHERE id = ${requestId}`;
  await db.sql`DELETE FROM users WHERE id = ${userId}`;

  const after = await getSpec(db.sql, spec.version.id);
  const criterion = after?.criteria.find((row) => row.id === approved!.id);
  expect(criterion?.approvedAt).toEqual(approved!.approvedAt);
  expect(criterion?.approvedBy).toBeNull();
});
