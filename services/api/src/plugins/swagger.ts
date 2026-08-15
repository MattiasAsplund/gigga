import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/**
 * OpenAPI-dokumentet genereras ur route-schemana. Skriv aldrig OpenAPI för hand.
 *   /docs       Swagger UI
 *   /docs/json  OpenAPI 3.1
 */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'fastgig API',
        description:
          'Marknadsplats för distansuppdrag: köpare publicerar uppdragsförfrågningar, ' +
          'säljare lämnar anbud, parterna signerar avtal.',
        version: '0.0.1',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'auth', description: 'Registrering och inloggning' },
        { name: 'requests', description: 'Uppdragsförfrågningar' },
        { name: 'bids', description: 'Anbud' },
        { name: 'contracts', description: 'Avtal och signering' },
        { name: 'me', description: 'Egna förfrågningar och anbud' },
        { name: 'system', description: 'Drift' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
