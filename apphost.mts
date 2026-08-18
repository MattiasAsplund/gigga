// fastgig AppHost — orkestrerar Postgres och API:et för localhost-utveckling.
// Körs med bun (Aspire väljer bun så länge bun.lock finns i roten).
import { mkdir } from "node:fs/promises";
import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

// Bindmonteringarna nedan pekar hit. Podman skapar inte en monteringskälla som saknas
// utan vägrar starta containern, och outputs/ ligger utanför versionshanteringen — alltså
// finns den inte i ett nytt klon förrän någon kört. Mapparna skapas därför här.
await mkdir(`${import.meta.dirname}/outputs`, { recursive: true });
await mkdir(`${import.meta.dirname}/services/e2e/slides`, { recursive: true });

// Icke-persistent: ingen withDataVolume(), ingen withPersistentLifetime().
// Sessionslivstid => containern rivs vid `aspire stop` och databasen är tom vid varje start.
const postgres = await builder
	.addPostgres("postgres")
	// Aspire fullkvalificerar själv till docker.io/library/... — sätt aldrig registry här,
	// det ger `docker.io/docker.io/library/postgres` och en unauthorized-pull mot podman.
	.withImageTag("17-alpine")
	.withSessionLifetime()
	.withPgWeb();

const db = await postgres.addDatabase("fastgig");

const jwtSecret = await builder.addParameterWithGeneratedValue("jwt-secret", {
	minLength: 48,
});

// Mailpit fångar all utgående post och skickar aldrig vidare. Webbgränssnittet ligger
// som egen URL i dashboarden — det är där verifieringsmailen läses.
//
// Fast port: e2e-sviten läser bekräftelsemailen ur mailpits API från en container, och
// en slumpad port går inte att peka ut därifrån.
const mailpit = await builder
	.addMailPit("mailpit", { httpPort: 8025, smtpPort: 1025 })
	.withSessionLifetime();

// Objektlagring för anbudsdokument. Ingen volym: filerna delar livscykel med databasen,
// och bucketen skapas av API:et vid uppstart eftersom MinIO startar tom.
//
// Uppgifterna genereras som parametrar i stället för att låta MinIO hitta på ett
// lösenord — API:et behöver samma värde, och utan specialtecken slipper vi
// escapning i signeringen.
const minioUser = await builder.addParameterWithGeneratedValue("minio-user", {
	minLength: 12,
	special: false,
});
const minioPassword = await builder.addParameterWithGeneratedValue(
	"minio-password",
	{
		minLength: 24,
		special: false,
	},
);

const minio = await builder
	.addMinioContainer("minio", {
		rootUser: minioUser,
		rootPassword: minioPassword,
	})
	.withSessionLifetime();

// addBunApp kör källfilen direkt — inget bygg- eller transpileringssteg.
const api = await builder
	.addBunApp("api", "./services/api", "src/index.ts")
	.withBun()
	// Levande omladdning: bun startar om API:et när en källfil ändras, utan `aspire stop`.
	// Flaggan måste stå före skriptet (`bun --watch src/index.ts`), och withArgs() lägger
	// bara till sist — då blir den ett argument till programmet i stället. Därför via
	// dev-scriptet i services/api/package.json, som äger ordningen.
	.withRunScript("dev")
	// Fast port av samma skäl som mailpit: webbens proxy och e2e pekar hit.
	.withHttpEndpoint({ env: "PORT", port: 3000 })
	.withEnvironment("DATABASE_URL", await db.uriExpression())
	.withEnvironment("JWT_SECRET", jwtSecret)
	.withEnvironment("SMTP_HOST", await mailpit.host())
	.withEnvironment("SMTP_PORT", await mailpit.port())
	.withEnvironment("S3_ENDPOINT", await minio.uriExpression())
	.withEnvironment("S3_BUCKET", "fastgig-attachments")
	.withEnvironment("S3_ACCESS_KEY_ID", minioUser)
	.withEnvironment("S3_SECRET_ACCESS_KEY", minioPassword)
	// Larmen landar i mailpit tillsammans med all annan post — synliga i dashboarden.
	.withEnvironment("STORAGE_ALERT_EMAIL", "drift@fastgig.dev")
	.withHttpHealthCheck({ path: "/health" })
	.waitFor(db)
	.waitFor(mailpit)
	.waitFor(minio);

/*
 * Gränssnittet. Vite proxar /api vidare till API:et, så webben och API:et delar origin
 * — ingen CORS-konfiguration behövs, och Playwright behöver bara känna till en adress.
 */
const web = await builder
	.addViteApp("web", "./services/web")
	.withBun()
	// isProxied: false — Vite binder porten själv i stället för DCP:s proxy, som bara
	// lyssnar på 127.0.0.1. Det är vad som gör webben nåbar från e2e-containern.
	.withHttpEndpoint({ env: "PORT", port: 5173, isProxied: false })
	.withEnvironment("API_TARGET", "http://localhost:3000")
	.waitFor(api);

// Bekräftelselänkarna pekar på webbens /verify, inte in i API:et — därför webbens
// adress här och inte API:ets. Sätts efter att `web` finns, men bara som ett värde:
// api väntar inte på webben, och webben väntar fortfarande på api.
await api.withEnvironment("PUBLIC_BASE_URL", await web.getEndpoint("http"));

