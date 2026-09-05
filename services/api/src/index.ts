import { buildServer } from './server.ts';
import { migrate } from './db/migrate.ts';
import { syncGigCatalog } from './db/gig-catalog.ts';
import { runStorageSweep } from './storage/sweep-job.ts';

const app = await buildServer();

// Databasen är icke-persistent, så schemat byggs upp vid varje start. Idempotent.
const applied = await migrate(app.sql);
if (applied.length > 0) app.log.info({ applied }, 'migrationer applicerade');

// Acceptansmallarna är data under catalog/ och speglas in vid varje start. En ny
// uppdragstyp kräver därmed en fil och en omstart, inte en kodändring.
const catalog = await syncGigCatalog(app.sql);
app.log.info(catalog, 'acceptansmallar synkade');

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
      const { marked, ...result } = await runStorageSweep({
        sql: app.sql,
        objects: app.objects,
        mailer: app.mailer,
        alertEmail: app.config.STORAGE_ALERT_EMAIL,
      });

      // Ett markerat dokument betyder att lagringen tappat data — det är ett fel,
      // inte en notis, oavsett om larmet gick fram.
      if (result.markedMissing > 0) {
        app.log.error({ ...result }, 'innehåll saknas för anbudsdokument');
      } else if (result.deleted > 0 || result.restored > 0 || result.skippedReason) {
        app.log.info({ ...result }, 'städning av objektlagringen');
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
