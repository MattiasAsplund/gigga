import type { SQL } from 'bun';
import type { ClauseKind } from '../catalog/definition.ts';
import { AnswerNotValidError, validateAnswer } from '../domain/gig-answers.ts';
import type { AnswerMap } from '../domain/gig-conditions.ts';
import {
  assessSpec,
  MIN_CRITERIA,
  type Completeness,
  type SpecBlocker,
} from '../domain/spec-completeness.ts';
import {
  findTemplatesByKeys,
  loadInterview,
  loadTemplateClauses,
  type InterviewQuestion,
} from './gig-catalog.ts';

/**
 * Kravspecen för en förfrågan: valda uppdragstyper, svaren på intervjufrågorna och
 * acceptanskriterierna som rader.
 *
 * Allt hänger på en version. En version är utkast tills den publiceras, och därefter
 * oföränderlig — vill kunden ändra öppnas nästa utkast som en kopia. Det är det som gör
 * att ett anbud går att härleda till den lydelse det skrevs mot.
 */

export type SpecVersionStatus = 'draft' | 'published' | 'superseded';
export type CriterionStatus = 'pending' | 'met' | 'failed' | 'waived';
export type CriterionOrigin = 'template' | 'custom';

export interface SpecVersion {
  id: string;
  requestId: string;
  version: number;
  status: SpecVersionStatus;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface SpecAnswer {
  questionId: string;
  questionKey: string;
  prompt: string;
  value: unknown;
  answeredAt: Date;
}

export interface SpecCriterion {
  id: string;
  kind: ClauseKind;
  statement: string;
  verification: string | null;
  position: number;
  origin: CriterionOrigin;
  sourceTemplateKey: string | null;
  sourceClauseKey: string | null;
  status: CriterionStatus;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface RequestSpec {
  version: SpecVersion;
  /** Kundens valda typer. Basmallen står inte här — den gäller alltid. */
  typeKeys: string[];
  answers: SpecAnswer[];
  criteria: SpecCriterion[];
}

export { MIN_CRITERIA };

export class SpecNotDraftError extends Error {
  constructor(specVersionId: string) {
    super(`Version ${specVersionId} är publicerad och kan inte ändras. Öppna nästa utkast.`);
    this.name = 'SpecNotDraftError';
  }
}

export class UnknownGigTypeError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`Okända uppdragstyper: ${keys.join(', ')}.`);
    this.name = 'UnknownGigTypeError';
    this.keys = keys;
  }
}

export class QuestionNotAskedError extends Error {
  readonly questionKey: string;
  constructor(questionKey: string) {
    super(`Frågan ${questionKey} ingår inte i intervjun för de valda typerna.`);
    this.name = 'QuestionNotAskedError';
    this.questionKey = questionKey;
  }
}

export type PublishResult =
  | { published: SpecVersion; blockers?: undefined }
  | { published?: undefined; blockers: SpecBlocker[] };

const VERSION_COLUMNS = 'id, request_id, version, status, created_at, published_at';

interface VersionRow {
  id: string;
  request_id: string;
  version: number;
  status: SpecVersionStatus;
  created_at: Date;
  published_at: Date | null;
}

