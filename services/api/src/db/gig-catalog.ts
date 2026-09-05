import type { SQL } from 'bun';
import { loadCatalog, type CatalogError } from '../catalog/load.ts';
import type {
  ClauseKind,
  GigCatalog,
  QuestionCondition,
  TemplateLayer,
} from '../catalog/definition.ts';

/**
 * Katalogen i databasen: synk in från filerna, och läsning ut till intervjun.
 *
 * Ingen funktion här känner till en enda uppdragstyp vid namn. Lägger någon till
 * `catalog/templates/110-migration-till-molnet.json` dyker den upp i katalogen vid nästa
 * start, med sina frågor och sina kriterierader, utan att en rad kod ändras.
 */

export interface GigTemplate {
  id: string;
  key: string;
  layer: TemplateLayer;
  name: string;
  summary: string | null;
  position: number;
}

export interface InterviewQuestion {
  id: string;
  key: string;
  prompt: string;
  helpText: string | null;
  kind: string;
  config: Record<string, unknown>;
  /** Frågetypens JSON Schema för svaret. Skärps av config i domain/gig-answers.ts. */
  answerSchema: Record<string, unknown>;
  options: { key: string; label: string }[];
  required: boolean;
  condition: QuestionCondition | null;
  /** Mallen frågan kom in med — den första, när flera valda typer delar den. */
  templateKey: string;
}

export interface TemplateClause {
  templateKey: string;
  key: string;
  kind: ClauseKind;
  statement: string;
  verification: string | null;
}

export interface GigCatalogSyncResult {
  templates: number;
  questions: number;
  deactivatedTemplates: number;
  deactivatedQuestions: number;
}

/**
 * Bun.SQL ger en jsonb-**kolumn** som sträng men ett jsonb-**uttryck** som objekt
 * (planen §2.2, fallgrop 3). Läsningarna här blandar båda, så vi tar hand om det på
 * ett ställe.
 */
function fromJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

const TEMPLATE_COLUMNS = 'id, key, layer, name, summary, position';

interface TemplateRow {
  id: string;
  key: string;
  layer: TemplateLayer;
  name: string;
  summary: string | null;
  position: number;
}

const toTemplate = (row: TemplateRow): GigTemplate => ({
  id: row.id,
  key: row.key,
  layer: row.layer,
  name: row.name,
  summary: row.summary,
  position: row.position,
});

/**
 * Skriver in katalogen och gör databasen till en spegel av filerna.
 *
 * Allt sker i en transaktion, och tekniken är "släck allt, tänd det som finns kvar":
 * mallar och frågor avaktiveras först och tänds igen av sin egen upsert. Det som
 * försvunnit ur filerna blir därmed inaktivt — aldrig raderat, eftersom lämnade svar
 * pekar på frågorna.
 */
