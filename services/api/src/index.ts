import { buildServer } from './server.ts';
import { migrate } from './db/migrate.ts';

const app = await buildServer();

// Databasen är icke-persistent, så schemat byggs upp vid varje start. Idempotent.
const applied = await migrate(app.sql);
if (applied.length > 0) app.log.info({ applied }, 'migrationer applicerade');

// MinIO startar tom vid varje `aspire run`, så bucketen skapas här.
await app.objects.ensureReady();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} mottagen, stänger ned`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: app.config.PORT, host: app.config.HOST });
} catch (err) {
  app.log.fatal({ err }, 'kunde inte starta');
  process.exit(1);
}
