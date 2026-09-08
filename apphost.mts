// gigga AppHost — orkestrerar Postgres och API:et för localhost-utveckling.
// Körs med bun (Aspire väljer bun så länge bun.lock finns i roten).
import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
	createBuilder,
	EndpointProperty,
	ImagePullPolicy,
	refExpr,
	type ResourceUrlsCallbackContext,
} from "./.aspire/modules/aspire.mjs";

// --enable-cloudflare, satt av `bun run dev-cloudflare`, avgör om tunnelresurserna längre
// ned finns med.
//
// Flaggan läses ur två källor, och den andra är inte överflödig: Aspire CLI 13.4.6 skickar
// *inte* vidare argumenten efter `--` till en TypeScript-AppHost. CLI-loggen visar vad som
// verkligen startas — `bun run apphost.mts`, utan argument. (Vidarebefordran gäller
// .NET-AppHosts, som får dem via `dotnet run --`.) Det som däremot når hit är
// npm_lifecycle_script: bun sätter den till hela raden ur package.json innan aspire
// startas, och den ärvs ned till AppHost-processen.
//
// process.argv läses ändå först. Den bär flaggan om AppHosten körs för hand
// (`bun apphost.mts --enable-cloudflare`), och den dagen CLI:t börjar skicka vidare
// argumenten är det den vägen som gäller.
const hostArgs = process.argv.slice(2);
const invocation = [
	...hostArgs,
	...(process.env.npm_lifecycle_script ?? "").split(/\s+/),
];
const cloudflareEnabled = invocation.includes("--enable-cloudflare");

// Flaggan plockas bort innan argumenten går vidare till Aspire: värdens
// konfigurationsläsare läser `--nyckel värde` och skulle annars sluka nästa argument som
// flaggans värde.
const builder = await createBuilder({
	args: hostArgs.filter((arg) => arg !== "--enable-cloudflare"),
});

// Bindmonteringarna nedan pekar hit. Podman skapar inte en monteringskälla som saknas
// utan vägrar starta containern, och outputs/ ligger utanför versionshanteringen — alltså
// finns den inte i ett nytt klon förrän någon kört. Mapparna skapas därför här.
await mkdir(`${import.meta.dirname}/outputs`, { recursive: true });
await mkdir(`${import.meta.dirname}/services/e2e/slides`, { recursive: true });

/*
 * Cloudflare-tunnlar — bara med --enable-cloudflare, alltså `bun run dev-cloudflare`.
 *
 * Två snabbtunnlar utan Cloudflare-konto: en framför webben och en framför mailpit, så
 * att både gränssnittet och breven går att visa upp från en annan maskin utan
 * brandväggsöppning.
 *
 * withPersistentLifetime: processerna hör inte till sessionen utan lever kvar över
 * `aspire stop`, och nästa `aspire run` återanvänder dem. Adressen på trycloudflare.com
 * lottas fram när tunneln kopplar upp — det är långlivade processer som gör att en
 * utdelad länk fortsätter fungera över en omstart av miljön. Baksidan är att `aspire stop`
 * inte stänger dem: det gör dashboarden, eller `pkill cloudflared`.
 *
 * Ordningen är inte kosmetisk: tunnlarna deklareras före resurserna de går till. Aspire
 * bygger en resurs i taget, och miljö- och URL-callbackarna längst ned i filen väntar in
 * tunnelns adress medan kön står still. Deklarerade sist hamnar cloudflared i kö bakom
 * precis de callbacks som väntar på den — uppmätt startade processen först drygt tre
 * minuter in, långt efter att väntan gett upp.
 *
 * --metrics står inte i cloudflareds exempel men behövs här. Adressen skrivs bara ut i
 * cloudflareds egen logg, och den går inte att läsa härifrån: Aspires API kan tömma en
 * resurslogg, inte prenumerera på raderna. Metrics-servern svarar däremot på
 * /quicktunnel med värdnamnet som JSON, på en port vi själva väljer — och portarna är
 * fasta av samma skäl som mailpits: en lottad port går inte att fråga.
 */
const WEB_TUNNEL_METRICS_PORT = 20241;
const MAIL_TUNNEL_METRICS_PORT = 20242;

