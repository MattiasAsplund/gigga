import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  GrantPermissionBodySchema,
  PermissionListResponseSchema,
  PermissionParamsSchema,
  PermissionResponseSchema,
  RequestDetailResponseSchema,
  RequestIdParamsSchema,
  RevokePermissionResponseSchema,
} from '../schemas/permission.ts';
import { findRequestById } from '../db/requests.ts';
import { findUserByEmail } from '../db/users.ts';
import {
  grantReadPermission,
  hasReadPermission,
  listRequestPermissions,
  revokeReadPermission,
  type RequestPermission,
} from '../db/permissions.ts';
import { listBidsForRequest } from '../db/listings.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import { requestToResponse } from './requests.ts';
import {
  noRequestAccess,
  notRequestOwner,
  permissionNotFound,
  requestNotFound,
  userNotFound,
  validationFailed,
} from '../plugins/errors.ts';

function permissionToResponse(permission: RequestPermission) {
  return {
    requestId: permission.requestId,
    userId: permission.userId,
    email: permission.email,
    displayName: permission.displayName,
    level: permission.level,
    grantedAt: permission.grantedAt.toISOString(),
  };
}

export const permissionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Hämtar förfrågan och kräver att anroparen äger den. Används av rättighets-
   * hanteringen, som bara ägaren får röra.
   */
  async function requireOwnedRequest(requestId: string, userId: string) {
    const request = await findRequestById(app.sql, requestId);
    if (!request) throw requestNotFound();
    if (request.buyerId !== userId) throw notRequestOwner();
    return request;
  }

  app.get(
    '/requests/:requestId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'getRequest',
        tags: ['requests'],
        summary: 'Läs en förfrågan med dess anbud',
        description:
          'Öppen för förfrågans köpare och för den som tilldelats läsrätt. Andra får 403 ' +
          '— katalogen (`GET /requests`) är vägen in för den som letar uppdrag.',
        security: [{ bearerAuth: [] }],
        params: RequestIdParamsSchema,
        response: {
          200: RequestDetailResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      const request = await findRequestById(app.sql, req.params.requestId);
      if (!request) throw requestNotFound();

      const allowed =
        request.buyerId === req.user.sub ||
        (await hasReadPermission(app.sql, {
          requestId: request.id,
          userId: req.user.sub,
        }));
      if (!allowed) throw noRequestAccess();

      const bids = await listBidsForRequest(app.sql, request.id);

      return {
        ...requestToResponse(request),
        bids: bids.map((bid) => ({
          id: bid.id,
          sellerId: bid.sellerId,
          sellerDisplayName: bid.sellerDisplayName,
          plan: bid.plan,
          compensation: bid.compensation,
          estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
          status: bid.status,
          createdAt: bid.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/requests/:requestId/permissions',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'grantRequestPermission',
        tags: ['permissions'],
        summary: 'Ge en användare läsrätt till förfrågan',
        description:
          'Tilldelas med e-postadress. Idempotent: en upprepad tilldelning ger 200 och ' +
          'rör inte tidpunkten. Bara förfrågans köpare får tilldela.',
        security: [{ bearerAuth: [] }],
        params: RequestIdParamsSchema,
        body: GrantPermissionBodySchema,
        response: {
          200: PermissionResponseSchema,
          201: PermissionResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireOwnedRequest(req.params.requestId, req.user.sub);

      const grantee = await findUserByEmail(app.sql, req.body.email);
      if (!grantee) throw userNotFound();

      if (grantee.id === req.user.sub) {
        throw validationFailed(
          [{ path: 'email', message: 'du äger redan förfrågan' }],
          'Köparen behöver ingen tilldelad läsrätt till sin egen förfrågan.',
        );
      }

      const { permission, created } = await grantReadPermission(app.sql, {
        requestId: req.params.requestId,
        userId: grantee.id,
        grantedBy: req.user.sub,
      });

      return reply.code(created ? 201 : 200).send(permissionToResponse(permission));
    },
  );

  app.get(
    '/requests/:requestId/permissions',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listRequestPermissions',
        tags: ['permissions'],
        summary: 'Lista tilldelade rättigheter',
        description: 'Bara förfrågans köpare ser vilka som fått läsa.',
        security: [{ bearerAuth: [] }],
        params: RequestIdParamsSchema,
        response: {
          200: PermissionListResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.user.sub);

      const items = await listRequestPermissions(app.sql, req.params.requestId);
      return { items: items.map(permissionToResponse) };
    },
  );

  app.delete(
    '/requests/:requestId/permissions/:userId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'revokeRequestPermission',
        tags: ['permissions'],
        summary: 'Ta tillbaka läsrätt',
        description: 'Stänger åtkomsten omedelbart — nästa anrop från användaren nekas.',
        security: [{ bearerAuth: [] }],
        params: PermissionParamsSchema,
        response: {
          200: RevokePermissionResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.user.sub);

      const revoked = await revokeReadPermission(app.sql, {
        requestId: req.params.requestId,
        userId: req.params.userId,
      });
      if (!revoked) throw permissionNotFound();

      return { revoked: true };
    },
  );
};
