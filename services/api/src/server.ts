import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { SQL } from 'bun';
import { loadConfig, type Config } from './config.ts';
import { createSql } from './db/sql.ts';
import { registerSwagger } from './plugins/swagger.ts';
import { healthRoutes } from './routes/health.ts';

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

  await registerSwagger(app);
  await app.register(healthRoutes);

  return app;
}