/*
 * Två tidsgränser, och skillnaden mellan dem är hela poängen.
 *
 * En callback som väntar håller upp *hela* startkön — Aspire bygger resursernas specar i
 * tur och ordning, och där ingår starten av cloudflared. Väntar api:s callback på en
 * tunnel som står i kö bakom den själv står de och stirrar på varandra tills tidsgränsen
 * går ut. (Uppmätt: cloudflared startade i samma sekund som väntan gav upp.) Callbackarna
 * väntar därför bara kort — det räcker för en tunnel som redan lever sedan förra körningen
 * — och efterspelet längst ned tar hand om kallstarten, utanför kön.
 */
const CALLBACK_TIMEOUT_MS = 12_000;
const COLD_START_TIMEOUT_MS = 180_000;

const tunnels = cloudflareEnabled ? await addCloudflareTunnels() : null;

async function addCloudflareTunnels() {
	const web = await builder
		.addExecutable("tunnel-web", "cloudflared", ".", [
			"tunnel",
			"--url",
			"http://localhost:5173",
			"--metrics",
			`127.0.0.1:${WEB_TUNNEL_METRICS_PORT}`,
		])
		// Metrics-porten som endpoint: det är den hälsokontrollen nedan frågar. /ready svarar
		// 200 först när tunneln har en registrerad anslutning, alltså när den går att besöka.
		// isProxied: false — cloudflared binder porten själv, DCP ska inte lägga sig emellan.
		.withHttpEndpoint({
			name: "metrics",
			port: WEB_TUNNEL_METRICS_PORT,
			isProxied: false,
		})
		.withHttpHealthCheck({ endpointName: "metrics", path: "/ready" })
		.withPersistentLifetime();

	const mail = await builder
		.addExecutable("tunnel-mail", "cloudflared", ".", [
			"tunnel",
			"--url",
			"http://localhost:8025",
			"--metrics",
			`127.0.0.1:${MAIL_TUNNEL_METRICS_PORT}`,
		])
		.withHttpEndpoint({
			name: "metrics",
			port: MAIL_TUNNEL_METRICS_PORT,
			isProxied: false,
		})
		.withHttpHealthCheck({ endpointName: "metrics", path: "/ready" })
		.withPersistentLifetime();

	return { web, mail };
}

// Icke-persistent: ingen withDataVolume(), ingen withPersistentLifetime().
// Sessionslivstid => containern rivs vid `aspire stop` och databasen är tom vid varje start.
const postgres = await builder
	.addPostgres("postgres")
	// Aspire fullkvalificerar själv till docker.io/library/... — sätt aldrig registry här,
	// det ger `docker.io/docker.io/library/postgres` och en unauthorized-pull mot podman.
	.withImageTag("17-alpine")
	.withSessionLifetime()
	.withPgWeb();

const db = await postgres.addDatabase("gigga");

/*
 * Databaser åt folkid och pkc, de två systertjänsterna längre ned. Samma server, samma
 * sessionslivstid — tomma vid varje start, och tjänsterna migrerar dem själva.
 *
 * Resursnamnen har suffixet -db för att inte krocka med tjänsteresurserna pkc och
 * folkid — Aspire kräver unika namn över alla resurstyper.
 *
 * pkc: resursen heter pkc-db, men databasen heter pks. Det är inte ett val utan en
 * anpassning: pkc:s scripts/migrate.ts kör `ALTER DATABASE pks SET search_path ...` med
 * namnet hårdkodat vid varje serverstart. Mot en databas med annat namn faller
 * migreringen på "database pks does not exist" och servern går ned med den. Den dag
 * skriptet läser namnet ur DATABASE_URL kan databaseName strykas.
 *
 * folkid-db har ännu ingen som fyller den: folkid-containern längre ned skriver sin logg
 * i sqlite inne i containern och talar med pkc över HTTP. Databasen finns för det steg
 * som kommer.
 */
const pkcDb = await postgres.addDatabase("pkc-db", { databaseName: "pks" });
await postgres.addDatabase("folkid-db");

// Mailpit fångar all utgående post och skickar aldrig vidare. Webbgränssnittet ligger
// som egen URL i dashboarden — det är där verifieringsmailen läses.
//
// Fast http-port: e2e-sviten läser bekräftelsemailen ur mailpits API från en container,
// och en slumpad port går inte att peka ut därifrån. Smtp-porten lottas — alla som
// skickar post (api, keycloak, folkid) får den som referens och behöver inget fast tal.
const mailpit = await builder
	.addMailPit("mailpit", { httpPort: 8025 })
	.withSessionLifetime();

