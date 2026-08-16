// fastgig AppHost — orkestrerar Postgres och API:et för localhost-utveckling.
// Körs med bun (Aspire väljer bun så länge bun.lock finns i roten).
import { createBuilder } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

// Icke-persistent: ingen withDataVolume(), ingen withPersistentLifetime().
// Sessionslivstid => containern rivs vid `aspire stop` och databasen är tom vid varje start.
const postgres = await builder
  .addPostgres('postgres')
  // Aspire fullkvalificerar själv till docker.io/library/... — sätt aldrig registry här,
  // det ger `docker.io/docker.io/library/postgres` och en unauthorized-pull mot podman.
  .withImageTag('17-alpine')
  .withSessionLifetime()
  .withPgWeb();

const db = await postgres.addDatabase('fastgig');

const jwtSecret = await builder.addParameterWithGeneratedValue('jwt-secret', {
  minLength: 48,
});

// Mailpit fångar all utgående post och skickar aldrig vidare. Webbgränssnittet ligger
// som egen URL i dashboarden — det är där verifieringsmailen läses.
const mailpit = await builder.addMailPit('mailpit').withSessionLifetime();

// addBunApp kör `bun src/index.ts` direkt — inget bygg- eller transpileringssteg.
const api = await builder
  .addBunApp('api', './services/api', 'src/index.ts')
  .withBun()
  .withHttpEndpoint({ env: 'PORT' })
  .withEnvironment('DATABASE_URL', await db.uriExpression())
  .withEnvironment('JWT_SECRET', jwtSecret)
  .withEnvironment('SMTP_HOST', await mailpit.host())
  .withEnvironment('SMTP_PORT', await mailpit.port())
  .withHttpHealthCheck({ path: '/health' })
  .waitFor(db)
  .waitFor(mailpit);

// Verifieringslänkarna måste peka på den port Aspire faktiskt tilldelat API:et.
await api.withEnvironment('PUBLIC_BASE_URL', await api.getEndpoint('http'));

await builder.build().run();
