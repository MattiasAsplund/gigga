import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  KindFileSchema,
  QuestionFileSchema,
  TemplateFileSchema,
  type CatalogAsk,
  type CatalogClause,
  type CatalogKind,
  type CatalogQuestion,
  type CatalogTemplate,
  type GigCatalog,
  type KindFile,
  type QuestionFile,
  type TemplateFile,
} from './definition.ts';

/**
 * Läser acceptansmallarna från katalogfilerna.
 *
 * Katalogen är data, inte kod: en ny uppdragstyp är en fil under `catalog/templates/`,
 * en ny fråga en post i en `asks`-lista. Inget i `src/` behöver röras, och eftersom
 * databasen är icke-persistent räcker det att synka in filerna vid boot
 * (src/db/gig-catalog.ts).
 *
 *   catalog/question-kinds.json   frågetyperna och deras svarsscheman
 *   catalog/questions/*.json      frågor som flera mallar delar
 *   catalog/templates/*.json      basmallen och typmallarna, i filnamnsordning
 */
export const CATALOG_DIR = join(import.meta.dir, '..', '..', 'catalog');

/** Fel i katalogdatan. Bär filen och pekaren, för det är där rättningen ska göras. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new CatalogError(`${path}: ogiltig JSON — ${(err as Error).message}`);
  }
}

function check<T>(schema: TSchema, value: unknown, path: string): T {
  if (Value.Check(schema, value)) return value as T;

  // Första felet räcker: den som rättar filen kör om och får nästa.
  const first = Value.Errors(schema, value).First();
  const pointer = first?.path === '' ? '(roten)' : (first?.path ?? '(okänt)');
  throw new CatalogError(`${path}: ${pointer} ${first?.message ?? 'validerar inte'}`);
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // Filnamnsordning: prefixen (000-, 010-) är mallarnas ordning i katalogen.
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

function toQuestion(
  definition: { key: string; prompt: string; help?: string; kind: string; config?: Record<string, unknown>; options?: { key: string; label: string }[] },
): CatalogQuestion {
  return {
    key: definition.key,
    prompt: definition.prompt,
    helpText: definition.help ?? null,
    kind: definition.kind,
    config: definition.config ?? {},
    options: definition.options ?? [],
  };
}

/** Lägger frågan i banken, och fäller om någon annan fil redan definierat nyckeln. */
function define(
  bank: Map<string, CatalogQuestion>,
  origin: Map<string, string>,
  question: CatalogQuestion,
  path: string,
): void {
  const earlier = origin.get(question.key);
  if (earlier) {
    throw new CatalogError(
      `${path}: frågan ${question.key} är redan definierad i ${earlier}. ` +
        'Definiera den på ett ställe och hänvisa med { "ref": "…" } från övriga.',
    );
  }
  bank.set(question.key, question);
  origin.set(question.key, path);
}

export async function loadCatalog(dir: string = CATALOG_DIR): Promise<GigCatalog> {
  const kindsPath = join(dir, 'question-kinds.json');
  const kindFile = check<KindFile>(KindFileSchema, await readJson(kindsPath), kindsPath);
  const kinds: CatalogKind[] = kindFile.kinds.map((kind) => ({
    key: kind.key,
    description: kind.description,
    answerSchema: kind.answerSchema,
  }));

  const bank = new Map<string, CatalogQuestion>();
  const origin = new Map<string, string>();

  for (const path of await jsonFilesIn(join(dir, 'questions'))) {
    const file = check<QuestionFile>(QuestionFileSchema, await readJson(path), path);
    for (const definition of file.questions) define(bank, origin, toQuestion(definition), path);
  }

  const templates: CatalogTemplate[] = [];
  for (const path of await jsonFilesIn(join(dir, 'templates'))) {
    const file = check<TemplateFile>(TemplateFileSchema, await readJson(path), path);

    const asks: CatalogAsk[] = file.asks.map((ask, index) => {
      const questionKey = 'ref' in ask ? ask.ref : ask.key;
      if (!('ref' in ask)) define(bank, origin, toQuestion(ask), path);

      return {
        questionKey,
        position: index,
        required: ask.required ?? true,
        condition: ask.condition ?? null,
      };
    });

    const clauses: CatalogClause[] = (file.clauses ?? []).map((clause, index) => ({
      key: clause.key,
      kind: clause.kind,
      statement: clause.statement,
      verification: clause.verification ?? null,
      position: index,
    }));

    templates.push({
      key: file.key,
      layer: file.layer,
      name: file.name,
      summary: file.summary ?? null,
      position: file.position,
      asks,
      clauses,
    });
  }

  validate({ kinds, questions: [...bank.values()], templates }, origin);

  return { kinds, questions: [...bank.values()], templates };
}

/**
 * Kontrollerna som inte går att uttrycka i ett schema för en enskild fil: att
 * hänvisningarna går någonstans, att nycklarna är unika över filgränsen och att varje
 * fråga har en frågetyp som finns.
 */
function validate(catalog: GigCatalog, origin: Map<string, string>): void {
  const kindKeys = new Set(catalog.kinds.map((kind) => kind.key));
  const questionKeys = new Set(catalog.questions.map((question) => question.key));

  for (const question of catalog.questions) {
    const path = origin.get(question.key) ?? '(okänd fil)';
    if (!kindKeys.has(question.kind)) {
      throw new CatalogError(
        `${path}: frågan ${question.key} har frågetypen ${question.kind}, som inte finns i question-kinds.json.`,
      );
    }

    const takesOptions = question.kind === 'choice' || question.kind === 'multichoice';
    if (takesOptions && question.options.length === 0) {
      throw new CatalogError(`${path}: frågan ${question.key} är ${question.kind} och måste ha alternativ.`);
    }
    if (!takesOptions && question.options.length > 0) {
      throw new CatalogError(
        `${path}: frågan ${question.key} är ${question.kind} och kan inte ha alternativ.`,
      );
    }
  }

  const templateKeys = new Set<string>();
  let bases = 0;
  for (const template of catalog.templates) {
    if (templateKeys.has(template.key)) {
      throw new CatalogError(`Mallnyckeln ${template.key} används av två mallar.`);
    }
    templateKeys.add(template.key);
    if (template.layer === 'base') bases += 1;

    const asked = new Set<string>();
    for (const ask of template.asks) {
      if (!questionKeys.has(ask.questionKey)) {
        throw new CatalogError(
          `Mallen ${template.key} hänvisar till frågan ${ask.questionKey}, som ingen fil definierar.`,
        );
      }
      if (asked.has(ask.questionKey)) {
        throw new CatalogError(`Mallen ${template.key} ställer frågan ${ask.questionKey} två gånger.`);
      }
      asked.add(ask.questionKey);

      // Ett villkor som pekar på en fråga som inte finns skulle tyst dölja frågan.
      if (ask.condition && !questionKeys.has(ask.condition.question)) {
        throw new CatalogError(
          `Mallen ${template.key}: villkoret på ${ask.questionKey} pekar på frågan ` +
            `${ask.condition.question}, som ingen fil definierar.`,
        );
      }
    }
  }

  if (bases !== 1) {
    throw new CatalogError(`Katalogen ska ha exakt en basmall, hittade ${bases}.`);
  }
}
