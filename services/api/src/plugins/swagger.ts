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
        title: 'gigga API',
        description:
          'Marknadsplats för distansuppdrag: köpare publicerar uppdragsförfrågningar, ' +
          'säljare lämnar anbud, parterna signerar avtal.',
        version: '0.0.1',
      },
      components: {
        securitySchemes: {
          // Tokens utfärdas av Keycloak, inte av gigga. Schemat är oförändrat http/bearer
          // — det är fortfarande en JWT i Authorization-huvudet — men den hämtas genom
          // inloggningen i webben och klistras in här.
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access-token från Keycloak-realmet fastgig. Hämtas genom att logga in i ' +
              'webbgränssnittet; API:et utfärdar inga egna tokens.',
          },
        },
      },
      tags: [
        { name: 'requests', description: 'Uppdragsförfrågningar' },
        { name: 'bids', description: 'Anbud' },
        { name: 'contracts', description: 'Avtal och signering' },
        { name: 'me', description: 'Egen identitet, organisationens förfrågningar och anbud' },
        { name: 'system', description: 'Drift' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
