import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';
import { CompensationSchema } from './bid.ts';

export const BidIdParamsSchema = Type.Object({ bidId: UuidSchema });

export const ContractStatusSchema = Type.Union([
  Type.Literal('pending_signatures'),
  Type.Literal('active'),
  Type.Literal('void'),
]);

/** De frysta villkoren. Speglar anbudet som det såg ut när avtalet skapades. */
export const ContractTermsSchema = Type.Object({
  bidId: UuidSchema,
  requestId: UuidSchema,
  buyerId: UuidSchema,
  sellerId: UuidSchema,
  requestTitle: Type.String(),
  plan: Type.String(),
  compensation: CompensationSchema,
  estimatedTotalMinor: Type.Integer(),
  frozenAt: Type.String({ format: 'date-time' }),
});

export const ContractResponseSchema = Type.Object({
  contractId: UuidSchema,
  status: ContractStatusSchema,
  buyerSignedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  sellerSignedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  terms: ContractTermsSchema,
});
