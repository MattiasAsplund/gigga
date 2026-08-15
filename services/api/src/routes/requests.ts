import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import { CreateRequestBodySchema, RequestResponseSchema } from '../schemas/request.ts';
import { insertRequest, type UppdragsRequest } from '../db/requests.ts';
import { validationFailed } from '../plugins/errors.ts';

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
        budget: budget ?? null,
        deadlineAt: deadline,
      });

      return reply.code(201).send(requestToResponse(created));
    },
  );
};
