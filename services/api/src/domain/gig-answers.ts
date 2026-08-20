import Ajv, { type ValidateFunction } from 'ajv';

/**
 * Validering av ett svar mot frågans egen form.
 *
 * Schemat sätts ihop av tre delar, alla ur databasen: frågetypens `answer_schema`,
 * frågans `config` (som skärper det — maxLength, minimum, maximum) och frågans
 * alternativ (som blir en `enum`). Därför behöver en ny fråga aldrig en ny gren här,
 * och en ny frågetyp bara en rad i `catalog/question-kinds.json`.
 */

export interface AnswerableQuestion {
  key: string;
  kind: string;
  /** JSON Schema från frågetypen. */
  answerSchema: Record<string, unknown>;
  config: Record<string, unknown>;
  options: { key: string; label: string }[];
}

/** `default` är ett förslag till gränssnittet, inte en regel — det ska inte validera. */
const NOT_A_CONSTRAINT = new Set(['default', 'placeholder', 'unit']);

/** Frågetypens schema, skärpt med frågans egen config och alternativlista. */
export function answerSchemaFor(question: AnswerableQuestion): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...question.answerSchema };

  for (const [key, value] of Object.entries(question.config)) {
    if (!NOT_A_CONSTRAINT.has(key)) schema[key] = value;
  }

  if (question.options.length > 0) {
    const keys = question.options.map((option) => option.key);
    if (schema['type'] === 'array') {
      schema['items'] = { ...(schema['items'] as object), enum: keys };
    } else {
      schema['enum'] = keys;
    }
  }

  return schema;
}

/**
 * Ajv och inte TypeBox: schemana kommer ur databasen som vanlig JSON Schema, och
 * TypeBox `Value` kräver sina egna symboler på schemaobjektet. Ajv finns redan i
 * processen — Fastify validerar sina routes med den.
 */
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(question: AnswerableQuestion): ValidateFunction {
  const schema = answerSchemaFor(question);
  const cacheKey = `${question.key}:${JSON.stringify(schema)}`;

  let validate = compiled.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(cacheKey, validate);
  }
  return validate;
}

/** Tomma listan betyder giltigt svar. Annars en rad per brott, i klartext. */
export function validateAnswer(question: AnswerableQuestion, value: unknown): string[] {
  const validate = validatorFor(question);
  if (validate(value)) return [];

  return (validate.errors ?? []).map((error) => {
    const where = error.instancePath ? `${error.instancePath} ` : '';
    return `${where}${error.message ?? 'ogiltigt värde'}`.trim();
  });
}

/** Fel när ett svar inte håller frågans form. Bär brotten, inte bara ett besked. */
export class AnswerNotValidError extends Error {
  readonly questionKey: string;
  readonly issues: string[];

  constructor(questionKey: string, issues: string[]) {
    super(`Svaret på ${questionKey} duger inte: ${issues.join('; ')}`);
    this.name = 'AnswerNotValidError';
    this.questionKey = questionKey;
    this.issues = issues;
  }
}
