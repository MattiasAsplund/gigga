import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  BidsQuerySchema,
  MyBidsResponseSchema,
  MyRequestsResponseSchema,
  PageQuerySchema,
} from '../schemas/me.ts';
import { listBuyerRequests, listSellerBids } from '../db/listings.ts';
import { decodeCursor, paginate, DEFAULT_PAGE_SIZE, type Cursor } from '../domain/pagination.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import { requestToResponse } from './requests.ts';
import { validationFailed } from '../plugins/errors.ts';

function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    return decodeCursor(raw);
  } catch {
    throw validationFailed(
      [{ path: 'cursor', message: 'markören går inte att tolka' }],
      'Använd `nextCursor` från föregående svar.',
    );
  }
}

export const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
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
        response: { 200: MyRequestsResponseSchema, 401: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listBuyerRequests(app.sql, req.user.sub, {
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
            sellerDisplayName: bid.sellerDisplayName,
            plan: bid.plan,
            compensation: bid.compensation,
            estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
            status: bid.status,
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
        response: { 200: MyBidsResponseSchema, 401: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listSellerBids(
        app.sql,
        req.user.sub,
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
          contract: bid.contract,
          createdAt: bid.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
};
