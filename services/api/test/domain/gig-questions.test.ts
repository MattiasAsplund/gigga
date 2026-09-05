import { test, expect } from 'bun:test';
import {
  answerSchemaFor,
  validateAnswer,
  type AnswerableQuestion,
} from '../../src/domain/gig-answers.ts';
import { isConditionMet, visibleQuestions } from '../../src/domain/gig-conditions.ts';

const question = (over: Partial<AnswerableQuestion> = {}): AnswerableQuestion => ({
  key: 'test.question',
  kind: 'text',
  answerSchema: { type: 'string', minLength: 1, maxLength: 500 },
  config: {},
  options: [],
  ...over,
});

// ---------------------------------------------------------------- AM.1

test('AM.1 ett svar som följer frågetypens schema godtas', () => {
  expect(validateAnswer(question(), 'Fakturasystemet och lönesystemet')).toEqual([]);
});

// ---------------------------------------------------------------- AM.2

test('AM.2 fel typ i svaret avvisas', () => {
  const counted = question({
    kind: 'integer',
    answerSchema: { type: 'integer', minimum: 0 },
  });

  expect(validateAnswer(counted, '5')).toHaveLength(1);
  expect(validateAnswer(counted, 5)).toEqual([]);
});

// ---------------------------------------------------------------- AM.3

test('AM.3 frågans config skärper frågetypens schema', () => {
  const days = question({
    kind: 'integer',
    answerSchema: { type: 'integer', minimum: 0 },
    // default är ett förslag till gränssnittet och ska inte validera bort något.
    config: { minimum: 1, maximum: 20, default: 5 },
  });

  expect(answerSchemaFor(days)).toEqual({ type: 'integer', minimum: 1, maximum: 20 });
  expect(validateAnswer(days, 5)).toEqual([]);
  expect(validateAnswer(days, 21)).toHaveLength(1);
  expect(validateAnswer(days, 0)).toHaveLength(1);
});

// ---------------------------------------------------------------- AM.4

test('AM.4 choice godtar bara frågans egna alternativnycklar', () => {
  const choice = question({
    kind: 'choice',
    answerSchema: { type: 'string', minLength: 1 },
    options: [
      { key: 'queue', label: 'Köa och försöka igen' },
      { key: 'alert', label: 'Larma och stanna' },
    ],
  });

  expect(validateAnswer(choice, 'queue')).toEqual([]);
  expect(validateAnswer(choice, 'kasta')).toHaveLength(1);
});

// ---------------------------------------------------------------- AM.5

test('AM.5 multichoice avvisar okända och upprepade alternativ', () => {
  const browsers = question({
    kind: 'multichoice',
    answerSchema: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
    options: [
      { key: 'chrome', label: 'Chrome' },
      { key: 'firefox', label: 'Firefox' },
    ],
  });

  expect(validateAnswer(browsers, ['chrome', 'firefox'])).toEqual([]);
  expect(validateAnswer(browsers, [])).toHaveLength(1);
  expect(validateAnswer(browsers, ['chrome', 'chrome'])).toHaveLength(1);
  expect(validateAnswer(browsers, ['netscape'])).toHaveLength(1);
});

// ---------------------------------------------------------------- AM.6

test('AM.6 villkoret avgör om frågan ställs', () => {
  expect(isConditionMet({ question: 'base.deployment', equals: 'supplier' }, { 'base.deployment': 'supplier' })).toBe(true);
  expect(isConditionMet({ question: 'base.deployment', equals: 'supplier' }, { 'base.deployment': 'none' })).toBe(false);

  expect(isConditionMet({ question: 'base.deployment', notEquals: 'none' }, { 'base.deployment': 'joint' })).toBe(true);
  expect(isConditionMet({ question: 'base.deployment', notEquals: 'none' }, { 'base.deployment': 'none' })).toBe(false);

  expect(isConditionMet({ question: 'screen.design', in: ['sketch', 'design-system'] }, { 'screen.design': 'sketch' })).toBe(true);
  expect(isConditionMet({ question: 'screen.design', in: ['sketch', 'design-system'] }, { 'screen.design': 'free' })).toBe(false);

  expect(isConditionMet({ question: 'bugfix.existing-tests', answered: true }, { 'bugfix.existing-tests': false })).toBe(true);
  expect(isConditionMet({ question: 'bugfix.existing-tests', answered: true }, {})).toBe(false);
});

// ---------------------------------------------------------------- AM.7

test('AM.7 en fråga utan villkor ställs alltid, även innan något besvarats', () => {
  expect(isConditionMet(null, {})).toBe(true);

  const asked = visibleQuestions(
    [
      { key: 'a', condition: null },
      { key: 'b', condition: { question: 'a', equals: 'ja' } },
    ],
    {},
  );

  expect(asked.map((q) => q.key)).toEqual(['a']);
  expect(
    visibleQuestions(
      [
        { key: 'a', condition: null },
        { key: 'b', condition: { question: 'a', equals: 'ja' } },
      ],
      { a: 'ja' },
    ).map((q) => q.key),
  ).toEqual(['a', 'b']);
});
