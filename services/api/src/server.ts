import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { SQL } from 'bun';
import { loadConfig, type Config } from './config.ts';
import { createSql } from './db/sql.ts';
import { registerSwagger } from './plugins/swagger.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { registerAuth } from './plugins/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { requestRoutes } from './routes/requests.ts';
import { bidRoutes } from './routes/bids.ts';
import { meRoutes } from './routes/me.ts';
import { contractRoutes } from './routes/contracts.ts';
import { registerValidation } from './plugins/validation.ts';

export const API_PREFIX = '/api/v1';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    sql: SQL;
  }
}

export type App = Awaited<ReturnType<typeof buildServer>>;

export interface BuildServerOptions {
  config?: Config;
  sql?: SQL;
}

/**
 * Bygger appen utan att lyssna på någon port — testerna använder app.inject().
 * Inga sidoeffekter utöver att öppna en databasanslutning.
 */
export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const sql = options.sql ?? createSql(config.DATABASE_URL);

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  app.decorate('sql', sql);

  // Stäng bara anslutningen om vi öppnade den själva; testerna äger sin egen.
  if (!options.sql) {
    app.addHook('onClose', async () => {
      await sql.end();
    });
  }

  registerValidation(app);
  registerErrorHandling(app);
  await registerSwagger(app);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(requestRoutes, { prefix: API_PREFIX });
  await app.register(bidRoutes, { prefix: API_PREFIX });
  await app.register(meRoutes, { prefix: API_PREFIX });
  await app.register(contractRoutes, { prefix: API_PREFIX });

  return app;
}
