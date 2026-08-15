import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

/**
 * Aspire pollar den här för att avgöra när API:et är uppe (withHttpHealthCheck).
 * 200 endast när databasen svarar — annars 503, så att beroende resurser inte startar
 * mot en tjänst som inte kan göra något.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'health',
        tags: ['system'],
        summary: 'Hälsokontroll',
        response: {
          200: Type.Object({ status: Type.Literal('ok'), database: Type.Literal('up') }),
          503: Type.Object({
            status: Type.Literal('degraded'),
            database: Type.Literal('down'),
          }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await app.sql`SELECT 1`;
        return reply.code(200).send({ status: 'ok', database: 'up' } as const);
      } catch (err) {
        app.log.error({ err }, 'health check: databasen svarar inte');
        return reply.code(503).send({ status: 'degraded', database: 'down' } as const);
      }
    },
  );
}
