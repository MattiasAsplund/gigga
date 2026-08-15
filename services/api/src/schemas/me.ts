import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';
import { BidStatusSchema, CompensationSchema } from './bid.ts';
import { RequestResponseSchema } from './request.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../domain/pagination.ts';

const LimitSchema = Type.Integer({
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  default: DEFAULT_PAGE_SIZE,
  description: `Antal poster per sida, högst ${MAX_PAGE_SIZE}.`,
});

const CursorSchema = Type.String({
  minLength: 1,
  description: 'Ogenomskinlig markör från föregående svars `nextCursor`.',
});

export const PageQuerySchema = Type.Object(
  { limit: Type.Optional(LimitSchema), cursor: Type.Optional(CursorSchema) },
  { additionalProperties: false },
);

export const BidsQuerySchema = Type.Object(
  {
    limit: Type.Optional(LimitSchema),
    cursor: Type.Optional(CursorSchema),
    status: Type.Optional(BidStatusSchema),
  },
  { additionalProperties: false },
);

const NextCursorSchema = Type.Union([Type.String(), Type.Null()], {
  description: 'Skickas som `cursor` för nästa sida. `null` när sidan är den sista.',
});

/** Anbud sett från köparens sida, inuti en av dennes förfrågningar. */
export const BidSummarySchema = Type.Object({
  id: UuidSchema,
  sellerId: UuidSchema,
  sellerDisplayName: Type.String(),
  plan: Type.String(),
  compensation: CompensationSchema,
  estimatedTotalMinor: Type.Integer(),
  status: BidStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
});

export const MyRequestsResponseSchema = Type.Object({
  items: Type.Array(
    Type.Intersect([
      RequestResponseSchema,
      Type.Object({ bids: Type.Array(BidSummarySchema) }),
    ]),
  ),
  nextCursor: NextCursorSchema,
});

export const ContractSummarySchema = Type.Object({
  id: UuidSchema,
  status: Type.Union([
    Type.Literal('pending_signatures'),
    Type.Literal('active'),
    Type.Literal('void'),
  ]),
  buyerSigned: Type.Boolean(),
  sellerSigned: Type.Boolean(),
});

/** Anbud sett från säljarens sida, med förfrågans titel och avtalets läge. */
export const MyBidsResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: UuidSchema,
      requestId: UuidSchema,
      requestTitle: Type.String(),
      plan: Type.String(),
      compensation: CompensationSchema,
      estimatedTotalMinor: Type.Integer(),
      status: BidStatusSchema,
      contract: Type.Union([ContractSummarySchema, Type.Null()]),
      createdAt: Type.String({ format: 'date-time' }),
    }),
  ),
  nextCursor: NextCursorSchema,
});
