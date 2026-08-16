import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';
import { RequestResponseSchema } from './request.ts';
import { BidSummarySchema } from './me.ts';

export const PermissionLevelSchema = Type.Union([Type.Literal('read')], {
  description: 'Endast läsrätt så länge. Kolumnen finns för framtida nivåer.',
});

export const GrantPermissionBodySchema = Type.Object(
  {
    email: Type.String({
      format: 'email',
      description: 'Adressen till den som ska få läsa. Måste tillhöra ett konto.',
    }),
  },
  { additionalProperties: false },
);

export const PermissionResponseSchema = Type.Object({
  requestId: UuidSchema,
  userId: UuidSchema,
  email: Type.String(),
  displayName: Type.String(),
  level: PermissionLevelSchema,
  grantedAt: Type.String({ format: 'date-time' }),
});

export const PermissionListResponseSchema = Type.Object({
  items: Type.Array(PermissionResponseSchema),
});

export const RevokePermissionResponseSchema = Type.Object({
  revoked: Type.Boolean(),
});

export const RequestIdParamsSchema = Type.Object({ requestId: UuidSchema });

export const PermissionParamsSchema = Type.Object({
  requestId: UuidSchema,
  userId: UuidSchema,
});

/** Förfrågan som den ser ut för köparen eller någon med läsrätt: med sina anbud. */
export const RequestDetailResponseSchema = Type.Intersect([
  RequestResponseSchema,
  Type.Object({ bids: Type.Array(BidSummarySchema) }),
]);
