import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { freshDatabase, type TestDatabase } from '../helpers/postgres.ts';
import { CatalogError, loadCatalog } from '../../src/catalog/load.ts';
import type { GigCatalog } from '../../src/catalog/definition.ts';
import {
  listGigTemplates,
  loadInterview,
  loadTemplateClauses,
  syncGigCatalog,
} from '../../src/db/gig-catalog.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------- AM.8

test('AM.8 katalogen på disk validerar och bär basmallen plus typmallarna', async () => {
  const catalog = await loadCatalog();

  const bases = catalog.templates.filter((template) => template.layer === 'base');
  expect(bases).toHaveLength(1);
  expect(catalog.templates.filter((t) => t.layer === 'type').length).toBeGreaterThanOrEqual(10);

  // Varje mall ställer frågor och bidrar med minst en rad till kravspecen.
  for (const template of catalog.templates) {
    expect(template.asks.length).toBeGreaterThan(0);
    expect(template.clauses.length).toBeGreaterThan(0);
  }

  // Varje fråga en mall ställer finns i frågebanken, och varje frågetyp finns.
  const questionKeys = new Set(catalog.questions.map((question) => question.key));
  const kindKeys = new Set(catalog.kinds.map((kind) => kind.key));
  for (const template of catalog.templates) {
    for (const ask of template.asks) expect(questionKeys.has(ask.questionKey)).toBe(true);
  }
  for (const question of catalog.questions) expect(kindKeys.has(question.kind)).toBe(true);
});

// ---------------------------------------------------------------- AM.9

test('AM.9 en hänvisning till en fråga ingen fil definierar fälls vid inläsningen', async () => {
  const load = loadCatalog(join(FIXTURES, 'catalog-unknown-ref'));

  await expect(load).rejects.toThrow(CatalogError);
  await expect(load).rejects.toThrow('shared.finns-inte');
});

// ---------------------------------------------------------------- AM.10

test('AM.10 samma frågenyckel definierad i två filer fälls vid inläsningen', async () => {
  const load = loadCatalog(join(FIXTURES, 'catalog-duplicate-question'));

  await expect(load).rejects.toThrow(CatalogError);
  await expect(load).rejects.toThrow('base.deliverables');
});

// ---------------------------------------------------------------- AM.11

test('AM.11 synken speglar katalogen och är idempotent', async () => {
  const catalog = await loadCatalog();

  // Malldatabasen är redan synkad — en körning till ska inte flytta något.
  const before = (await db.sql`SELECT id, key FROM gig_questions ORDER BY key`) as {
    id: string;
    key: string;
  }[];

  const result = await syncGigCatalog(db.sql, catalog);
  expect(result.templates).toBe(catalog.templates.length);
  expect(result.questions).toBe(catalog.questions.length);
  expect(result.deactivatedTemplates).toBe(0);
  expect(result.deactivatedQuestions).toBe(0);

  const after = (await db.sql`SELECT id, key FROM gig_questions ORDER BY key`) as {
    id: string;
    key: string;
  }[];

  // Samma rader med samma id: lämnade svar pekar på frågan och får inte tappa fotfästet.
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------- AM.12

test('AM.12 en fråga som två mallar delar lagras en gång och ställs av båda', async () => {
  const [shared] = (await db.sql`
    SELECT q.id, count(*)::int AS mallar
    FROM gig_questions q
    JOIN gig_template_questions tq ON tq.question_id = q.id
    WHERE q.key = 'shared.rerun-allowed'
    GROUP BY q.id
  `) as { id: string; mallar: number }[];

  expect(shared?.mallar).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------- AM.13

test('AM.13 intervjun slår ihop bas och valda typer utan dubbletter', async () => {
  const base = await loadInterview(db.sql, []);
  const merged = await loadInterview(db.sql, ['data-migration', 'automation']);

  expect(base.length).toBeGreaterThan(0);
  expect(base.every((question) => question.templateKey === 'base')).toBe(true);

  const keys = merged.map((question) => question.key);
  expect(new Set(keys).size).toBe(keys.length);

  // Den delade frågan kommer in med den första mallen som ställer den.
  const shared = merged.filter((question) => question.key === 'shared.rerun-allowed');
  expect(shared).toHaveLength(1);
  expect(shared[0]?.templateKey).toBe('data-migration');

  // Basmallens frågor först, därefter typernas i mallordning.
  const templateOrder = [...new Set(merged.map((question) => question.templateKey))];
  expect(templateOrder).toEqual(['base', 'data-migration', 'automation']);
});

// ---------------------------------------------------------------- AM.14

test('AM.14 en mall som försvinner ur katalogen avaktiveras men raderas inte', async () => {
  const scratch = await freshDatabase();
  try {
    const catalog = await loadCatalog();
    await syncGigCatalog(scratch.sql, catalog);

    const trimmed: GigCatalog = {
      ...catalog,
      templates: catalog.templates.filter((template) => template.key !== 'bugfix'),
    };
    const result = await syncGigCatalog(scratch.sql, trimmed);

    expect(result.deactivatedTemplates).toBe(1);

    const [row] = (await scratch.sql`
      SELECT active FROM gig_templates WHERE key = 'bugfix'
    `) as { active: boolean }[];
    expect(row?.active).toBe(false);

    // Och den syns inte längre för den som väljer typ.
    const offered = await listGigTemplates(scratch.sql, { layer: 'type' });
    expect(offered.map((template) => template.key)).not.toContain('bugfix');
  } finally {
    await scratch.close();
  }
});

// ---------------------------------------------------------------- AM.15

test('AM.15 alternativ, villkor och svarsschema följer med ut till intervjun', async () => {
  const interview = await loadInterview(db.sql, ['screen']);

  const design = interview.find((question) => question.key === 'screen.design');
  expect(design?.kind).toBe('choice');
  expect(design?.options.map((option) => option.key)).toEqual([
    'sketch',
    'design-system',
    'existing-view',
    'free',
  ]);

  const source = interview.find((question) => question.key === 'screen.design-source');
  expect(source?.condition).toEqual({
    question: 'screen.design',
    in: ['sketch', 'design-system', 'existing-view'],
  });

  const days = interview.find((question) => question.key === 'base.acceptance-window-days');
  expect(days?.answerSchema).toEqual({ type: 'integer', minimum: 0 });
  expect(days?.config).toEqual({ minimum: 1, maximum: 20, default: 5 });
});

// ---------------------------------------------------------------- AM.16

test('AM.16 mallens kriterierader läses ut för bas och valda typer, i ordning', async () => {
  const clauses = await loadTemplateClauses(db.sql, ['bugfix']);

  const templates = [...new Set(clauses.map((clause) => clause.templateKey))];
  expect(templates).toEqual(['base', 'bugfix']);

  const criteria = clauses.filter(
    (clause) => clause.templateKey === 'bugfix' && clause.kind === 'criterion',
  );
  expect(criteria.map((clause) => clause.key)).toEqual([
    'reproduction-gone',
    'regression-test',
    'neighbours-intact',
  ]);
  expect(criteria[0]?.statement).toContain('återskapningsfallet');
  expect(criteria[0]?.verification).not.toBeNull();

  // Basmallens minimikrav och villkor följer alltid med, oavsett typ.
  expect(clauses.some((clause) => clause.kind === 'minimum')).toBe(true);
  expect(clauses.some((clause) => clause.kind === 'term')).toBe(true);
  expect(clauses.some((clause) => clause.kind === 'exclusion')).toBe(true);
});
