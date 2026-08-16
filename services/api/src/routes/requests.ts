import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  CatalogQuerySchema,
  CatalogResponseSchema,
  CreateRequestBodySchema,
  RequestResponseSchema,
} from '../schemas/request.ts';
import { insertRequest, type UppdragsRequest } from '../db/requests.ts';
import { listOpenRequests } from '../db/listings.ts';
import { paginate, DEFAULT_PAGE_SIZE } from '../domain/pagination.ts';
import { parseCursor } from './query.ts';
import { validationFailed } from '../plugins/errors.ts';
import { currencyOr } from '../domain/money.ts';

/** Domänobjekt → JSON. Datum som ISO-strängar, belopp som heltal. */
export function requestToResponse(request: UppdragsRequest) {
  return {
    id: request.id,
    buyerId: request.buyerId,
    title: request.title,
    description: request.description,
    compensationPref: request.compensationPref,
    budget: request.budget,
    deadlineAt: request.deadlineAt?.toISOString() ?? null,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
  };
}

export const requestRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/requests',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listOpenRequests',
        tags: ['requests'],
        summary: 'Lista öppna förfrågningar',
        description:
          'Uppdrag som går att lämna anbud på: status `open` och deadline inte passerad. ' +
          'Anbudens innehåll lämnas inte ut — bara hur många som finns, och om anroparen ' +
          'är en av dem.',
        security: [{ bearerAuth: [] }],
        querystring: CatalogQuerySchema,
        response: { 200: CatalogResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const rows = await listOpenRequests(
        app.sql,
        req.user.sub,
        { limit, cursor: parseCursor(req.query.cursor) },
        req.query.compensationPref ?? null,
      );

      const page = paginate(rows, limit);
      return {
        items: page.items.map((request) => ({
          ...requestToResponse(request),
          buyerDisplayName: request.buyerDisplayName,
          bidCount: request.bidCount,
          hasMyBid: request.hasMyBid,
          // Egen förfrågan ger 403 och ett andra anbud 409 — säg det direkt istället.
          canBid: !request.hasMyBid && request.buyerId !== req.user.sub,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    '/requests',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'createRequest',
        tags: ['requests'],
        summary: 'Registrera förfrågan',
        description:
          'Publicerar en uppdragsförfrågan. Anroparen blir köpare för förfrågan. ' +
          'Allt arbete förmedlas på distans.',
        security: [{ bearerAuth: [] }],
        body: CreateRequestBodySchema,
        response: {
          201: RequestResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const { title, description, compensationPref, budget, deadlineAt } = req.body;

      // Schemat kan inte uttrycka "i framtiden" — den regeln bor här.
      const deadline = deadlineAt ? new Date(deadlineAt) : null;
      if (deadline && deadline.getTime() <= Date.now()) {
        throw validationFailed([
          { path: 'deadlineAt', message: 'måste ligga i framtiden' },
        ]);
      }

      const created = await insertRequest(app.sql, {
        buyerId: req.user.sub,
        title,
        description,
        compensationPref,
        budget: budget
          ? { amountMinor: budget.amountMinor, currency: currencyOr(budget.currency) }
          : null,
        deadlineAt: deadline,
      });

      return reply.code(201).send(requestToResponse(created));
    },
  );
};
