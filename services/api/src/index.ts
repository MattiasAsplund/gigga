import { buildServer } from './server.ts';
import { migrate } from './db/migrate.ts';
import { sweepOrphanedObjects } from './storage/sweeper.ts';

const app = await buildServer();

// Databasen är icke-persistent, så schemat byggs upp vid varje start. Idempotent.
const applied = await migrate(app.sql);
if (applied.length > 0) app.log.info({ applied }, 'migrationer applicerade');

// MinIO startar tom vid varje `aspire run`, så bucketen skapas här.
await app.objects.ensureReady();

/*
 * Sopjobbet för föräldralösa objekt.
 *
 * Ligger här och inte i buildServer: en timer hör till processen, inte till appen, och
 * testerna ska aldrig få en bakgrundstråd på köpet. `unref` gör att den inte håller
 * processen vid liv vid nedstängning.
 */
const sweepMinutes = app.config.ORPHAN_SWEEP_INTERVAL_MINUTES;
if (sweepMinutes > 0) {
  const sweep = async () => {
    try {
      const result = await sweepOrphanedObjects(app.sql, app.objects);
      if (result.deleted > 0 || result.skippedReason) {
        app.log.info({ ...result }, 'städning av föräldralösa objekt');
      }
    } catch (err) {
      // Ett misslyckat sopjobb får aldrig fälla tjänsten — skräpet ligger kvar
      // till nästa varv.
      app.log.error({ err }, 'städningen misslyckades');
    }
  };

  setInterval(sweep, sweepMinutes * 60 * 1000).unref();
}

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