/*
 * Keycloak äger konton, lösenord, e-postbekräftelse och sessioner. API:et utfärdar inga
 * egna tokens längre — det verifierar Keycloaks mot realmets JWKS.
 *
 * Realmet är data, inte klick i en adminkonsol: keycloak/realm/gigga-realm.json bär
 * klienterna, organisationerna, SMTP-inställningarna och verifieringskravet. Importen
 * körs vid varje start, vilket passar en miljö där databasen ändå är tom varje gång.
 *
 * `organization` — singular. Verifierat genom att gå på det: `organizations` avvisas med
 * "unrecognized feature" och realmet startar utan organisationsstöd.
 *
 * KC_HTTP_RELATIVE_PATH: Keycloak ligger under /auth på *webbens* origin, proxad av Vite
 * precis som /api. Det är vad som gör att issuern följer med av sig själv — Keycloak
 * bygger den ur Host-huvudet, så localhost, e2e-containerns bryggadress och en
 * cloudflare-tunnel ger var sin korrekta issuer utan konfiguration per miljö. Utan det
 * hade tokenens `iss` pekat på en adress webbläsaren inte kunde nå.
 *
 * KC_PROXY_HEADERS: bakom tunneln är det X-Forwarded-Proto som bär https. Utan detta
 * byggs issuern med http och matchar inte den adress användaren faktiskt kom in på.
 *
 * Lottad port, av samma skäl som API:et fick det: en fast port gör resursen ohälsosam så
 * fort något annat redan sitter där, och hälsokontrollen frågar då en tjänst som inte är
 * vår. Det hände på riktigt här — en typst-server på 8080 gjorde keycloak Unhealthy och
 * höll api och web kvar i Waiting. Ingen behöver porten fast: webben proxar dit via
 * KEYCLOAK_TARGET, en referens, och API:et går aldrig hit alls utan hämtar nycklarna
 * från issuern, alltså genom webbens adress.
 */
/*
 * Fast adminkonto, inte ett lottat.
 *
 * Inbjudan är enda vägen in i en organisation sedan självregistreringen stängdes, och den
 * skickas av en admin. Med ett genererat lösenord måste det slås upp i dashboarden varje
 * gång miljön startas om — och e2e-sviten kunde bara nå det för att AppHosten råkade
 * skicka med det. Ett känt konto gör inbjudningarna körbara både för hand och i sviten.
 *
 * Att uppgifterna står i klartext i en incheckad fil är avsiktligt och gäller **bara den
 * här utvecklingsmiljön**: Keycloak lever på localhost, är icke-persistent och rivs vid
 * `aspire stop`. En driftsatt miljö sätter dem som hemligheter.
 */
const keycloakUser = await builder.addParameter("keycloak-user", {
	value: "admin",
});
const keycloakPassword = await builder.addParameter("keycloak-password", {
	value: "admin",
	secret: true,
});

const keycloak = await builder
	.addKeycloak("keycloak", {
		adminUsername: keycloakUser,
		adminPassword: keycloakPassword,
	})
	.withEnabledFeatures(["organization"])
	.withEnvironment("KC_HTTP_RELATIVE_PATH", "/auth")
	.withEnvironment("KC_PROXY_HEADERS", "xforwarded")
	// Managementgränssnittet ärver annars den relativa sökvägen ovan, och hälsokontrollen
	// hamnar på /auth/health/ready medan Aspire frågar /health/ready. Resursen blir
	// Unhealthy fast servern är uppe, och allt som väntar på den står kvar i Waiting.
	.withEnvironment("KC_HTTP_MANAGEMENT_RELATIVE_PATH", "/")
	.withRealmImport("./keycloak/realm")
	.withSessionLifetime()
	.waitFor(mailpit);

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

/*
 * pkc — nyckeltjänsten ur systerkatalogen bredvid det här klonet. Imagen byggs ur dess
 * egen Dockerfile; sökvägen är relativ AppHost-katalogen, så klonen ska ligga i
 * ../asplund-software/. Migreringarna kör servern själv vid start (scripts/migrate.ts),
 * så inget separat installationssteg behövs — tjänsten väntar bara in databasen.
 *
 * HOST 0.0.0.0: pkc:s standard binder loopback, och då når varken hälsokontrollen eller
 * folkid fram. Porten är Dockerfilens EXPOSE 3001; DCP lottar värdsidan.
 */
