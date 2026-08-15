import { Type } from '@sinclair/typebox';

/** RFC 9457 Problem Details — samma form på alla felsvar i API:et. */
export const ProblemSchema = Type.Object(
  {
    type: Type.String({
      format: 'uri',
      description: 'Stabil identifierare för feltypen.',
      examples: ['https://fastgig.dev/problems/validation-failed'],
    }),
    title: Type.String({ description: 'Kort, läsbar sammanfattning.' }),
    status: Type.Integer({ description: 'HTTP-statuskoden.' }),
    detail: Type.Optional(Type.String({ description: 'Vad som gick fel i det här fallet.' })),
    errors: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String({ description: 'Fältet som inte höll måttet, t.ex. "password".' }),
          message: Type.String(),
        }),
        { description: 'Fältvisa fel vid valideringsfel.' },
      ),
    ),
  },
  { $id: 'Problem', title: 'Problem', description: 'Felsvar enligt RFC 9457.' },
);

export const UuidSchema = Type.String({ format: 'uuid' });

/** Belopp anges alltid i minorenhet (öre) — aldrig decimaltal. */
export const MoneySchema = Type.Object(
  {
    amountMinor: Type.Integer({
      minimum: 1,
      description: 'Belopp i minorenhet, t.ex. 4500000 för 45 000,00 kr.',
      examples: [4500000],
    }),
    currency: Type.String({
      pattern: '^[A-Z]{3}$',
      default: 'SEK',
      description: 'ISO 4217, versaler.',
    }),
  },
  { additionalProperties: false, $id: 'Money', title: 'Money' },
);
