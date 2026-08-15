import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  BidResponseSchema,
  CreateBidBodySchema,
  RequestIdParamsSchema,
} from '../schemas/bid.ts';
import { findRequestById } from '../db/requests.ts';
import { insertBid, type Bid } from '../db/bids.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import { currencyOr } from '../domain/money.ts';
import { bidExists, ownRequest, requestNotFound, validationFailed } from '../plugins/errors.ts';

export function bidToResponse(bid: Bid) {
  return {
    id: bid.id,
    requestId: bid.requestId,
    sellerId: bid.sellerId,
    plan: bid.plan,
    compensation: bid.compensation,
    estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
    status: bid.status,
    createdAt: bid.createdAt.toISOString(),
  };
}

export const bidRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/requests/:requestId/bids',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'createBid',
        tags: ['bids'],
        summary: 'Registrera anbud',
        description:
          'Lämnar ett anbud med genomförandeplan och ersättningsform på en öppen ' +
          'förfrågan. En säljare kan ha ett aktivt anbud per förfrågan.',
        security: [{ bearerAuth: [] }],
        params: RequestIdParamsSchema,
        body: CreateBidBodySchema,
        response: {
          201: BidResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const request = await findRequestById(app.sql, req.params.requestId);
      if (!request) throw requestNotFound();

      // Ordningen är medveten: vem du är avgörs före förfrågans tillstånd, så en köpare
      // aldrig får veta något om sin egen förfrågan via en annan felkod.
      if (request.buyerId === req.user.sub) throw ownRequest();

      if (request.status !== 'open') {
        throw validationFailed(
          [{ path: 'status', message: `förfrågan är ${request.status}, inte open` }],
          'Förfrågan tar inte emot anbud längre.',
        );
      }

      if (request.deadlineAt && request.deadlineAt.getTime() <= Date.now()) {
        throw validationFailed(
          [{ path: 'deadlineAt', message: 'sista anbudsdag har passerat' }],
          'Förfrågans deadline har passerat.',
        );
      }

      const bid = await insertBid(app.sql, {
        requestId: request.id,
        sellerId: req.user.sub,
        plan: req.body.plan,
        compensation: {
          ...req.body.compensation,
          currency: currencyOr(req.body.compensation.currency),
        },
      });

      if (!bid) throw bidExists();

      return reply.code(201).send(bidToResponse(bid));
    },
  );
};
