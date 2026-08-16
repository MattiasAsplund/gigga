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
//
// Fast port: e2e-sviten läser bekräftelsemailen ur mailpits API från en container, och
// en slumpad port går inte att peka ut därifrån.
const mailpit = await builder
  .addMailPit('mailpit', { httpPort: 8025, smtpPort: 1025 })
  .withSessionLifetime();

// Objektlagring för anbudsdokument. Ingen volym: filerna delar livscykel med databasen,
// och bucketen skapas av API:et vid uppstart eftersom MinIO startar tom.
//
// Uppgifterna genereras som parametrar i stället för att låta MinIO hitta på ett
// lösenord — API:et behöver samma värde, och utan specialtecken slipper vi
// escapning i signeringen.
const minioUser = await builder.addParameterWithGeneratedValue('minio-user', {
  minLength: 12,
  special: false,
});
const minioPassword = await builder.addParameterWithGeneratedValue('minio-password', {
  minLength: 24,
  special: false,
});

const minio = await builder
  .addMinioContainer('minio', { rootUser: minioUser, rootPassword: minioPassword })
  .withSessionLifetime();

// addBunApp kör `bun src/index.ts` direkt — inget bygg- eller transpileringssteg.
const api = await builder
  .addBunApp('api', './services/api', 'src/index.ts')
  .withBun()
  // Fast port av samma skäl som mailpit: webbens proxy och e2e pekar hit.
  .withHttpEndpoint({ env: 'PORT', port: 3000 })
  .withEnvironment('DATABASE_URL', await db.uriExpression())
  .withEnvironment('JWT_SECRET', jwtSecret)
  .withEnvironment('SMTP_HOST', await mailpit.host())
  .withEnvironment('SMTP_PORT', await mailpit.port())
  .withEnvironment('S3_ENDPOINT', await minio.uriExpression())
  .withEnvironment('S3_BUCKET', 'fastgig-attachments')
  .withEnvironment('S3_ACCESS_KEY_ID', minioUser)
  .withEnvironment('S3_SECRET_ACCESS_KEY', minioPassword)
  // Larmen landar i mailpit tillsammans med all annan post — synliga i dashboarden.
  .withEnvironment('STORAGE_ALERT_EMAIL', 'drift@fastgig.dev')
  .withHttpHealthCheck({ path: '/health' })
  .waitFor(db)
  .waitFor(mailpit)
  .waitFor(minio);

// Verifieringslänkarna måste peka på den port Aspire faktiskt tilldelat API:et.
await api.withEnvironment('PUBLIC_BASE_URL', await api.getEndpoint('http'));

/*
 * Gränssnittet. Vite proxar /api vidare till API:et, så webben och API:et delar origin
 * — ingen CORS-konfiguration behövs, och Playwright behöver bara känna till en adress.
 */
const web = await builder
  .addViteApp('web', './services/web')
  .withBun()
  // isProxied: false — Vite binder porten själv i stället för DCP:s proxy, som bara
  // lyssnar på 127.0.0.1. Det är vad som gör webben nåbar från e2e-containern.
  .withHttpEndpoint({ env: 'PORT', port: 5173, isProxied: false })
  .withEnvironment('API_TARGET', 'http://localhost:3000')
  .waitFor(api);

/*
 * E2E-sviten kör i Playwrights egen image, så värdmaskinen slipper både webbläsare och
 * en Playwright-version att hålla i synk.
 *
 * Nätverket: `--network=host` går inte, för Aspire lägger sina containrar på en egen
 * brygga och podman vägrar kombinationen rakt av. De två adresserna når varandra på
 * olika vägar i stället:
 *
 * - **mailpit** är en container på samma bryggnät och svarar på sitt nätverksalias,
 *   på containerporten — inte den publicerade.
 * - **webben** är en process på värden. Aspire publicerar den inte själv utan låter
 *   DCP proxa den, och proxyn lyssnar bara på `127.0.0.1` — dit når ingen brygga.
 *   Därför `isProxied: false` på dess endpoint: Vite binder `0.0.0.0` själv (se
 *   services/web/vite.config.ts) och blir nåbar via host-gateway.
 *
 * `:z` på monteringen är inte valfritt på en SELinux-värd: utan omtaggning ger `/e2e`
 * "Permission denied" och npm dör innan Playwright ens startar. Aspires
 * `withBindMount()` kan inte sätta etiketten, så monteringen görs som runtime-argument.
 *
 * withExplicitStart: sviten körs på begäran från dashboarden, inte varje gång
 * `aspire run` startar miljön.
 */
await builder
  .addContainer('e2e', 'mcr.microsoft.com/playwright:v1.56.0-noble')
  .withContainerRuntimeArgs([
    '--add-host=host.containers.internal:host-gateway',
    '-v',
    `${import.meta.dir}/services/e2e:/e2e:z`,
  ])
  .withEnvironment('BASE_URL', 'http://host.containers.internal:5173')
  .withEnvironment('MAILPIT_URL', 'http://mailpit:8025')
  .withEnvironment('CI', 'true')
  .withEntrypoint('/bin/sh')
  .withArgs(['-c', 'cd /e2e && npm install --no-audit --no-fund --silent && npx playwright test'])
  .withExplicitStart()
  .waitFor(web)
  .waitFor(mailpit);

await builder.build().run();
