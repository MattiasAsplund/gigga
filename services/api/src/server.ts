import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { SQL } from 'bun';
import { loadConfig, type Config } from './config.ts';
import { createSql } from './db/sql.ts';
import { registerSwagger } from './plugins/swagger.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { createSmtpMailer, type Mailer } from './mail/mailer.ts';
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
    mailer: Mailer;
    /** Basadressen som verifieringslänkar byggs på. */
    publicBaseUrl(): string;
  }
}

export type App = Awaited<ReturnType<typeof buildServer>>;

export interface BuildServerOptions {
  config?: Config;
  sql?: SQL;
  /** Testerna skickar in en minnesmailer istället för att prata SMTP. */
  mailer?: Mailer;
}

/**
 * Bygger appen utan att lyssna på någon port — testerna använder app.inject().
 * Inga sidoeffekter utöver att öppna en databasanslutning.
 */
export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const sql = options.sql ?? createSql(config.DATABASE_URL);
  const mailer =
    options.mailer ??
    createSmtpMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT, from: config.MAIL_FROM });

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  app.decorate('sql', sql);
  app.decorate('mailer', mailer);

  // PUBLIC_BASE_URL sätts av AppHosten. Utan den faller vi tillbaka på den port vi
  // faktiskt lyssnar på, så länkarna fungerar även när tjänsten körs för hand.
  app.decorate(
    'publicBaseUrl',
    () => config.PUBLIC_BASE_URL || `http://localhost:${config.PORT}`,
  );

  // Stäng bara anslutningen om vi öppnade den själva; testerna äger sin egen.
  if (!options.sql) {
    app.addHook('onClose', async () => {
      await sql.end();
    });
  }
  if (!options.mailer) {
    app.addHook('onClose', async () => {
      await mailer.close();
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
