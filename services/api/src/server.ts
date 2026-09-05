import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { SQL } from 'bun';
import { loadConfig, type Config } from './config.ts';
import { createSql } from './db/sql.ts';
import { registerSwagger } from './plugins/swagger.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { createSmtpMailer, type Mailer } from './mail/mailer.ts';
import { createS3ObjectStore, type ObjectStore } from './storage/object-store.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerRateLimit } from './plugins/rate-limit.ts';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { requestRoutes } from './routes/requests.ts';
import { bidRoutes } from './routes/bids.ts';
import { meRoutes } from './routes/me.ts';
import { contractRoutes } from './routes/contracts.ts';
import { permissionRoutes } from './routes/permissions.ts';
import { attachmentRoutes } from './routes/attachments.ts';
import { gigTypeRoutes } from './routes/gig-types.ts';
import { requestSpecRoutes } from './routes/request-specs.ts';
import multipart from '@fastify/multipart';
import { MAX_FILE_BYTES } from './domain/attachments.ts';
import { registerValidation } from './plugins/validation.ts';

export const API_PREFIX = '/api/v1';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    sql: SQL;
    mailer: Mailer;
    objects: ObjectStore;
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
  /** Och en Map i stället för att prata S3. */
  objects?: ObjectStore;
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
  const objects =
    options.objects ??
    createS3ObjectStore({
      endpoint: config.S3_ENDPOINT,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      region: config.S3_REGION,
    });

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Webben proxar /api vidare till API:et, så utan detta ser varje besökare ut att
    // komma från proxyn och skulle dela ett och samma kvottak. Kräver att det som står
    // framför är betrott — huvudet går annars att sätta själv.
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  app.decorate('sql', sql);
  app.decorate('mailer', mailer);
  app.decorate('objects', objects);

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

  // Gränsen sätts här och inte bara i routen: en för stor fil ska avvisas medan den
  // strömmar in, inte efter att hela kroppen lästs in i minnet.
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4 },
  });
  await registerSwagger(app);
  await registerAuth(app);
  await registerRateLimit(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(requestRoutes, { prefix: API_PREFIX });
  await app.register(bidRoutes, { prefix: API_PREFIX });
  await app.register(meRoutes, { prefix: API_PREFIX });
  await app.register(contractRoutes, { prefix: API_PREFIX });
  await app.register(permissionRoutes, { prefix: API_PREFIX });
  await app.register(attachmentRoutes, { prefix: API_PREFIX });
  await app.register(gigTypeRoutes, { prefix: API_PREFIX });
  await app.register(requestSpecRoutes, { prefix: API_PREFIX });

  return app;
}