const pkc = await builder
	.addDockerfile("pkc", "../asplund-software/public_key_catalogue")
	.withEnvironment("HOST", "0.0.0.0")
	.withEnvironment("PORT", "3001")
	.withEnvironment("DATABASE_URL", await pkcDb.uriExpression())
	.withHttpEndpoint({ targetPort: 3001 })
	.withHttpHealthCheck({ path: "/health" })
	.waitFor(pkcDb);

/*
 * Valkey åt folkid. Backenden kopplar upp sig vid start (connectValkey i server.ts) och
 * går ned utan den, så containern är inte valfri. En vanlig addContainer: Aspire har
 * ingen Valkey-integration i den här modulen, och en plain container har ingen
 * anslutningssträng — adressen sätts ihop för hand i REDIS_URL nedan.
 *
 * Endpointen är tcp, inte http: hälsokontrollen nedan gäller folkid, inte Valkey.
 */
const valkey = await builder
	.addContainer("valkey", "docker.io/valkey/valkey:latest")
	.withEndpoint({ targetPort: 6379, name: "tcp" })
	.withSessionLifetime();

/*
 * folkid — identitetstjänsten ur systerkatalogen, som färdig image. Den byggs inte här:
 * localhost/folkid:latest är taggen som asplund-software/build-folkid.mjs sätter, och
 * den finns bara lokalt. ImagePullPolicy.Never gör att podman aldrig går mot ett
 * register efter den — utan bygget står resursen still med "image not known", vilket
 * är rätt felmeddelande.
 *
 * PORT sätts uttryckligen. Backenden faller annars tillbaka på 3000 medan Dockerfilen
 * exponerar 3005, och endpointen nedan pekar på 3005.
 *
 * Adresserna är referenser, inte strängar: containern når pkc, valkey och mailpit över
 * containernätet, och Aspire räknar ut värdnamn och port per mottagare.
 * HostAndPort och inte Url för valkey — endpointen har ingen http-scheme, och
 * ioredis vill ha redis://.
 *
 * SMTP_SERVER_URL byggs på samma sätt ur mailpits smtp-endpoint: HostAndPort löses ut
 * till mailpit:{lottad port} sett från folkids container, och folkid parsar
 * smtp://host:port själv (parseSmtpUrl i verification.ts).
 *
 * Fast port 3005, till skillnad från pkc — och oproxad. folkid är identitetsleverantör
 * åt Keycloak (identityProviders i keycloak/realm/gigga-realm.json), och realmet bär
 * adresserna som strängar: webbläsaren skickas till localhost:3005/oidc/authorize, och
 * Keycloak hämtar token och nycklar på folkid:3005 över containernätet. En lottad port
 * hade gjort den första adressen fel varje gång. isProxied: false tar bort DCP:s proxy
 * så att podman publicerar porten direkt — men bara på 127.0.0.1, det är DCP:s
 * standardvärd för containerportar. Callbacken nedan sätter targetHost till 0.0.0.0, och
 * först då binder podman 3005 på alla gränssnitt så att en telefon på samma nät kan nå
 * backenden efter QR-skanningen. Utan den svarar bara localhost:3005, och raden
 * "folkid på nätet" i dashboarden pekar på en port som inte lyssnar.
 *
 * ISSUER_URL låser issuern till den adress webbläsaren ser. Utan den härleds den ur
 * varje anrops Host-huvud, och tokenanropet från Keycloak hade gett iss=folkid:3005.
 *
 * OIDC_CLIENTS registrerar gigga-realmet som förlitande part — klient-id och hemlighet
 * ska stämma med identityProviders.config i realmfilen. Hemligheten står i klartext
 * av samma skäl som Keycloaks adminkonto: miljön lever på localhost och rivs vid stopp.
 * Redirect-adressen är Keycloaks broker-endpoint sett från webbläsaren, alltså genom
 * webbens /auth-proxy. En sträng och inte en referens till webbens endpoint: en
 * container som refererar en värdprocess får en containerbryggeadress, och folkid
 * jämför redirect_uri byte för byte mot det Keycloak faktiskt skickar, som byggs ur
 * Host-huvudet — localhost:5173. Genom cloudflare-tunneln fungerar inloggningen via
 * folkid inte: webbläsaren når inte localhost:3005 därifrån, och det kräver en egen
 * tunnel åt folkid innan en tunneladress här vore till någon nytta.
 *
 * Den andra adressen i dashboarden är värdens första externa IPv4-adress, den som
 * telefonen på samma nät faktiskt ska använda. Podman publicerar redan porten där
 * (isProxied: false ovan), men dashboarden visar bara localhost av sig själv, och
 * adressen är den man behöver skriva in i appen. Saknas ett externt gränssnitt — ingen
 * nätverksanslutning alls — utelämnas raden.
 */
