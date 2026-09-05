import { isConditionMet, type AnswerMap, type QuestionCondition } from './gig-conditions.ts';

/**
 * Fullständighetsindikatorn och publiceringskontrollen — samma räkning, två användningar.
 *
 * Ren funktion utan databas: kravspecen är publicerbar när varje *synlig* obligatorisk
 * fråga är besvarad, kriterierna är tillräckligt många och godkända, och listan över vad
 * som inte ingår inte är tom. Villkoren avgör vad "synlig" betyder, och de är data — så
 * den här funktionen behöver aldrig veta vilka frågor som finns.
 */

/** Minst så här många acceptanskriterier krävs för att få publicera (steg 6). */
export const MIN_CRITERIA = 3;

export interface AssessableQuestion {
  key: string;
  prompt: string;
  required: boolean;
  condition: QuestionCondition | null;
}

export interface AssessableCriterion {
  id: string;
  kind: string;
  statement: string;
  approvedAt: Date | null;
}

export type BlockerCode =
  | 'no-gig-type'
  | 'unanswered-question'
  | 'too-few-criteria'
  | 'criterion-not-approved'
  | 'no-exclusions';

export interface SpecBlocker {
  code: BlockerCode;
  /** Frågenyckel eller kriterie-id — det klienten ska peka på. Null när bristen är hela listans. */
  path: string | null;
  detail: string;
}

export interface Completeness {
  requiredQuestions: number;
  answeredRequired: number;
  criteria: number;
  approvedCriteria: number;
  publishable: boolean;
  blockers: SpecBlocker[];
}

export function assessSpec(input: {
  typeKeys: readonly string[];
  questions: readonly AssessableQuestion[];
  answers: AnswerMap;
  criteria: readonly AssessableCriterion[];
}): Completeness {
  const blockers: SpecBlocker[] = [];

  if (input.typeKeys.length === 0) {
    blockers.push({
      code: 'no-gig-type',
      path: 'gigTypes',
      detail: 'Välj minst en uppdragstyp. Passar ingen mall finns typen "Övrigt".',
    });
  }

  const required = input.questions.filter(
    (question) => question.required && isConditionMet(question.condition, input.answers),
  );
  const answered = required.filter((question) => Object.hasOwn(input.answers, question.key));

  for (const question of required) {
    if (Object.hasOwn(input.answers, question.key)) continue;
    blockers.push({ code: 'unanswered-question', path: question.key, detail: question.prompt });
  }

  const criteria = input.criteria.filter((criterion) => criterion.kind === 'criterion');
  if (criteria.length < MIN_CRITERIA) {
    blockers.push({
      code: 'too-few-criteria',
      path: 'criteria',
      detail: `Kravspecen behöver minst ${MIN_CRITERIA} acceptanskriterier, har ${criteria.length}.`,
    });
  }

  const approved = criteria.filter((criterion) => criterion.approvedAt !== null);
  for (const criterion of criteria) {
    if (criterion.approvedAt) continue;
    blockers.push({
      code: 'criterion-not-approved',
      path: criterion.id,
      detail: criterion.statement,
    });
  }

  if (!input.criteria.some((criterion) => criterion.kind === 'exclusion')) {
    blockers.push({
      code: 'no-exclusions',
      path: 'criteria',
      detail: 'Listan över vad som inte ingår får inte vara tom.',
    });
  }

  return {
    requiredQuestions: required.length,
    answeredRequired: answered.length,
    criteria: criteria.length,
    approvedCriteria: approved.length,
    publishable: blockers.length === 0,
    blockers,
  };
}
