import { Type } from '@sinclair/typebox';
import { MoneySchema, UuidSchema } from './common.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../domain/pagination.ts';

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

export const CatalogQuerySchema = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
    ),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    compensationPref: Type.Optional(CompensationPrefSchema),
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

/** En förfrågan sedd av någon som letar uppdrag att lämna anbud på. */
export const CatalogItemSchema = Type.Intersect([
  RequestResponseSchema,
  Type.Object({
    buyerDisplayName: Type.String(),
    bidCount: Type.Integer({
      description: 'Antal aktiva anbud. Innehållet i dem lämnas inte ut här.',
    }),
    hasMyBid: Type.Boolean({ description: 'Har anroparen redan ett aktivt anbud?' }),
    canBid: Type.Boolean({
      description:
        'Falskt för egna förfrågningar och när anroparen redan lämnat anbud — ' +
        'sparar ett anrop som ändå skulle ge 403 eller 409.',
    }),
  }),
]);

export const CatalogResponseSchema = Type.Object({
  items: Type.Array(CatalogItemSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