const externalIPv4 = Object.values(networkInterfaces())
	.flat()
	.find(
		(iface) => iface && iface.family === "IPv4" && !iface.internal,
	)?.address;
const valkeyHostAndPort = await (await valkey.getEndpoint("tcp")).property(
	EndpointProperty.HostAndPort,
);
const mailpitHostAndPort = await (await mailpit.primaryEndpoint()).property(
	EndpointProperty.HostAndPort,
);

const folkidOidcClients = JSON.stringify([
	{
		client_id: "gigga",
		client_secret: "gigga-folkid-dev-secret",
		name: "gigga (Keycloak)",
		redirect_uris: [
			"http://localhost:5173/auth/realms/gigga/broker/folkid/endpoint",
		],
	},
]);

const folkid = await builder
	.addContainer("folkid", "localhost/folkid:latest")
	.withImagePullPolicy(ImagePullPolicy.Never)
	.withEnvironment("PORT", "3005")
	.withEnvironment("ISSUER_URL", "http://localhost:3005")
	.withEnvironment("OIDC_CLIENTS", folkidOidcClients)
	.withEnvironment("KEYSERVER_URL", await pkc.getEndpoint("http"))
	.withEnvironment("REDIS_URL", refExpr`redis://${valkeyHostAndPort}`)
	.withEnvironment("SMTP_SERVER_URL", refExpr`smtp://${mailpitHostAndPort}`)
	.withHttpEndpoint({ port: 3005, targetPort: 3005, isProxied: false })
	.withEndpointCallback("http", async (endpoint) => {
		await endpoint.targetHost.set("0.0.0.0");
	})
	.withHttpHealthCheck({ path: "/health" })
	.withSessionLifetime()
	.waitFor(pkc)
	.waitFor(valkey)
	.waitFor(mailpit);

if (externalIPv4) {
	await folkid.withUrl(`http://${externalIPv4}:3005`, {
		displayText: `folkid på nätet (${externalIPv4})`,
	});
}

// addBunApp kör källfilen direkt — inget bygg- eller transpileringssteg.
const api = await builder
	.addBunApp("api", "./services/api", "src/index.ts")
	.withBun()
	// Levande omladdning: bun startar om API:et när en källfil ändras, utan `aspire stop`.
	// Flaggan måste stå före skriptet (`bun --watch src/index.ts`), och withArgs() lägger
	// bara till sist — då blir den ett argument till programmet i stället. Därför via
	// dev-scriptet i services/api/package.json, som äger ordningen.
	.withRunScript("dev")
	// Lottad port. En fast port ger ett API som ser ohälsosamt ut så fort något annat
	// redan sitter på 3000 — hälsokontrollen frågar en port som inte är vår. Ingen behöver
	// den fast heller: webbens proxy får adressen av API_TARGET längre ned, och e2e går
	// genom webben.
	.withHttpEndpoint({ env: "PORT" })
	.withEnvironment("DATABASE_URL", await db.uriExpression())
	// Ingen adress till Keycloak här. Både issuern och nyckeladressen räknas ut ur
	// PUBLIC_BASE_URL i services/api/src/config.ts — nycklarna hämtas från den issuer som
	// skrev token, vilket är vad OIDC-discovery ändå hade svarat. Det gör att
	// tunnelvägen längre ned rättar allt på en gång, och att API:et aldrig behöver tala
	// med Aspires https-endpoint, vars utvecklingscertifikat bun inte har någon kedja till.
	.withEnvironment("OIDC_AUDIENCE", "gigga-api")
	.withEnvironment("SMTP_HOST", await mailpit.host())
	.withEnvironment("SMTP_PORT", await mailpit.port())
	.withEnvironment("S3_ENDPOINT", await minio.uriExpression())
	.withEnvironment("S3_BUCKET", "gigga-attachments")
	.withEnvironment("S3_ACCESS_KEY_ID", minioUser)
	.withEnvironment("S3_SECRET_ACCESS_KEY", minioPassword)
	// Larmen landar i mailpit tillsammans med all annan post — synliga i dashboarden.
	.withEnvironment("STORAGE_ALERT_EMAIL", "drift@gigga.dev")
	.withHttpHealthCheck({ path: "/health" })
	.waitFor(db)
	.waitFor(mailpit)
	.waitFor(minio)
	.waitFor(keycloak);

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
	// Referensen och inte en sträng: porten är lottad och känd först när api tilldelats
	// sin, alltså efter att grafen byggts. Vite läser variabeln när servern startar, och
	// waitFor(api) nedan gör att det aldrig sker innan adressen finns.
	.withEnvironment("API_TARGET", await api.getEndpoint("http"))
	// Keycloak under /auth på samma origin som webben. Det är hela knuten till att
	// issuern stämmer överallt — se resursen längre upp.
	.withEnvironment("KEYCLOAK_TARGET", await keycloak.getEndpoint("http"))
	.waitFor(api)
	.waitFor(keycloak);