/*
 * E2E-sviten kör i Playwrights egen image, så värdmaskinen slipper både webbläsare och
 * en Playwright-version att hålla i synk.
 *
 * Nätverket: `--network=host` går inte, för Aspire lägger sina containrar på en egen
 * brygga och podman vägrar kombinationen rakt av. Mailpit nås på bryggan medan Aspire
 * skapar en tunnel till webben när e2e refererar den:
 *
 * - **mailpit** är en container på samma bryggnät och svarar på sitt nätverksalias,
 *   på containerporten — inte den publicerade.
 * - **webben** är en process på värden. `withReference(web)` får DCP att skapa en
 *   tunnel på containerbryggan, och endpointreferensen nedan blir tunnelns adress och
 *   port i e2e-containern. Varken en hårdkodad Windows-adress eller
 *   `host.containers.internal` fungerar tillförlitligt med Podman.
 *
 * `:z` på monteringen är inte valfritt på en SELinux-värd: utan omtaggning ger `/e2e`
 * "Permission denied" och npm dör innan Playwright ens startar. Aspires
 * `withBindMount()` kan inte sätta etiketten, så monteringen görs som runtime-argument.
 *
 * withExplicitStart: sviten körs på begäran från dashboarden, inte varje gång
 * `aspire run` startar miljön.
 */
const e2e = await builder
	.addContainer("e2e", "mcr.microsoft.com/playwright:v1.62.1-noble")
	.withContainerRuntimeArgs([
		"-v",
		`${import.meta.dirname}/services/e2e:/e2e:z`,
	])
	.withReference(web)
	.withEnvironment("BASE_URL", await web.getEndpoint("http"))
	.withEnvironment("MAILPIT_URL", "http://mailpit:8025")
	.withEnvironment("CI", "true")
	.withEntrypoint("/bin/sh")
	.withArgs([
		"-c",
		"cd /e2e && npm install --no-audit --no-fund --silent && npx playwright test",
	])
	.withExplicitStart()
	.waitFor(web)
	.waitFor(mailpit);

/*
 * Sviten skriver till services/e2e/slides: en skärmbild per navigering, och två
 * utskrifter av dem — flow.md att läsa och flow.marp att presentera ur. Den här resursen
 * lägger båda i outputs/:
 *
 * - **flow-dokument.pdf** — flow.md genom pandoc. Ingen sida att få plats på, så varje
 *   skärmbild behåller sin höjd och de långa vyerna klipps inte.
 * - **flow.marp** med sina bilder — kopierade som de är. Bildspelet presenteras ur marp,
 *   inte ur en PDF, och marp läser bilderna som grannfiler. Därför följer .png-filerna
 *   med: utan dem renderas decket tomt.
 *
 * Ingen behöver ha vare sig pandoc eller en pdf-motor installerad — bägge kommer med
 * imagen. `pandoc/typst` är pandoc *och* motorn i samma image; ett pandoc utan motor kan
 * inte skriva PDF, så de kan inte skiljas åt i var sin container.
 *
 * typst och inte xelatex, av två skäl. **`pandoc/latex` byggs bara för amd64**, så på en
 * arm64-värd gick den bara att köra under emulering; `pandoc/typst` finns för båda och
 * körs infödd här. Och den är 295 MB mot TeX-byggets flera gigabyte.
 *
 * Teckensnitt behöver ingen konfiguration: typst får med pilarna och å/ä/ö i rubrikerna
 * som de är. Det var för dem den tidigare imagen tvingades till xelatex framför pdflatex.
 *
 * `-implicit_figures` — annars hamnar bildernas alt-text som "Figure 1:" under var och en.
 * Sidformat och marginaler ligger i flow.md:s front matter, satta av slides.ts.
 *
 * **Ordningen är inte godtycklig.** Pandoc lägger sin temporära .typ-fil i arbetskatalogen,
 * och typst letar bilderna relativt *den* filen — inte via `--resource-path`, som bara styr
 * pandocs egen uppslagning. Därför kopieras bilderna först och pandoc körs sedan från
 * /outputs, där de nu ligger. Det gör också att /data kan förbli skrivskyddat: sviten
 * skriver dit, den här resursen läser bara.
 *
 * Städningen först: en körning som ger färre bilder än den förra ska inte lämna kvar
 * gamla. `.gitignore` står kvar — den är mappens enda incheckade fil.
 *
 * Entrypointen byts mot ett skal: imagen startar pandoc direkt, och här är det flera steg.
 *
 * waitForCompletion: körs när sviten är klar, inte när den startar. Resursen får inget
 * withExplicitStart — den ligger och väntar från `aspire run` och gör sitt så fort e2e
 * gått igenom. Vid en andra körning av sviten startas den om från dashboarden.
 */
await builder
	.addContainer("pandoc", "docker.io/pandoc/typst:3.7")
	.withContainerRuntimeArgs([
		// Samma `:z` som e2e-monteringen, och av samma skäl: utan omtaggning ger SELinux
		// "Permission denied". Utskrifterna läses bara, resultatet skrivs.
		"-v",
		`${import.meta.dirname}/services/e2e/slides:/data:z,ro`,
		"-v",
		`${import.meta.dirname}/outputs:/outputs:z`,
	])
	.withEntrypoint("/bin/sh")
	.withArgs([
		"-c",
		[
			"rm -f /outputs/*.pdf /outputs/*.png /outputs/flow.marp",
			"cp /data/flow.marp /data/*.png /outputs/",
			"cd /outputs",
			"pandoc --from=markdown-implicit_figures --pdf-engine=typst" +
				" /data/flow.md --output=flow-dokument.pdf",
		].join(" && "),
	])
	.waitForCompletion(e2e);

await builder.build().run();