export async function syncGigCatalog(
  sql: SQL,
  catalog?: GigCatalog,
): Promise<GigCatalogSyncResult> {
  const data = catalog ?? (await loadCatalog());

  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO gig_question_kinds ${tx(
        data.kinds.map((kind) => ({
          key: kind.key,
          description: kind.description,
          answer_schema: kind.answerSchema,
        })),
      )}
      ON CONFLICT (key) DO UPDATE
        SET description = EXCLUDED.description, answer_schema = EXCLUDED.answer_schema
    `;

    await tx`UPDATE gig_questions SET active = false WHERE active`;
    await tx`UPDATE gig_templates SET active = false WHERE active`;

    const inserted = (await tx`
      INSERT INTO gig_questions ${tx(
        data.questions.map((question) => ({
          key: question.key,
          prompt: question.prompt,
          help_text: question.helpText,
          kind: question.kind,
          config: question.config,
          active: true,
        })),
      )}
      ON CONFLICT (key) DO UPDATE
        SET prompt = EXCLUDED.prompt, help_text = EXCLUDED.help_text,
            kind = EXCLUDED.kind, config = EXCLUDED.config,
            active = true, updated_at = now()
      RETURNING id, key
    `) as { id: string; key: string }[];

    const questionIds = new Map(inserted.map((row) => [row.key, row.id]));

    const templates = (await tx`
      INSERT INTO gig_templates ${tx(
        data.templates.map((template) => ({
          key: template.key,
          layer: template.layer,
          name: template.name,
          summary: template.summary,
          position: template.position,
          active: true,
        })),
      )}
      ON CONFLICT (key) DO UPDATE
        SET layer = EXCLUDED.layer, name = EXCLUDED.name, summary = EXCLUDED.summary,
            position = EXCLUDED.position, active = true, updated_at = now()
      RETURNING id, key
    `) as { id: string; key: string }[];

    const templateIds = new Map(templates.map((row) => [row.key, row.id]));

    /*
     * Alternativ, frågekopplingar och kriterierader skrivs om i sin helhet i stället
     * för att jämföras rad för rad. De är små, de är ordningsberoende, och de hör till
     * katalogen — ingen annan skriver i dem. Frågorna och mallarna själva står kvar
     * med sina id:n, vilket är det som spelar roll: lämnade svar pekar på frågan.
     */
    await tx`DELETE FROM gig_question_options`;
    await tx`DELETE FROM gig_template_questions`;
    await tx`DELETE FROM gig_template_clauses`;

    const optionRows = data.questions.flatMap((question) =>
      question.options.map((option, index) => ({
        question_id: questionIds.get(question.key) ?? missing('frågan', question.key),
        key: option.key,
        label: option.label,
        position: index,
      })),
    );
    if (optionRows.length > 0) await tx`INSERT INTO gig_question_options ${tx(optionRows)}`;

    const askRows = data.templates.flatMap((template) =>
      template.asks.map((ask) => ({
        template_id: templateIds.get(template.key) ?? missing('mallen', template.key),
        question_id: questionIds.get(ask.questionKey) ?? missing('frågan', ask.questionKey),
        position: ask.position,
        required: ask.required,
        condition: ask.condition,
      })),
    );
    if (askRows.length > 0) await tx`INSERT INTO gig_template_questions ${tx(askRows)}`;

    const clauseRows = data.templates.flatMap((template) =>
      template.clauses.map((clause) => ({
        template_id: templateIds.get(template.key) ?? missing('mallen', template.key),
        key: clause.key,
        kind: clause.kind,
        statement: clause.statement,
        verification: clause.verification,
        position: clause.position,
      })),
    );
    if (clauseRows.length > 0) await tx`INSERT INTO gig_template_clauses ${tx(clauseRows)}`;

    const [counts] = (await tx`
      SELECT
        (SELECT count(*)::int FROM gig_templates WHERE NOT active) AS inactive_templates,
        (SELECT count(*)::int FROM gig_questions WHERE NOT active) AS inactive_questions
    `) as { inactive_templates: number; inactive_questions: number }[];

    return {
      templates: data.templates.length,
      questions: data.questions.length,
      deactivatedTemplates: counts?.inactive_templates ?? 0,
      deactivatedQuestions: counts?.inactive_questions ?? 0,
    };
  });
}

/** Kan bara inträffa om upserten ovan tappat en rad — då är det ett programfel, inte data. */
function missing(what: string, key: string): never {
  throw new Error(`Synken tappade ${what} ${key}.`);
}

export type { CatalogError };

/** Mallarna som går att välja. Basmallen ingår bara om den efterfrågas — den är underförstådd. */
export async function listGigTemplates(
  sql: SQL,
  options: { layer?: TemplateLayer } = {},
): Promise<GigTemplate[]> {
  const layer = options.layer ?? null;

  const rows = (await sql`
    SELECT ${sql.unsafe(TEMPLATE_COLUMNS)}
    FROM gig_templates
    WHERE active
      AND (${layer}::gig_template_layer IS NULL OR layer = ${layer}::gig_template_layer)
    ORDER BY position, key
  `) as TemplateRow[];

  return rows.map(toTemplate);
}

export interface GigTypeSummary extends GigTemplate {
  /** Antal frågor typen lägger till basmallens. */
  questionCount: number;
  /** Antal rader typen bidrar med till kravspecen. */
  criterionCount: number;
}

/** Katalogen som kunden väljer ur (steg 1). Basmallen ingår inte — den gäller alltid. */
export async function listGigTypes(sql: SQL): Promise<GigTypeSummary[]> {
  const rows = (await sql`
    SELECT t.id, t.key, t.layer, t.name, t.summary, t.position,
           (SELECT count(*)::int FROM gig_template_questions tq WHERE tq.template_id = t.id)
             AS question_count,
           (SELECT count(*)::int FROM gig_template_clauses cl WHERE cl.template_id = t.id)
             AS criterion_count
    FROM gig_templates t
    WHERE t.active AND t.layer = 'type'
    ORDER BY t.position, t.key
  `) as (TemplateRow & { question_count: number; criterion_count: number })[];

  return rows.map((row) => ({
    ...toTemplate(row),
    questionCount: row.question_count,
    criterionCount: row.criterion_count,
  }));
}

export async function findTemplatesByKeys(sql: SQL, keys: string[]): Promise<GigTemplate[]> {
  if (keys.length === 0) return [];

  const rows = (await sql`
    SELECT ${sql.unsafe(TEMPLATE_COLUMNS)}
    FROM gig_templates
    WHERE active AND key IN ${sql(keys)}
    ORDER BY position, key
  `) as TemplateRow[];

  return rows.map(toTemplate);
}

/**
 * IN-hjälparen kräver en icke-tom lista (planen §2.2, fallgrop 2). Tom nyckellista
 * betyder "bara basmallen", och den grenen fångas av `layer = 'base'` i frågan.
 */
const orSentinel = (keys: string[]): string[] => (keys.length > 0 ? keys : ['']);

interface InterviewRow {
  id: string;
  key: string;
  prompt: string;
  help_text: string | null;
  kind: string;
  config: unknown;
  answer_schema: unknown;
  options: unknown;
  required: boolean;
  condition: unknown;
  template_key: string;
}

/**
 * Intervjun för de valda typerna: basmallens frågor först, därefter typernas i
 * mallordning. En fråga som flera valda typer delar kommer med **en gång** — det är
 * hela skälet till att frågorna är en egen tabell och inte text i mallen.
 *
 * Vid sammanslagningen gäller: obligatorisk i någon av mallarna ⇒ obligatorisk, och
 * ovillkorad i någon av mallarna ⇒ ovillkorad. Annars vinner den första mallens villkor.
 */
export async function loadInterview(
  sql: SQL,
  typeKeys: string[],
): Promise<InterviewQuestion[]> {
  const rows = (await sql`
    WITH chosen AS (
      SELECT id, key, position
      FROM gig_templates
      WHERE active AND (layer = 'base' OR key IN ${sql(orSentinel(typeKeys))})
    )
    SELECT x.id, x.key, x.prompt, x.help_text, x.kind, x.config, x.answer_schema,
           x.options, x.required, x.condition, x.template_key
    FROM (
      SELECT DISTINCT ON (q.id)
             q.id, q.key, q.prompt, q.help_text, q.kind, q.config,
             k.answer_schema,
             COALESCE((
               SELECT json_agg(json_build_object('key', o.key, 'label', o.label)
                               ORDER BY o.position)
               FROM gig_question_options o WHERE o.question_id = q.id
             ), '[]'::json) AS options,
             bool_or(tq.required) OVER (PARTITION BY q.id) AS required,
             CASE WHEN bool_and(tq.condition IS NOT NULL) OVER (PARTITION BY q.id)
                  THEN tq.condition END AS condition,
             c.key AS template_key,
             c.position AS template_position,
             tq.position AS ask_position
      FROM chosen c
      JOIN gig_template_questions tq ON tq.template_id = c.id
      JOIN gig_questions q ON q.id = tq.question_id AND q.active
      JOIN gig_question_kinds k ON k.key = q.kind
      ORDER BY q.id, c.position, tq.position
    ) x
    ORDER BY x.template_position, x.ask_position, x.key
  `) as InterviewRow[];

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    prompt: row.prompt,
    helpText: row.help_text,
    kind: row.kind,
    config: fromJsonColumn<Record<string, unknown>>(row.config, {}),
    answerSchema: fromJsonColumn<Record<string, unknown>>(row.answer_schema, {}),
    options: fromJsonColumn<{ key: string; label: string }[]>(row.options, []),
    required: row.required,
    condition: fromJsonColumn<QuestionCondition | null>(row.condition, null),
    templateKey: row.template_key,
  }));
}

/**
 * Mallarnas kriterierader för de valda typerna — utkastet kunden får redigera i steg 5.
 * Basmallens minimikrav och villkor följer alltid med.
 */
export async function loadTemplateClauses(
  sql: SQL,
  typeKeys: string[],
): Promise<TemplateClause[]> {
  const rows = (await sql`
    SELECT t.key AS template_key, cl.key, cl.kind, cl.statement, cl.verification
    FROM gig_templates t
    JOIN gig_template_clauses cl ON cl.template_id = t.id
    WHERE t.active AND (t.layer = 'base' OR t.key IN ${sql(orSentinel(typeKeys))})
    ORDER BY t.position, cl.position, cl.key
  `) as {
    template_key: string;
    key: string;
    kind: ClauseKind;
    statement: string;
    verification: string | null;
  }[];

  return rows.map((row) => ({
    templateKey: row.template_key,
    key: row.key,
    kind: row.kind,
    statement: row.statement,
    verification: row.verification,
  }));
}