// Bekräftelselänkarna pekar på webbens /verify, inte in i API:et — därför webbens
// adress här och inte API:ets. Sätts efter att `web` finns, men bara som ett värde:
// api väntar inte på webben, och webben väntar fortfarande på api.
//
// Med --enable-cloudflare skrivs värdet över längre ned, till tunnelns adress.
await api.withEnvironment("PUBLIC_BASE_URL", await web.getEndpoint("http"));

/*
 * Väntar in tunnelns publika adress. Metrics-servern startar först när tunneln är
 * uppkopplad, så allt fram till dess är anslutningsfel och inget att rapportera —
 * därför tyst omförsök tills tidsgränsen går ut.
 *
 * Tidsgränsen är inte valfri: väntan sker inne i callbacks som håller sina resurser
 * tillbaka så länge de kör. Utan cloudflared igång — eller utan väg ut — skulle varken
 * api eller web starta. Efter tidsgränsen går miljön vidare som vanligt, på localhost.
 */
async function pollQuickTunnel(
	metricsPort: number,
	timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<string | null> {
	const deadline = performance.now() + timeoutMs;

	while (performance.now() < deadline) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${metricsPort}/quicktunnel`,
				{ signal: AbortSignal.timeout(2_000) },
			);

			if (response.ok) {
				const { hostname } = (await response.json()) as { hostname?: string };
				if (hostname) {
					return `https://${hostname}`;
				}
			}
		} catch {
			// Tunneln är inte uppe än. Nästa varv.
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	return null;
}

/*
 * Delad väntan på en tunnel, med adressen sparad när den väl kommit fram.
 *
 * **Delad**, för att flera callbacks frågar efter samma tunnel och annars hade väntat i
 * tur och ordning — och api hade kunnat få en annan adress än den som visas på webben.
 *
 * **Sparad bara när den lyckas.** En väntan som gick ut får inte cementeras: efterspelet
 * längst ned frågar igen med en längre tidsgräns, och då ska svaret gälla för alla som
 * frågar efter det.
 */
function tunnelUrlReader(
	metricsPort: number,
): (timeoutMs?: number) => Promise<string | null> {
	let found: string | null = null;
	let pending: Promise<string | null> | undefined;

	return async (timeoutMs) => {
		if (found) {
			return found;
		}

		pending ??= pollQuickTunnel(metricsPort, timeoutMs);
		const url = await pending;
		pending = undefined;

		if (url) {
			found = url;
		}

		return url;
	};
}

/*
 * Hänger tunnelns adress på resursen och skriver den i resursloggen. Uteblir den skrivs
 * en varning i stället — annars vore skillnaden mellan "tunneln kom inte upp" och
 * "tunneln är avstängd" osynlig i dashboarden.
 */
async function addTunnelUrl(
	context: ResourceUrlsCallbackContext,
	tunnelUrl: (timeoutMs?: number) => Promise<string | null>,
): Promise<void> {
	const url = await tunnelUrl(CALLBACK_TIMEOUT_MS);

	if (!url) {
		await context
			.log()
			.warning(
				"Ingen cloudflare-tunnel svarade i tid — resursen visas bara på localhost.",
			);
		return;
	}

	await context.urls().add(url, { displayText: "Cloudflare" });
	await context.log().info(`Cloudflare-tunnel: ${url}`);
}

