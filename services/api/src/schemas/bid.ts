import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';

export const PLAN_MAX_LENGTH = 5000;
export const MAX_ESTIMATED_HOURS = 9999.99;

// Ingen `default` här: Ajv applicerar inte defaults inuti anyOf-grenar och fäller
// dessutom schemat i strict mode. Valutan fylls i av koden (domain/money.ts).
const CurrencySchema = Type.Optional(
  Type.String({
    pattern: '^[A-Z]{3}$',
    description: 'ISO 4217, versaler. Utelämnad betyder SEK.',
    examples: ['SEK'],
  }),
);

export const FixedCompensationSchema = Type.Object(
  {
    type: Type.Literal('fixed'),
    amountMinor: Type.Integer({
      minimum: 1,
      description: 'Fast pris i minorenhet (öre) för hela uppdraget.',
    }),
    currency: CurrencySchema,
  },
  { additionalProperties: false, title: 'FixedCompensation' },
);

export const HourlyCompensationSchema = Type.Object(
  {
    type: Type.Literal('hourly'),
    rateMinor: Type.Integer({ minimum: 1, description: 'Timpris i minorenhet (öre).' }),
    estimatedHours: Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_ESTIMATED_HOURS,
      description: 'Uppskattad tidsåtgång, högst två decimaler.',
    }),
    currency: CurrencySchema,
  },
  { additionalProperties: false, title: 'HourlyCompensation' },
);

/**
 * Diskriminerad på `type`, uttryckt som `anyOf` med `const` på diskriminatorn.
 *
 * Inte OpenAPI:s `discriminator`-nyckelord: TypeBox genererar `anyOf` (inte `oneOf`, som
 * Ajv:s discriminator kräver), och nyckelordet fälls dessutom av Ajv:s strict mode
 * — "unknown keyword: discriminator". Att slå av strictSchema globalt för en ren
 * dokumentationsvinst vore fel byte. Valideringen blir densamma.
 *
 * `additionalProperties: false` i varje gren gör att ett fastprisanbud med `rateMinor`
 * faller ut som valideringsfel (F6.3) istället för att tyst ignorera fältet.
 */
export const CompensationSchema = Type.Union(
  [FixedCompensationSchema, HourlyCompensationSchema],
  {
    title: 'Compensation',
    description:
      'Fast pris för hela uppdraget, eller timpris med uppskattad tidsåtgång. ' +
      'Fältet `type` avgör vilken form som gäller.',
  },
);

export const BidStatusSchema = Type.Union([
  Type.Literal('submitted'),
  Type.Literal('withdrawn'),
  Type.Literal('accepted'),
  Type.Literal('rejected'),
]);

export const CreateBidBodySchema = Type.Object(
  {
    plan: Type.String({
      minLength: 1,
      maxLength: PLAN_MAX_LENGTH,
      description: 'Genomförandeplanen — hur säljaren tänker lösa uppdraget.',
    }),
    compensation: CompensationSchema,
  },
  { additionalProperties: false },
);

export const RequestIdParamsSchema = Type.Object({
  requestId: UuidSchema,
});

export const BidResponseSchema = Type.Object({
  id: UuidSchema,
  requestId: UuidSchema,
  sellerId: UuidSchema,
  plan: Type.String(),
  compensation: CompensationSchema,
  estimatedTotalMinor: Type.Integer({
    description:
      'Beräknat totalbelopp i minorenhet. För timanbud rate × timmar, avrundat till hela ören.',
  }),
  status: BidStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
});
