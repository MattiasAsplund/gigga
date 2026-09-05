import { Type, type Static } from '@sinclair/typebox';

/**
 * Formatet på katalogfilerna under `services/api/catalog/`.
 *
 * Scheman, inte handskrivna kontroller: en trasig katalogfil ska fällas vid inläsningen
 * med filnamn och fältpekare, inte bli ett obegripligt fel långt senare. Katalogen är
 * det enda stället nya uppdragstyper och frågor tillkommer, så felmeddelandet där är
 * gränssnittet mot den som skriver dem.
 */

/** Nycklar är stabila identifierare i data — de får inte se ut hur som helst. */
const KeySchema = Type.String({
  pattern: '^[a-z0-9]+([.-][a-z0-9]+)*$',
  minLength: 2,
  maxLength: 80,
});

/**
 * Villkorslogiken. Ett villkor pekar ut en annan fråga och jämför med dess svar;
 * utan villkor ställs frågan alltid.
 */
export const ConditionSchema = Type.Object(
  {
    question: KeySchema,
    equals: Type.Optional(Type.Unknown()),
    notEquals: Type.Optional(Type.Unknown()),
    in: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1 })),
    answered: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type QuestionCondition = Static<typeof ConditionSchema>;

const OptionSchema = Type.Object(
  { key: KeySchema, label: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** En fråga som definieras här och nu. Samma form oavsett vilken fil den står i. */
const QuestionDefinitionSchema = Type.Object(
  {
    key: KeySchema,
    prompt: Type.String({ minLength: 1 }),
    help: Type.Optional(Type.String({ minLength: 1 })),
    kind: KeySchema,
    /** Skärper frågetypens schema: maxLength, minimum, maximum, default. */
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    options: Type.Optional(Type.Array(OptionSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);

/** Medlemskapet: samma fråga kan vara obligatorisk i en mall och villkorad i en annan. */
const MembershipSchema = Type.Object({
  required: Type.Optional(Type.Boolean()),
  condition: Type.Optional(ConditionSchema),
});

/** En rad i en malls `asks`: antingen en fråga som definieras på plats … */
const InlineAskSchema = Type.Composite([QuestionDefinitionSchema, MembershipSchema], {
  additionalProperties: false,
});

/** … eller en hänvisning till en fråga som definierats någon annanstans. */
const RefAskSchema = Type.Composite(
  [Type.Object({ ref: KeySchema }), MembershipSchema],
  { additionalProperties: false },
);

const AskSchema = Type.Union([RefAskSchema, InlineAskSchema]);

const ClauseSchema = Type.Object(
  {
    key: KeySchema,
    kind: Type.Union([
      Type.Literal('criterion'),
      Type.Literal('minimum'),
      Type.Literal('exclusion'),
      Type.Literal('term'),
    ]),
    statement: Type.String({ minLength: 1 }),
    verification: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const TemplateFileSchema = Type.Object(
  {
    key: KeySchema,
    layer: Type.Union([Type.Literal('base'), Type.Literal('type')]),
    name: Type.String({ minLength: 1 }),
    summary: Type.Optional(Type.String({ minLength: 1 })),
    position: Type.Integer({ minimum: 0 }),
    asks: Type.Array(AskSchema),
    clauses: Type.Optional(Type.Array(ClauseSchema)),
  },
  { additionalProperties: false },
);

export const QuestionFileSchema = Type.Object(
  { questions: Type.Array(QuestionDefinitionSchema, { minItems: 1 }) },
  { additionalProperties: false },
);

export const KindFileSchema = Type.Object(
  {
    kinds: Type.Array(
      Type.Object(
        {
          key: KeySchema,
          description: Type.String({ minLength: 1 }),
          /** JSON Schema för svarets värde. Se src/domain/gig-answers.ts. */
          answerSchema: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export type TemplateFile = Static<typeof TemplateFileSchema>;
export type QuestionFile = Static<typeof QuestionFileSchema>;
export type KindFile = Static<typeof KindFileSchema>;
export type ClauseKind = Static<typeof ClauseSchema>['kind'];
export type TemplateLayer = 'base' | 'type';

/* Formen katalogen har när den lästs in — nycklarna upplösta, ordningen fastställd. */

export interface CatalogKind {
  key: string;
  description: string;
  answerSchema: Record<string, unknown>;
}

export interface CatalogQuestion {
  key: string;
  prompt: string;
  helpText: string | null;
  kind: string;
  config: Record<string, unknown>;
  options: { key: string; label: string }[];
}

export interface CatalogAsk {
  questionKey: string;
  position: number;
  required: boolean;
  condition: QuestionCondition | null;
}

export interface CatalogClause {
  key: string;
  kind: ClauseKind;
  statement: string;
  verification: string | null;
  position: number;
}

export interface CatalogTemplate {
  key: string;
  layer: TemplateLayer;
  name: string;
  summary: string | null;
  position: number;
  asks: CatalogAsk[];
  clauses: CatalogClause[];
}

export interface GigCatalog {
  kinds: CatalogKind[];
  questions: CatalogQuestion[];
  templates: CatalogTemplate[];
}
