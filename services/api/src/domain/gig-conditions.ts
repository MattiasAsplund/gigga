import type { QuestionCondition } from '../catalog/definition.ts';

export type { QuestionCondition };

/** Svaren så här långt i intervjun, per frågenyckel. */
export type AnswerMap = Readonly<Record<string, unknown>>;

const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, i) => item === b[i])
    : a === b;

/**
 * Ska frågan ställas, givet det som redan besvarats?
 *
 * Villkoren ligger som data på mallens fråga (`gig_template_questions.condition`), så
 * ett nytt beroende mellan två frågor är en rad i en katalogfil — inte en gren i koden.
 * Ett obesvarat villkorsstyrande svar döljer frågan: den dyker upp när kunden svarat
 * på den fråga villkoret hänger på.
 */
export function isConditionMet(condition: QuestionCondition | null, answers: AnswerMap): boolean {
  if (!condition) return true;

  const answered = Object.hasOwn(answers, condition.question);
  const value = answers[condition.question];

  if (condition.answered !== undefined) return condition.answered === answered;
  if (!answered) return false;

  if (condition.equals !== undefined) return same(value, condition.equals);
  if (condition.notEquals !== undefined) return !same(value, condition.notEquals);
  if (condition.in !== undefined) return condition.in.some((candidate) => same(value, candidate));

  // Villkor utan jämförelse betyder "frågan är besvarad".
  return true;
}

/** Frågorna som ska ställas just nu, i den ordning de kom in. */
export function visibleQuestions<T extends { condition: QuestionCondition | null }>(
  questions: readonly T[],
  answers: AnswerMap,
): T[] {
  return questions.filter((question) => isConditionMet(question.condition, answers));
}
