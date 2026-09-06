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

export const ContractSummarySchema = Type.Object({
  id: UuidSchema,
  status: Type.Union([
    Type.Literal('pending_signatures'),
    Type.Literal('active'),
    Type.Literal('void'),
  ]),
  buyerSignedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  sellerSignedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

/** Anbud sett från köparens sida, inuti en av dennes förfrågningar. */
/**
 * Den inloggades egen identitet, som gigga känner den.
 *
 * Finns för att `sub` i Keycloaks token *inte* är `users.id`. Gränssnittet jämför
 * ägarskap mot id:n ur API:ets egna svar, och behöver därför fråga vem det är som är
 * inloggad istället för att som förr läsa det ur token.
 */
export const MeResponseSchema = Type.Object({
  id: UuidSchema,
  email: Type.String({ format: 'email' }),
  displayName: Type.String(),
  organization: Type.Object({
    id: UuidSchema,
    alias: Type.String(),
    name: Type.String(),
  }),
});

export const BidSummarySchema = Type.Object({
  id: UuidSchema,
  sellerId: UuidSchema,
  sellerOrganizationId: UuidSchema,
  sellerDisplayName: Type.String(),
  plan: Type.String(),
  compensation: CompensationSchema,
  estimatedTotalMinor: Type.Integer(),
  status: BidStatusSchema,
  /**
   * Avtalets läge, eller null när inget avtal finns. Fältet finns alltid: utan det kan
   * köparens sida inte skilja "inget avtal" från "vet inte", och en köpare som signerat
   * och laddar om möts av att avtalet aldrig påbörjats.
   */
  contract: Type.Union([ContractSummarySchema, Type.Null()]),
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
