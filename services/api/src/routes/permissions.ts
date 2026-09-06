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
import { contractSummaryToResponse } from './me.ts';
import {
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
   * Hämtar förfrågan och kräver att anroparens *organisation* äger den. Används av
   * rättighetshanteringen, som bara köparsidan får röra.
   *
   * Ägarskapet ligger på företaget, inte på personen som råkade trycka på knappen: den
   * som är sjuk ska kunna ersättas av en kollega utan att förfrågan blir oåtkomlig.
   */
  async function requireOwnedRequest(requestId: string, organizationId: string) {
    const request = await findRequestById(app.sql, requestId);
    if (!request) throw requestNotFound();
    if (request.buyerOrganizationId !== organizationId) throw notRequestOwner();
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
          'Öppen för alla inloggade — en säljare måste kunna läsa förfrågan för att kunna ' +
          'lämna anbud på den. Anbuden i svaret är däremot begränsade: förfrågans köpare ' +
          'och den som tilldelats läsrätt ser alla, en säljare bara sitt eget.',
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

      // Vem som bjudit vad är en sak mellan köparen och respektive säljare (samma regel
      // som L8.7 vaktar i katalogen). Köparen och den med läsrätt ser alla anbud; för
      // alla andra begränsas listan till anroparens eget.
      //
      // Köparens organisation ser allt genom medlemskapet — det är vad som gör en
      // kollega användbar utan att någon först måste dela ut något. Tilldelad läsrätt
      // gäller därutöver en enskild person, och är därmed vägen *över* företagsgränsen.
      const seesAllBids =
        request.buyerOrganizationId === req.identity.organizationId ||
        (await hasReadPermission(app.sql, {
          requestId: request.id,
          userId: req.identity.id,
        }));

      const allBids = await listBidsForRequest(app.sql, request.id);
      const bids = seesAllBids
        ? allBids
        : allBids.filter((bid) => bid.sellerOrganizationId === req.identity.organizationId);

      return {
        ...requestToResponse(request),
        bids: bids.map((bid) => ({
          id: bid.id,
          sellerId: bid.sellerId,
          sellerOrganizationId: bid.sellerOrganizationId,
          sellerDisplayName: bid.sellerDisplayName,
          plan: bid.plan,
          compensation: bid.compensation,
          estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
          status: bid.status,
          contract: contractSummaryToResponse(bid.contract),
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
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);

      const grantee = await findUserByEmail(app.sql, req.body.email);
      if (!grantee) throw userNotFound();

      // Kollegan har redan läsrätt genom medlemskapet, och en tilldelning som inte
      // betyder något vore värre än ett fel: den ser ut att ha gjort någonting.
      if (grantee.organizationId === req.identity.organizationId) {
        throw validationFailed(
          [{ path: 'email', message: 'tillhör redan förfrågans organisation' }],
          'Alla i köparens organisation läser förfrågan redan genom sitt medlemskap.',
        );
      }

      const { permission, created } = await grantReadPermission(app.sql, {
        requestId: req.params.requestId,
        userId: grantee.id,
        grantedBy: req.identity.id,
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
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);

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
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);

      const revoked = await revokeReadPermission(app.sql, {
        requestId: req.params.requestId,
        userId: req.params.userId,
      });
      if (!revoked) throw permissionNotFound();

      return { revoked: true };
    },
  );
};
