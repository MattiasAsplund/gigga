import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';

/**
 * Scheman för acceptansmallarna och kravspecen.
 *
 * Frågornas *innehåll* är data i katalogen — scheman här beskriver bara formen på en
 * fråga, aldrig vilka frågor som finns. En ny uppdragstyp syns i API:et utan att något
 * i den här filen ändras.
 */

export const ClauseKindSchema = Type.Union(
  [
    Type.Literal('criterion'),
    Type.Literal('minimum'),
    Type.Literal('exclusion'),
    Type.Literal('term'),
  ],
  {
    description:
      '`criterion` acceptanskriterium, `minimum` alltid gällande minimikrav, ' +
      '`exclusion` sådant som inte ingår, `term` villkor som klockstopp och garanti.',
  },
);

export const QuestionOptionSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
});

export const QuestionConditionSchema = Type.Object(
  {
    question: Type.String({ description: 'Frågan villkoret hänger på.' }),
    equals: Type.Optional(Type.Unknown()),
    notEquals: Type.Optional(Type.Unknown()),
    in: Type.Optional(Type.Array(Type.Unknown())),
    answered: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    description: 'Villkoret som avgör om frågan ska ställas. Null betyder alltid.',
  },
);

export const InterviewQuestionSchema = Type.Object({
  key: Type.String(),
  prompt: Type.String(),
  helpText: Type.Union([Type.String(), Type.Null()]),
  kind: Type.String({
    description: 'Frågetypen: text, longtext, choice, multichoice, bool, integer eller date.',
  }),
  options: Type.Array(QuestionOptionSchema, {
    description: 'Alternativen för choice och multichoice. Tom för övriga frågetyper.',
  }),
  config: Type.Record(Type.String(), Type.Unknown(), {
    description: 'Frågans egna gränser: minimum, maximum, maxLength, default.',
  }),
  required: Type.Boolean(),
  condition: Type.Union([QuestionConditionSchema, Type.Null()]),
  templateKey: Type.String({
    description: 'Mallen frågan kom in med — den första, när flera valda typer delar den.',
  }),
});

export const TemplateClauseSchema = Type.Object({
  templateKey: Type.String(),
  key: Type.String(),
  kind: ClauseKindSchema,
  statement: Type.String(),
  verification: Type.Union([Type.String(), Type.Null()]),
});

export const GigTypeSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  summary: Type.Union([Type.String(), Type.Null()]),
  questionCount: Type.Integer({ description: 'Antal frågor typen lägger till basmallens.' }),
  criterionCount: Type.Integer({ description: 'Antal rader typen bidrar med till kravspecen.' }),
});

export const GigTypeListResponseSchema = Type.Object({
  items: Type.Array(GigTypeSchema),
});

export const InterviewQuerySchema = Type.Object(
  {
    types: Type.Optional(
      Type.String({
        description:
          'Valda uppdragstyper som kommaseparerade nycklar, t.ex. ' +
          '`data-migration,automation`. Basmallens frågor följer alltid med.',
      }),
    ),
  },
  { additionalProperties: false },
);

export const InterviewResponseSchema = Type.Object({
  types: Type.Array(Type.Object({ key: Type.String(), name: Type.String() })),
  questions: Type.Array(InterviewQuestionSchema),
  clauses: Type.Array(TemplateClauseSchema, {
    description: 'Utkastet till kriterier, minimikrav och ingår-inte som typerna bidrar med.',
  }),
});

/* ---------------------------------------------------------------- kravspecen */

export const SpecVersionSchema = Type.Object({
  id: UuidSchema,
  version: Type.Integer(),
  status: Type.Union([
    Type.Literal('draft'),
    Type.Literal('published'),
    Type.Literal('superseded'),
  ]),
  createdAt: Type.String({ format: 'date-time' }),
  publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const SpecAnswerSchema = Type.Object({
  questionKey: Type.String(),
  prompt: Type.String({ description: 'Frågan som den löd när svaret lämnades.' }),
  value: Type.Unknown(),
  answeredAt: Type.String({ format: 'date-time' }),
});

export const SpecCriterionSchema = Type.Object({
  id: UuidSchema,
  kind: ClauseKindSchema,
  statement: Type.String(),
  verification: Type.Union([Type.String(), Type.Null()]),
  position: Type.Integer(),
  origin: Type.Union([Type.Literal('template'), Type.Literal('custom')]),
  sourceTemplateKey: Type.Union([Type.String(), Type.Null()]),
  sourceClauseKey: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('met'),
    Type.Literal('failed'),
    Type.Literal('waived'),
  ]),
  approvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  approvedBy: Type.Union([UuidSchema, Type.Null()]),
});

export const CompletenessSchema = Type.Object(
  {
    requiredQuestions: Type.Integer(),
    answeredRequired: Type.Integer(),
    criteria: Type.Integer(),
    approvedCriteria: Type.Integer(),
    publishable: Type.Boolean(),
    blockers: Type.Array(
      Type.Object({
        code: Type.String(),
        path: Type.Union([Type.String(), Type.Null()]),
        detail: Type.String(),
      }),
    ),
  },
  {
    description:
      'Fullständighetsindikatorn: vad som återstår innan kravspecen får publiceras. ' +
      'Samma räkning som publiceringen gör.',
  },
);

/** Frågan som den ser ut mitt i intervjun: med villkoret utvärderat mot lämnade svar. */
export const SpecQuestionSchema = Type.Intersect([
  InterviewQuestionSchema,
  Type.Object({
    visible: Type.Boolean({ description: 'Falskt när frågans villkor inte är uppfyllt.' }),
    answered: Type.Boolean(),
  }),
]);

export const SpecResponseSchema = Type.Object({
  requestId: UuidSchema,
  version: SpecVersionSchema,
  gigTypes: Type.Array(Type.Object({ key: Type.String(), name: Type.String() })),
  questions: Type.Array(SpecQuestionSchema),
  answers: Type.Array(SpecAnswerSchema),
  criteria: Type.Array(SpecCriterionSchema),
  completeness: CompletenessSchema,
});

export const OpenSpecBodySchema = Type.Object(
  {
    gigTypes: Type.Array(Type.String({ minLength: 2 }), {
      minItems: 1,
      description:
        'Nycklarna ur `GET /gig-types`. Flera får väljas — frågorna slås ihop och ' +
        'dubbletterna faller bort.',
    }),
  },
  { additionalProperties: false },
);

export const SaveAnswersBodySchema = Type.Object(
  {
    answers: Type.Array(
      Type.Object(
        { questionKey: Type.String({ minLength: 1 }), value: Type.Unknown() },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  {
    additionalProperties: false,
    description:
      'Ett steg i intervjun. Hela steget prövas mot frågornas form innan något sparas.',
  },
);

export const SaveAnswersResponseSchema = Type.Object({
  answers: Type.Array(SpecAnswerSchema),
  completeness: CompletenessSchema,
});

export const AddCriterionBodySchema = Type.Object(
  {
    kind: ClauseKindSchema,
    statement: Type.String({
      minLength: 10,
      maxLength: 1000,
      description:
        'Skrivs som "När <förutsättning>, ska <observerbart utfall>". En rad som inte ' +
        'går att svara ja eller nej på är inte ett kriterium.',
    }),
    verification: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const ChangeCriterionBodySchema = Type.Object(
  {
    statement: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
    verification: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const RemoveCriterionResponseSchema = Type.Object({ removed: Type.Boolean() });

export const SpecParamsSchema = Type.Object({ requestId: UuidSchema });

export const CriterionParamsSchema = Type.Object({
  requestId: UuidSchema,
  criterionId: UuidSchema,
});
