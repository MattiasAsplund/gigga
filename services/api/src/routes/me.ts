import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  BidsQuerySchema,
  MyBidsResponseSchema,
  MeResponseSchema,
  MyRequestsResponseSchema,
  PageQuerySchema,
} from '../schemas/me.ts';
import {
  listBuyerRequests,
  listSellerBids,
  type ContractSummary,
} from '../db/listings.ts';
import { paginate, DEFAULT_PAGE_SIZE } from '../domain/pagination.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import { requestToResponse } from './requests.ts';
import { parseCursor } from './query.ts';

/** Datum blir ISO-strängar vid gränsen, som överallt annars i svaren. */
export function contractSummaryToResponse(contract: ContractSummary | null) {
  return contract
    ? {
        id: contract.id,
        status: contract.status,
        buyerSignedAt: contract.buyerSignedAt?.toISOString() ?? null,
        sellerSignedAt: contract.sellerSignedAt?.toISOString() ?? null,
      }
    : null;
}

export const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/me',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'getMe',
        tags: ['me'],
        summary: 'Den inloggades identitet och organisation',
        description:
          'Speglingen av Keycloak-kontot, med det lokala id:t som ägarskap jämförs mot. ' +
          'Kontot och organisationen skapas vid första anropet om de inte redan finns.',
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponseSchema, 401: ProblemSchema, 403: ProblemSchema },
      },
    },
    async (req) => ({
      id: req.identity.id,
      email: req.identity.email,
      displayName: req.identity.displayName,
      organization: {
        id: req.identity.organizationId,
        alias: req.identity.organizationAlias,
        name: req.identity.organizationName,
      },
    }),
  );

  app.get(
    '/me/requests',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listMyRequests',
        tags: ['me'],
        summary: 'Lista egna förfrågningar och inlämnade anbud',
        description:
          'Förfrågningar som anroparen har publicerat, nyaste först, var och en med de ' +
          'anbud som lämnats på den.',
        security: [{ bearerAuth: [] }],
        querystring: PageQuerySchema,
        response: { 200: MyRequestsResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listBuyerRequests(app.sql, req.identity.organizationId, {
        limit,
        cursor: parseCursor(req.query.cursor),
      });

      const page = paginate(rows, limit);
      return {
        items: page.items.map((request) => ({
          ...requestToResponse(request),
          bids: request.bids.map((bid) => ({
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
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/me/bids',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listMyBids',
        tags: ['me'],
        summary: 'Lista egna anbud med status',
        description:
          'Anbud som anroparen har lämnat, nyaste först, med förfrågans titel och ' +
          'avtalets signaturläge när ett avtal har påbörjats.',
        security: [{ bearerAuth: [] }],
        querystring: BidsQuerySchema,
        response: { 200: MyBidsResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listSellerBids(
        app.sql,
        req.identity.organizationId,
        { limit, cursor: parseCursor(req.query.cursor) },
        req.query.status ?? null,
      );

      const page = paginate(rows, limit);
      return {
        items: page.items.map((bid) => ({
          id: bid.id,
          requestId: bid.requestId,
          requestTitle: bid.requestTitle,
          plan: bid.plan,
          compensation: bid.compensation,
          estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
          status: bid.status,
          contract: contractSummaryToResponse(bid.contract),
          createdAt: bid.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
};