if (tunnels) {
	/*
	 * waitFor uttrycker ordningen i modellen i stället för i väntan: web och api går inte
	 * upp förrän tunneln har svarat 200 på /ready. Callbackarna nedan hittar då adressen
	 * direkt, och dashboarden visar "Waiting" i stället för en resurs som ser hängd ut.
	 *
	 * api väntar på webbens tunnel för PUBLIC_BASE_URL:s skull, mailpit på sin egen.
	 */
	await api.waitFor(tunnels.web);
	await web.waitFor(tunnels.web);
	await mailpit.waitFor(tunnels.mail);

	const webTunnelUrl = tunnelUrlReader(WEB_TUNNEL_METRICS_PORT);
	const mailTunnelUrl = tunnelUrlReader(MAIL_TUNNEL_METRICS_PORT);

	// Adresserna hängs på webben och mailpit, inte på tunnelresurserna: det är där man
	// letar efter dem i dashboarden, bredvid localhost-länken och som klickbar länk.
	await web.withUrls((context) => addTunnelUrl(context, webTunnelUrl));
	await mailpit.withUrls((context) => addTunnelUrl(context, mailTunnelUrl));

	/*
	 * Bekräftelse- och återställningslänkarna måste peka på tunneln: den som öppnar
	 * gränssnittet utifrån har ingen localhost att gå tillbaka till, och en länk till
	 * localhost:5173 i brevet leder rakt in i mottagarens egen maskin.
	 *
	 * En callback och inte withEnvironment: adressen finns inte när grafen byggs, bara när
	 * api startar. Miljövariablerna sätts i den ordning de registrerades, så det här skriver
	 * över localhost-värdet från raden längre upp — och lämnar det orört om tunneln uteblir,
	 * vilket är precis vad man vill ha kvar då.
	 */
	await api.withEnvironmentCallback(async (context) => {
		const url = await webTunnelUrl(CALLBACK_TIMEOUT_MS);

		if (!url) {
			await context
				.log()
				.warning(
					"Ingen cloudflare-tunnel svarade i tid — PUBLIC_BASE_URL står kvar på localhost.",
				);
			return;
		}

		await context.environment().set("PUBLIC_BASE_URL", url);
		await context.log().info(`PUBLIC_BASE_URL pekar på tunneln: ${url}`);
	});

	/*
	 * Efterspelet, och det som räddar bekräftelselänkarna vid en kallstart.
	 *
	 * Första gången flaggan används finns ingen tunnel när callbackarna ovan körs — de kan
	 * inte vänta in en process som står bakom dem i kön. De tar localhost, kön släpper,
	 * cloudflared startar. Här väntas adressen in utanför kön, och api startas om: en omstart
	 * bygger resursens spec på nytt, alltså körs miljö-callbacken en gång till, nu med
	 * adressen på plats.
	 *
	 * Bara api. URL-callbacken körs *inte* om vid en omstart — dashboardens länkar räknas ut
	 * en gång, när resursen skapas — så en omstart av web och mailpit hade kostat en
	 * nedsläckt Vite-server och en tömd brevlåda utan att ge något tillbaka. Länkarna på de
	 * två resurserna dyker i stället upp nästa körning, när tunnlarna redan lever.
	 *
	 * Andra körningen och framåt gör hela blocket ingenting: adressen fanns direkt, och
	 * omstarten hoppas över.
	 */
	await builder.subscribeAfterResourcesCreated(async (event) => {
		const commands = await (await event.services()).getResourceCommandService();

		// Medvetet utan await: handlern kör innan miljön är uppe, och att vänta här vore att
		// återinföra exakt den blockering det hela handlar om.
		void (async () => {
			if (await webTunnelUrl(0)) {
				return;
			}

			if (await webTunnelUrl(COLD_START_TIMEOUT_MS)) {
				await commands.executeCommandAsync(api, "resource-restart");
			}
		})();
	});
}

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
	// Keycloak nås samma väg som webbläsaren gör det, alltså genom webbens /auth-proxy —
	// sviten behöver ingen egen adress dit. Adminuppgifterna behövs för att koppla
	// nyregistrerade konton till en organisation: självregistrering ger inget medlemskap,
	// och utan ett sådant svarar API:et 403 organization-missing. Det är inbjudningsvägen,
	// gången med API:et istället för genom ett mail.
	.withEnvironment("KEYCLOAK_ADMIN_USER", keycloakUser)
	.withEnvironment("KEYCLOAK_ADMIN_PASSWORD", keycloakPassword)
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
