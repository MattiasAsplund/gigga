import { Type } from '@sinclair/typebox';
import { MoneySchema, UuidSchema } from './common.ts';

export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 5000;

export const CompensationPrefSchema = Type.Union(
  [Type.Literal('fixed'), Type.Literal('hourly'), Type.Literal('any')],
  {
    description:
      'Vilken ersättningsform köparen helst ser. "any" lämnar valet till anbudsgivaren.',
  },
);

export const RequestStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('awarded'),
  Type.Literal('cancelled'),
]);

export const CreateRequestBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: TITLE_MAX_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: DESCRIPTION_MAX_LENGTH }),
    compensationPref: CompensationPrefSchema,
    budget: Type.Optional(MoneySchema),
    deadlineAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Måste ligga i framtiden. Utelämnas om uppdraget saknar sista datum.',
      }),
    ),
  },
  { additionalProperties: false },
);

export const RequestResponseSchema = Type.Object({
  id: UuidSchema,
  buyerId: UuidSchema,
  title: Type.String(),
  description: Type.String(),
  compensationPref: CompensationPrefSchema,
  budget: Type.Union([MoneySchema, Type.Null()]),
  deadlineAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  status: RequestStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
});