const toVersion = (row: VersionRow): SpecVersion => ({
  id: row.id,
  requestId: row.request_id,
  version: row.version,
  status: row.status,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

/** jsonb-kolumn ⇒ sträng från Bun.SQL, jsonb-uttryck ⇒ objekt (planen §2.2). */
const parseValue = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

interface CriterionRow {
  id: string;
  kind: ClauseKind;
  statement: string;
  verification: string | null;
  position: number;
  origin: CriterionOrigin;
  source_template_key: string | null;
  source_clause_key: string | null;
  status: CriterionStatus;
  approved_at: Date | null;
  approved_by: string | null;
}

const toCriterion = (row: CriterionRow): SpecCriterion => ({
  id: row.id,
  kind: row.kind,
  statement: row.statement,
  verification: row.verification,
  position: row.position,
  origin: row.origin,
  sourceTemplateKey: row.source_template_key,
  sourceClauseKey: row.source_clause_key,
  status: row.status,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
});

const CRITERION_COLUMNS =
  'id, kind, statement, verification, position, origin, source_template_key, ' +
  'source_clause_key, status, approved_at, approved_by';

async function readSpec(sql: SQL, version: SpecVersion): Promise<RequestSpec> {
  /*
   * Frågorna körs i följd, inte med Promise.all.
   *
   * readSpec anropas både med poolen och med en transaktion, och en transaktion **är**
   * en anslutning: två frågor samtidigt på den låser sig. Felet syns som en förfrågan
   * som aldrig svarar och en rad `idle in transaction` i pg_stat_activity.
   */
  const types = (await sql`
    SELECT t.key
    FROM request_spec_types st
    JOIN gig_templates t ON t.id = st.template_id
    WHERE st.spec_version_id = ${version.id}
    ORDER BY st.position
  `) as { key: string }[];

  const answers = (await sql`
    SELECT question_id, question_key, prompt, value, answered_at
    FROM request_answers
    WHERE spec_version_id = ${version.id}
    ORDER BY answered_at, question_key
  `) as {
    question_id: string;
    question_key: string;
    prompt: string;
    value: unknown;
    answered_at: Date;
  }[];

  const criteria = (await sql`
    SELECT ${sql.unsafe(CRITERION_COLUMNS)}
    FROM request_criteria
    WHERE spec_version_id = ${version.id}
    ORDER BY kind, position
  `) as CriterionRow[];

  return {
    version,
    typeKeys: types.map((row) => row.key),
    answers: answers.map((row) => ({
      questionId: row.question_id,
      questionKey: row.question_key,
      prompt: row.prompt,
      value: parseValue(row.value),
      answeredAt: row.answered_at,
    })),
    criteria: criteria.map(toCriterion),
  };
}

async function findVersion(sql: SQL, id: string, lock = false): Promise<SpecVersion | null> {
  const rows = (await (lock
    ? sql`SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM request_spec_versions WHERE id = ${id} FOR UPDATE`
    : sql`SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM request_spec_versions WHERE id = ${id}`)) as VersionRow[];

  const row = rows[0];
  return row ? toVersion(row) : null;
}

/** Låser versionen och vägrar om den inte längre är ett utkast. */
async function lockDraft(sql: SQL, specVersionId: string): Promise<SpecVersion> {
  const version = await findVersion(sql, specVersionId, true);
  if (!version) throw new Error(`Ingen kravspecversion med id ${specVersionId}.`);
  if (version.status !== 'draft') throw new SpecNotDraftError(specVersionId);
  return version;
}

/**
 * Kriterieutkastet: mallens rader kopieras in som egna rader på versionen. Kopior, inte
 * referenser — en ändring i katalogen får aldrig ändra en kravspec kunden godkänt.
 */
async function seedCriteria(sql: SQL, specVersionId: string, typeKeys: string[]): Promise<void> {
  const clauses = await loadTemplateClauses(sql, typeKeys);
  if (clauses.length === 0) return;

  const positions = new Map<ClauseKind, number>();
  const rows = clauses.map((clause) => {
    const position = positions.get(clause.kind) ?? 0;
    positions.set(clause.kind, position + 1);

    return {
      spec_version_id: specVersionId,
      kind: clause.kind,
      statement: clause.statement,
      verification: clause.verification,
      position,
      origin: 'template',
      source_template_key: clause.templateKey,
      source_clause_key: clause.key,
    };
  });

  await sql`INSERT INTO request_criteria ${sql(rows)}`;
}

/**
 * Öppnar version 1 för en förfrågan: valda typer och ett kriterieutkast ur mallarna.
 * Kunden svarar på frågorna och godkänner raderna innan den går att publicera.
 */
export async function createDraftSpec(
  sql: SQL,
  input: { requestId: string; typeKeys: string[] },
): Promise<RequestSpec> {
  return sql.begin(async (tx) => {
    const templates = await findTemplatesByKeys(tx, input.typeKeys);
    const found = new Set(templates.map((template) => template.key));
    const unknown = input.typeKeys.filter((key) => !found.has(key));
    if (unknown.length > 0) throw new UnknownGigTypeError(unknown);

    const [next] = (await tx`
      SELECT coalesce(max(version), 0) + 1 AS version
      FROM request_spec_versions WHERE request_id = ${input.requestId}
    `) as { version: number }[];

    const rows = (await tx`
      INSERT INTO request_spec_versions (request_id, version)
      VALUES (${input.requestId}, ${next?.version ?? 1})
      RETURNING ${tx.unsafe(VERSION_COLUMNS)}
    `) as VersionRow[];

    const row = rows[0];
    if (!row) throw new Error('INSERT returnerade ingen rad');
    const version = toVersion(row);

    if (templates.length > 0) {
      await tx`
        INSERT INTO request_spec_types ${tx(
          templates.map((template, index) => ({
            spec_version_id: version.id,
            template_id: template.id,
            position: index,
          })),
        )}
      `;
    }

    await seedCriteria(tx, version.id, input.typeKeys);

    return readSpec(tx, version);
  });
}

export async function getSpec(sql: SQL, specVersionId: string): Promise<RequestSpec | null> {
  const version = await findVersion(sql, specVersionId);
  return version ? readSpec(sql, version) : null;
}

async function findByStatus(
  sql: SQL,
  requestId: string,
  status: SpecVersionStatus,
): Promise<RequestSpec | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM request_spec_versions
    WHERE request_id = ${requestId} AND status = ${status}::spec_version_status
  `) as VersionRow[];

  const row = rows[0];
  return row ? readSpec(sql, toVersion(row)) : null;
}

export const findDraftSpec = (sql: SQL, requestId: string): Promise<RequestSpec | null> =>
  findByStatus(sql, requestId, 'draft');

/** Den lydelse anbuden ska avse. Saknas den är förfrågan inte publicerad. */
export const findPublishedSpec = (sql: SQL, requestId: string): Promise<RequestSpec | null> =>
  findByStatus(sql, requestId, 'published');

/** Intervjun för versionens valda typer, med basmallens frågor först. */
export async function loadSpecInterview(
  sql: SQL,
  specVersionId: string,
): Promise<InterviewQuestion[]> {
  const types = (await sql`
    SELECT t.key
    FROM request_spec_types st
    JOIN gig_templates t ON t.id = st.template_id
    WHERE st.spec_version_id = ${specVersionId}
    ORDER BY st.position
  `) as { key: string }[];

  return loadInterview(
    sql,
    types.map((row) => row.key),
  );
}

/**
 * Sparar svaren på ett steg i intervjun.
 *
 * Frågorna måste ingå i intervjun för versionens typer, och värdena måste hålla frågans
 * form — annars vore svarsraden ett löst påstående i en jsonb-kolumn. Hela steget
 * prövas innan något skrivs: halva svar är värre än inga.
 */
export async function saveAnswers(
  sql: SQL,
  input: {
    specVersionId: string;
    answers: { questionKey: string; value: unknown }[];
  },
): Promise<SpecAnswer[]> {
  if (input.answers.length === 0) return [];

  return sql.begin(async (tx) => {
    await lockDraft(tx, input.specVersionId);

    const interview = await loadSpecInterview(tx, input.specVersionId);
    const asked = new Map(interview.map((question) => [question.key, question]));

    const rows = input.answers.map((answer) => {
      const question = asked.get(answer.questionKey);
      if (!question) throw new QuestionNotAskedError(answer.questionKey);

      const issues = validateAnswer(question, answer.value);
      if (issues.length > 0) throw new AnswerNotValidError(question.key, issues);

      return {
        spec_version_id: input.specVersionId,
        question_id: question.id,
        question_key: question.key,
        prompt: question.prompt,
        value: JSON.stringify(answer.value),
      };
    });

    const saved = (await tx`
      INSERT INTO request_answers ${tx(rows)}
      ON CONFLICT (spec_version_id, question_id) DO UPDATE
        SET value = EXCLUDED.value, prompt = EXCLUDED.prompt,
            question_key = EXCLUDED.question_key, answered_at = now()
      RETURNING question_id, question_key, prompt, value, answered_at
    `) as {
      question_id: string;
      question_key: string;
      prompt: string;
      value: unknown;
      answered_at: Date;
    }[];

    return saved.map((row) => ({
      questionId: row.question_id,
      questionKey: row.question_key,
      prompt: row.prompt,
      value: parseValue(row.value),
      answeredAt: row.answered_at,
    }));
  });
}

/** Ett enskilt svar — samma väg, ett steg med en fråga i. */
export async function saveAnswer(
  sql: SQL,
  input: { specVersionId: string; questionKey: string; value: unknown },
): Promise<SpecAnswer> {
  const [saved] = await saveAnswers(sql, {
    specVersionId: input.specVersionId,
    answers: [{ questionKey: input.questionKey, value: input.value }],
  });

  if (!saved) throw new Error('INSERT returnerade ingen rad');
  return saved;
}

/** Kundens egen kriterierad (lager 3). Samma formkrav som de genererade. */
export async function addCriterion(
  sql: SQL,
  input: {
    specVersionId: string;
    kind: ClauseKind;
    statement: string;
    verification?: string | null;
  },
): Promise<SpecCriterion> {
  return sql.begin(async (tx) => {
    await lockDraft(tx, input.specVersionId);

    const rows = (await tx`
      INSERT INTO request_criteria (spec_version_id, kind, statement, verification, position, origin)
      VALUES (${input.specVersionId}, ${input.kind}::gig_clause_kind, ${input.statement},
              ${input.verification ?? null},
              (SELECT coalesce(max(position), -1) + 1 FROM request_criteria
               WHERE spec_version_id = ${input.specVersionId}
                 AND kind = ${input.kind}::gig_clause_kind),
              'custom')
      RETURNING ${tx.unsafe(CRITERION_COLUMNS)}
    `) as CriterionRow[];

    const row = rows[0];
    if (!row) throw new Error('INSERT returnerade ingen rad');
    return toCriterion(row);
  });
}

/**
 * Ändrar lydelsen på en rad. Godkännandet faller: kunden har godkänt en text, inte ett
 * radnummer, och en omskriven rad ska godkännas på nytt.
 */
export async function updateCriterion(
  sql: SQL,
  input: { criterionId: string; statement?: string; verification?: string | null },
): Promise<SpecCriterion | null> {
  return sql.begin(async (tx) => {
    const version = await versionOfCriterion(tx, input.criterionId);
    if (!version) return null;
    if (version.status !== 'draft') throw new SpecNotDraftError(version.id);

    const rows = (await tx`
      UPDATE request_criteria
      SET statement = coalesce(${input.statement ?? null}, statement),
          verification = CASE WHEN ${input.verification !== undefined}
                              THEN ${input.verification ?? null} ELSE verification END,
          approved_at = NULL, approved_by = NULL
      WHERE id = ${input.criterionId}
      RETURNING ${tx.unsafe(CRITERION_COLUMNS)}
    `) as CriterionRow[];

    const row = rows[0];
    return row ? toCriterion(row) : null;
  });
}

/** Kundens aktiva godkännande av lydelsen, tidsstämplat. Ansvarsskyddet i steg 5. */
export async function approveCriterion(
  sql: SQL,
  input: { criterionId: string; userId: string },
): Promise<SpecCriterion | null> {
  return sql.begin(async (tx) => {
    const version = await versionOfCriterion(tx, input.criterionId);
    if (!version) return null;
    if (version.status !== 'draft') throw new SpecNotDraftError(version.id);

    const rows = (await tx`
      UPDATE request_criteria
      SET approved_at = now(), approved_by = ${input.userId}
      WHERE id = ${input.criterionId}
      RETURNING ${tx.unsafe(CRITERION_COLUMNS)}
    `) as CriterionRow[];

    const row = rows[0];
    return row ? toCriterion(row) : null;
  });
}

export async function removeCriterion(sql: SQL, criterionId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const version = await versionOfCriterion(tx, criterionId);
    if (!version) return false;
    if (version.status !== 'draft') throw new SpecNotDraftError(version.id);

    const rows = (await tx`
      DELETE FROM request_criteria WHERE id = ${criterionId} RETURNING id
    `) as { id: string }[];

    return rows.length > 0;
  });
}

/** Vilken förfrågan en kriterierad hör till — routen får inte lita på id:t i vägen. */
export async function findCriterionOwner(
  sql: SQL,
  criterionId: string,
): Promise<{ requestId: string; specVersionId: string } | null> {
  const rows = (await sql`
    SELECT v.request_id, v.id AS spec_version_id
    FROM request_criteria c
    JOIN request_spec_versions v ON v.id = c.spec_version_id
    WHERE c.id = ${criterionId}
  `) as { request_id: string; spec_version_id: string }[];

  const row = rows[0];
  return row ? { requestId: row.request_id, specVersionId: row.spec_version_id } : null;
}

async function versionOfCriterion(sql: SQL, criterionId: string): Promise<SpecVersion | null> {
  const rows = (await sql`
    SELECT v.id, v.request_id, v.version, v.status, v.created_at, v.published_at
    FROM request_criteria c
    JOIN request_spec_versions v ON v.id = c.spec_version_id
    WHERE c.id = ${criterionId}
    FOR UPDATE OF v
  `) as VersionRow[];

  const row = rows[0];
  return row ? toVersion(row) : null;
}

/** Svaren som en uppslagning per frågenyckel — formen villkoren utvärderas mot. */
export const answerMap = (spec: RequestSpec): AnswerMap =>
  Object.fromEntries(spec.answers.map((answer) => [answer.questionKey, answer.value]));

async function assess(sql: SQL, spec: RequestSpec): Promise<Completeness> {
  const interview = await loadInterview(sql, spec.typeKeys);

  return assessSpec({
    typeKeys: spec.typeKeys,
    questions: interview,
    answers: answerMap(spec),
    criteria: spec.criteria,
  });
}

/** Fullständighetsindikatorn för en version — samma räkning som publiceringen gör. */
export async function completenessOf(sql: SQL, spec: RequestSpec): Promise<Completeness> {
  return assess(sql, spec);
}

/**
 * Publiceringskontrollen (steg 6). Blockerarna är rader, inte en klumpsumma — samma
 * princip som kriterierna själva: den som får ett nej ska se exakt vad som fattas.
 *
 * En fråga som är dold av sitt villkor räknas inte som obesvarad. Det är därför
 * villkoren ligger i data: kontrollen behöver inte veta vilka frågor som finns.
 */
export async function publishSpec(sql: SQL, specVersionId: string): Promise<PublishResult> {
  return sql.begin(async (tx) => {
    const version = await lockDraft(tx, specVersionId);
    const spec = await readSpec(tx, version);
    const { blockers } = await assess(tx, spec);

    if (blockers.length > 0) return { blockers };

    // Den tidigare gällande lydelsen blir historik i samma svep — annars skulle det
    // partiella unika indexet fälla den nya.
    await tx`
      UPDATE request_spec_versions SET status = 'superseded'
      WHERE request_id = ${version.requestId} AND status = 'published'
    `;

    const rows = (await tx`
      UPDATE request_spec_versions
      SET status = 'published', published_at = now()
      WHERE id = ${specVersionId}
      RETURNING ${tx.unsafe(VERSION_COLUMNS)}
    `) as VersionRow[];

    const row = rows[0];
    if (!row) throw new Error('UPDATE returnerade ingen rad');
    return { published: toVersion(row) };
  });
}

/**
 * Öppnar nästa utkast som en kopia av den gällande versionen — vägen tillbaka när ett
 * svar under den publika frågefasen ändrar omfattningen (steg 7). Den gällande
 * versionen står kvar tills det nya utkastet publiceras, så anbud kan fortsätta komma
 * in mot en lydelse som inte flyttar sig.
 */
export async function openNextDraft(sql: SQL, requestId: string): Promise<RequestSpec | null> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT ${tx.unsafe(VERSION_COLUMNS)} FROM request_spec_versions
      WHERE request_id = ${requestId} AND status = 'published'
      FOR UPDATE
    `) as VersionRow[];

    const current = rows[0];
    if (!current) return null;

    const [next] = (await tx`
      SELECT coalesce(max(version), 0) + 1 AS version
      FROM request_spec_versions WHERE request_id = ${requestId}
    `) as { version: number }[];

    const created = (await tx`
      INSERT INTO request_spec_versions (request_id, version)
      VALUES (${requestId}, ${next?.version ?? current.version + 1})
      RETURNING ${tx.unsafe(VERSION_COLUMNS)}
    `) as VersionRow[];

    const draft = created[0];
    if (!draft) throw new Error('INSERT returnerade ingen rad');

    await tx`
      INSERT INTO request_spec_types (spec_version_id, template_id, position)
      SELECT ${draft.id}, template_id, position
      FROM request_spec_types WHERE spec_version_id = ${current.id}
    `;

    await tx`
      INSERT INTO request_answers (spec_version_id, question_id, question_key, prompt, value, answered_at)
      SELECT ${draft.id}, question_id, question_key, prompt, value, answered_at
      FROM request_answers WHERE spec_version_id = ${current.id}
    `;

    // Godkännandena följer med: en rad som inte skrivs om är fortfarande godkänd, och
    // updateCriterion nollar godkännandet på den som faktiskt ändras.
    await tx`
      INSERT INTO request_criteria (spec_version_id, kind, statement, verification, position,
                                    origin, source_template_key, source_clause_key, status,
                                    approved_at, approved_by)
      SELECT ${draft.id}, kind, statement, verification, position, origin,
             source_template_key, source_clause_key, status, approved_at, approved_by
      FROM request_criteria WHERE spec_version_id = ${current.id}
    `;

    return readSpec(tx, toVersion(draft));
  });
}
