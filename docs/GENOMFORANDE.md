# fastgig — genomförandeplan

Marknadsplats för distansuppdrag: **köpare** publicerar uppdragsförfrågningar, **säljare**
lämnar anbud med en genomförandeplan och ersättningsmodell (fast pris eller timbaserat),
och parterna signerar ett avtal.

Detta dokument är planen för backend-leveransen. Den är avsedd att läsas uppifrån och ned
en gång, och därefter användas som referens per etapp (§9).

**Runtime är Bun genomgående** — inte Node, inte npm. Det gäller AppHosten, tjänsten,
paketinstallation och testkörning.

---

## 1. Teknikval

| Område | Val | Motivering |
|---|---|---|
| Runtime & pakethanterare | **Bun 1.3.14** | Krav. Kör TypeScript direkt utan transpileringssteg, `bun install` är sekundsnabbt, och test/hash/SQL finns inbyggt. |
| HTTP | Fastify 5 | Snabb, förstklassigt JSON Schema-stöd som *samma* artefakt driver validering och OpenAPI. Verifierat körbar på Bun (§2.2). |
| API-dokumentation | `@fastify/swagger` + `@fastify/swagger-ui` | Swagger UI på `/docs`, OpenAPI 3.1 på `/docs/json` — genereras ur route-scheman, skrivs aldrig för hand. |
| Typer/scheman | TypeBox + `@fastify/type-provider-typebox` | Ett schema ⇒ runtime-validering + TS-typer + OpenAPI. Ingen dubbelspecifikation. |
| Databas | PostgreSQL 17 i container, **icke-persistent** | Krav. Ingen volym ⇒ tom databas vid varje uppstart. |
| DB-klient | **`Bun.SQL`** (inbyggd) | Ingen `pg`-dependency. Taggade template-literals är parametriserade som standard, `sql.begin()` ger transaktioner. Verifierat mot Postgres 17 (§2.2). |
| Migrationer | Numrerade `.sql`-filer som körs idempotent vid boot | Eftersom databasen ändå är tom vid start är boot-migrering både enklast och alltid korrekt. |
| Lösenord | **`Bun.password.hash/verify`** (argon2id) | Inbyggt, inget native-bygge, bättre än scrypt-varianten och kräver ingen dependency. |
| Token | `@fastify/jwt` (HS256) | Verifierad på Bun (§2.2). |
| Orkestrering | Aspire 13.4.6, **TypeScript-AppHost körd med Bun** | Krav. `aspire run` startar Postgres + API + dashboard med en kommandorad. |
| Containerruntime | **podman** (aldrig docker) | docker finns inte på maskinen. Se §2.1. |
| Test | **`bun test`** + `fastify.inject()` | Inbyggd Jest-kompatibel körare med watch-läge. `inject()` ger full HTTP-semantik utan portbindning. Noll testberoenden. |

### 1.1 Varför inte

- **Ingen ORM (Prisma/Drizzle)** — schemat är sju tabeller och frågorna är enkla; ett
  generatorsteg skulle sakta ned röd-grön-cykeln som hela §7 bygger på.
- **Ingen `pg`** — `Bun.SQL` täcker allt vi behöver (pooling, transaktioner, `FOR UPDATE`).
- **Ingen vitest** — `bun test` gör samma sak, ingår i runtimen och startar snabbare.
- **Ingen Testcontainers** — biblioteket bygger på Docker-API + Ryuk-städaren, som är
  besvärlig rootless. Vi styr podman direkt med `Bun.$` istället (§7.1); det är ~40 rader
  och har inga rörliga delar.
- **Ingen separat OpenAPI-fil** — den skulle omedelbart divergera från koden.
- **Ingen refresh-token-rotation i etapp 1** — access-token med kort livslängd räcker för
  localhost-utveckling. Noterat som skuld i §10.

---

## 2. Förutsättningar på utvecklingsmaskinen

Verifierat i den här miljön:

```
bun     1.3.14   (~/.bun/bin/bun)
podman  5.8.4
aspire  13.4.6   (~/.aspire/bin/aspire)
dotnet  10.0.110 (krävs av Aspires egen backend-process, inte av vår kod)
```

Node finns på maskinen men används inte av det här projektet.

### 2.1 Podman

Aspire och all containerkörning går via podman.

**Socket** (Aspire talar Docker-API mot podmans kompatibla socket). Aktiverad i etapp 0:

```bash
systemctl --user enable --now podman.socket
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
```

**Fullkvalificerade image-namn — men bara i det vi skriver själva.** Maskinens
`registries.conf` saknar `unqualified-search-registries`, så korta namn misslyckas i
handskrivna `podman`-kommandon (testriggen i §7.1):

```
$ podman run postgres:17-alpine
Error: short-name "postgres:17-alpine" did not resolve to an alias …
```

**Aspire fullkvalificerar däremot själv.** Det bekräftades i etapp 0 genom att göra fel:
`.withImage('docker.io/library/postgres')` i AppHosten gav

```
Trying to pull docker.io/docker.io/library/postgres:17-alpine...
Error: … reading manifest 17-alpine in docker.io/docker.io/library/postgres: unauthorized
```

Sätt alltså **aldrig** registry i `withImage()` — bara `withImageTag()` vid behov. Aspires
egna default-referenser fungerar direkt mot podman (`docker.io/library/postgres:17-alpine`,
`docker.io/sosedoff/pgweb:0.17.0` kördes båda utan ingrepp).

### 2.2 Vad som redan är verifierat, inte antaget

Följande kördes skarpt innan planen skrevs, i en kastbar bun-katalog:

- Fastify 5.12 + `@fastify/swagger` 9.8 + `@fastify/swagger-ui` 6.1 + `@fastify/jwt` 10.2 +
  TypeBox 0.34 startar på Bun; `app.inject()`, schemavalidering (422/400-vägen),
  `/docs/json` med `openapi: 3.1.0` och Swagger UI svarar alla korrekt.
- `Bun.password.hash` / `verify` fungerar i en request-hanterare.
- `bun test` kör dessa som en svit (4/4 gröna).
- `Bun.SQL` mot Postgres 17: parametriserade taggade queries, `sql.begin()` med rollback,
  `SELECT … FOR UPDATE` i transaktion, samt `CREATE DATABASE … TEMPLATE` — allt grönt.
- Aspire startar en TypeScript-AppHost **med Bun** när `bun.lock` finns (§4.1).

Och i etapp 0, mot den riktiga uppsättningen: `aspire start` gav `postgres`, `pgweb`,
`fastgig` (databasen) och `api` alla `Running/Healthy`; `/health` svarade
`{"status":"ok","database":"up"}` — alltså `Bun.SQL` mot Aspires Postgres — `/docs/json`
gav `openapi: 3.1.0`, och `aspire stop` rev båda containrarna.

En känd fallgrop från samma körning: **`bigint`-kolumner kommer tillbaka som `string`** från
`Bun.SQL`. Beloppsmappningen i `src/db/` konverterar därför explicit, och det finns ett
testfall för det (D.4).

---

## 3. Repostruktur

```
fastgig/
├── apphost.mts                 # Aspire AppHost (TypeScript, körs med bun)
├── aspire.config.json          # genererad av `aspire new`
├── package.json                # bun-workspace-rot + AppHost-beroenden
├── bun.lock                    # checkas in — styr Aspires val av runtime (§4.1)
├── .aspire/modules/*.mts       # genererad SDK — gitignorerad, regenereras med `aspire restore`
├── docs/
│   ├── GENOMFORANDE.md         # detta dokument
│   └── API.md                  # kort, handskriven översikt; Swagger är sanningen
├── services/
│   └── api/
│       ├── package.json
│       ├── tsconfig.json
│       ├── bunfig.toml         # testinställningar (preload av global setup)
│       ├── migrations/
│       │   ├── 001_users.sql
│       │   ├── 002_requests.sql
│       │   ├── 003_bids.sql
│       │   └── 004_contracts.sql
│       ├── src/
│       │   ├── server.ts       # buildServer(): FastifyInstance — inga sidoeffekter
│       │   ├── index.ts        # entrypoint: buildServer().listen()  ← bun kör denna direkt
│       │   ├── config.ts       # env-parsning, validerad med TypeBox
│       │   ├── db/
│       │   │   ├── sql.ts      # Bun.SQL-instans + hjälpare
│       │   │   ├── migrate.ts
│       │   │   ├── users.ts
│       │   │   ├── requests.ts
│       │   │   ├── bids.ts
│       │   │   └── contracts.ts
│       │   ├── plugins/
│       │   │   ├── swagger.ts
│       │   │   ├── auth.ts     # JWT-dekorator + `requireAuth` preHandler
│       │   │   └── errors.ts   # felmappning → Problem Details
│       │   ├── schemas/        # TypeBox-scheman, delade mellan route och test
│       │   │   ├── common.ts
│       │   │   ├── auth.ts
│       │   │   ├── request.ts
│       │   │   ├── bid.ts
│       │   │   └── contract.ts
│       │   ├── domain/         # ren logik, inga I/O-beroenden
│       │   │   ├── money.ts
│       │   │   ├── bid-rules.ts
│       │   │   └── contract-rules.ts
│       │   └── routes/
│       │       ├── auth.ts     # API 1–2
│       │       ├── me.ts       # API 3–4
│       │       ├── requests.ts # API 5–6
│       │       └── contracts.ts# API 7
│       └── test/
│           ├── helpers/
│           │   ├── postgres.ts # podman-container via Bun.$ + template-databas
│           │   ├── app.ts      # buildTestApp()
│           │   └── actors.ts   # registerBuyer(), registerSeller(), …
│           ├── contract/       # ett spec-test per API (§7.2)
│           └── domain/         # snabba enhetstester utan databas
└── .claude/skills/             # se §8
```

Bun-workspaces i rotens `package.json`:

```json
{ "workspaces": ["services/*"] }
```

`services/api` är avsiktligt ett eget workspace: AppHost-beroendena ska inte blandas ihop
med tjänstens.

**Ingen `package-lock.json` någonstans.** Finns en, ska den tas bort — den påverkar Aspires
runtime-val (§4.1).

---

## 4. Aspire-AppHost

Skapas med den mall CLI:t redan tillhandahåller, och kompletteras med två integrationer:

```bash
aspire init --language typescript          # `aspire new … -o .` vägrar en icke-tom katalog
rm -rf node_modules package-lock.json      # mallen installerar med npm
bun install                                # ⇒ bun.lock, se §4.1
aspire add postgresql                      # Aspire.Hosting.PostgreSQL 13.4.6
aspire add javascript                      # Aspire.Hosting.JavaScript 13.4.6
```

`aspire init` lägger till `apphost.mts`, `aspire.config.json`, `tsconfig.apphost.json`,
`eslint.config.mjs` och en `.gitignore` i en befintlig katalog. Mallens `tsx`- och
`nodemon`-devDependencies tas bort — Bun kör TypeScript direkt och Aspire sköter
typkontrollen som förkörningssteg.

Integrationerna regenererar `.aspire/modules/aspire.mts` och tillför `builder.addPostgres()`
respektive `builder.addBunApp()`.

### 4.1 Hur AppHosten hamnar på Bun

Aspire väljer runtime för en TypeScript-AppHost efter vilken lockfil som finns. Med
`bun.lock` i roten loggar CLI:t:

```
[GuestAppHostProject] Selected TypeScript AppHost package manager 'bun' because bun.lock found
[GuestAppHostProject] Created GuestRuntime for TypeScript (Bun): Execute=bun run {appHostFile}
[GuestAppHostProject] Executing: ~/.bun/bin/bun install
[GuestAppHostProject] Launching pre-execution command: bun run tsc --noEmit -p tsconfig.apphost.json
[GuestAppHostProject] Launching: bun run …/apphost.mts
```

Detta är verifierat, inte antaget — utdraget är från en faktisk `aspire start`. Konsekvenser:

- `bun.lock` **måste checkas in**; utan den faller Aspire tillbaka på Node + tsx.
- Aspire kör `bun install` åt oss före start.
- Typkontrollen av AppHosten är ett *förkörningssteg* — ett typfel i `apphost.mts` stoppar
  starten med ett begripligt fel. Mallens `tsx`/`nodemon`-devDependencies är därmed onödiga
  och tas bort i etapp 0.

### 4.2 `apphost.mts` (målbild)

```ts
import { createBuilder } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

// Icke-persistent: ingen withDataVolume(), ingen withPersistentLifetime().
// Sessionslivstid ⇒ containern rivs när AppHost stoppas, databasen är tom vid varje start.
const postgres = await builder
  .addPostgres('postgres')
  // Sätt aldrig registry i withImage() — Aspire fullkvalificerar själv (§2.1).
  .withImageTag('17-alpine')
  .withSessionLifetime()
  .withPgWeb();                       // pgweb på egen URL i dashboarden

const db = await postgres.addDatabase('fastgig');

const jwtSecret = await builder.addParameterWithGeneratedValue('jwt-secret', { minLength: 48 });

// addBunApp kör `bun src/index.ts` direkt — inget bygg- eller transpileringssteg.
const api = await builder
  .addBunApp('api', './services/api', 'src/index.ts')
  .withBun()                          // bun install före start
  .withHttpEndpoint({ env: 'PORT' })
  .withEnvironment('DATABASE_URL', await db.uriExpression())
  .withEnvironment('JWT_SECRET', jwtSecret)
  .withHttpHealthCheck({ path: '/health' })
  .withUrlForEndpoint('http', (url) => ({ ...url, displayText: 'Swagger', url: '/docs' }))
  .waitFor(db);

await builder.build().run();
```

Signaturerna är avlästa ur den genererade SDK:n, inte gissade:
`addPostgres(name, options?)`, `addDatabase(name, options?)`, `withSessionLifetime()`,
`withPgWeb()`, `withDataVolume()` (som vi alltså *inte* anropar),
`addBunApp(name, appDirectory, scriptPath)`, `withBun(options?)` med
`{ install?: boolean, installArgs?: string[] }`, `withHttpEndpoint`, `withHttpHealthCheck`,
`waitFor`, `uriExpression()`.

Aspires egen dokumentation för `addBunApp`: *"executes the script directly using `bun <script>`.
Bun natively runs JavaScript and TypeScript files so no transpile step is required."*

`uriExpression()` ger en `postgres://…`-URI som `Bun.SQL` konsumerar direkt. Vi sätter den
explicit som `DATABASE_URL` istället för `withReference(db)` — den senare injicerar Aspires
`ConnectionStrings__*`-konvention, och en explicit `DATABASE_URL` gör tjänsten körbar även
utanför Aspire (vilket testerna kräver).

**Vändläge:** `aspire run` → dashboard på `https://localhost:17097`, API + Swagger länkade
därifrån. `aspire stop` river Postgres-containern.

---

## 5. Domänmodell

Alla belopp lagras som **heltal i minorenhet (öre)** med separat `currency CHAR(3)`, aldrig
som float. All tid är `timestamptz` i UTC.

```
users        id uuid pk, email citext unique, password_hash text, display_name text,
             created_at timestamptz

requests     id uuid pk, buyer_id → users, title text, description text,
             compensation_pref  enum('fixed','hourly','any'),
             budget_minor bigint null, currency char(3) default 'SEK',
             deadline_at timestamptz null,
             status enum('open','awarded','cancelled') default 'open',
             created_at timestamptz

bids         id uuid pk, request_id → requests, seller_id → users,
             plan text,                            -- genomförandeplanen
             compensation_type enum('fixed','hourly'),
             fixed_amount_minor bigint null,        -- vid 'fixed'
             hourly_rate_minor  bigint null,        -- vid 'hourly'
             estimated_hours    numeric(6,2) null,  -- vid 'hourly'
             currency char(3), status enum('submitted','withdrawn','accepted','rejected'),
             created_at timestamptz,
             unique (request_id, seller_id) where status <> 'withdrawn'

contracts    id uuid pk, request_id → requests unique, bid_id → bids unique,
             terms jsonb,                          -- fryst kopia av anbudet vid skapandet
             buyer_signed_at  timestamptz null,
             seller_signed_at timestamptz null,
             status enum('pending_signatures','active','void'),
             created_at timestamptz
```

`bigint`- och `numeric`-kolumner returneras som `string` av `Bun.SQL`. Konverteringen sker
på ett ställe — i mapparna i `src/db/` — aldrig utspritt i routes.

### 5.1 Invarianter (blir ett test var i `test/domain/`)

1. `compensation_type='fixed'` ⇒ `fixed_amount_minor` satt, `hourly_*` null. Och tvärtom.
2. Belopp > 0. `estimated_hours` > 0.
3. Ingen roll är fast per konto — samma användare kan vara köpare i en förfrågan och säljare
   i en annan. Behörighet avgörs alltid av ägarskap i just den raden.
4. Man kan inte lägga anbud på sin egen förfrågan.
5. Anbud kan bara läggas på `status='open'`-förfrågan, och bara före `deadline_at`.
6. `terms` i `contracts` är en ögonblicksbild — senare ändringar av anbudet påverkar inte
   ett skapat avtal.
7. Avtal blir `active` först när **båda** signaturerna finns; då sätts förfrågan till
   `awarded` och övriga anbud till `rejected`, i **en** transaktion (`sql.begin`).
8. En signatur är idempotent: samma part som signerar igen ger 200 och oförändrat tillstånd.

---

## 6. API-kontrakt

Prefix `/api/v1`. Autentisering: `Authorization: Bearer <jwt>`. Fel returneras som
RFC 9457 Problem Details (`application/problem+json`) med `type`, `title`, `status`, `detail`
och vid valideringsfel `errors[]`.

| # | Metod & väg | Auth | Syfte |
|---|---|---|---|
| 1 | `POST /api/v1/auth/register` | – | Registrering av konto |
| 2 | `POST /api/v1/auth/login` | – | Inloggning |
| 3 | `GET /api/v1/me/requests` | ✔ | Egna förfrågningar **med inlämnade anbud** |
| 4 | `GET /api/v1/me/bids` | ✔ | Egna anbud med status |
| 5 | `POST /api/v1/requests` | ✔ | Registrera förfrågan |
| 6 | `POST /api/v1/requests/{requestId}/bids` | ✔ | Registrera anbud |
| 7 | `POST /api/v1/bids/{bidId}/contract/signatures` | ✔ | Signera avtal |

### 6.1 Detaljer per API

**1. `POST /auth/register`** → `201`
`{ email, password, displayName }` → `{ id, email, displayName, token }`.
Lösenord ≥ 12 tecken, hashas med `Bun.password.hash` (argon2id). Dubblett-e-post ⇒ `409`.
E-post normaliseras (trim + lowercase, `citext`).

**2. `POST /auth/login`** → `200`
`{ email, password }` → `{ token, expiresIn }`. Fel användare *och* fel lösenord ger
samma `401` med samma svarstid (`Bun.password.verify` körs mot en dummyhash även för okänd
e-post — se testfall A2.3).

**3. `GET /me/requests`** → `200`
`{ items: [{ …request, bids: [{ id, sellerId, sellerDisplayName, plan, compensation, status, createdAt }] }] }`.
Endast anropande användares egna förfrågningar. Anbudens `plan`-fält ingår — köparen ska
kunna bedöma dem. Sortering: nyaste först. Sidbrytning via `?limit&cursor` (default 20).

**4. `GET /me/bids`** → `200`
`{ items: [{ id, requestId, requestTitle, compensation, status, contract: { status, buyerSigned, sellerSigned } | null, createdAt }] }`.
Endast egna anbud. Filtrering via `?status=`.

**5. `POST /requests`** → `201`
`{ title, description, compensationPref, budget?: { amountMinor, currency }, deadlineAt? }`.
`deadlineAt` måste ligga i framtiden. Skaparen blir köpare.

**6. `POST /requests/{id}/bids`** → `201`
`{ plan, compensation: { type:'fixed', amountMinor, currency } | { type:'hourly', rateMinor, estimatedHours, currency } }`.
Diskriminerad union i TypeBox ⇒ Swagger får `oneOf` med `discriminator`.
`403` på egen förfrågan, `409` vid dubbelt anbud, `422` om förfrågan är stängd eller deadline passerat.

**7. `POST /bids/{bidId}/contract/signatures`** → `200`
Ingen body. Semantik:
- Anropas av **köparen** (ägare av förfrågan) när inget avtal finns ⇒ avtalet skapas med
  `terms` frusna från anbudet, `buyer_signed_at` sätts, status `pending_signatures`.
- Anropas av **säljaren** (anbudsägaren) när avtal finns ⇒ `seller_signed_at` sätts.
- När båda finns ⇒ `active`, förfrågan `awarded`, övriga anbud `rejected`.
- Säljaren först, innan köparen skapat avtalet ⇒ `409` (det finns inget att signera).
- Tredje part ⇒ `403`. Redan signerat av samma part ⇒ `200`, oförändrat.

Svar: `{ contractId, status, buyerSignedAt, sellerSignedAt, terms }`.

> Detta är den enda designtolkning i planen som inte är direkt given av uppgiften: kravlistan
> nämner "signera avtal" men inget separat "acceptera anbud". Vi låter köparens signatur
> *vara* accepterandet, vilket håller ytan vid sju API:er utan att tappa något steg i flödet.
> Om ett explicit accept-steg önskas är det en additiv ändring (nytt API 8), inte en omskrivning.

---

## 7. Testdriven leverans

Testerna är specifikationen. Ingen route-kod skrivs innan ett rött test finns som beskriver
den, och varje etapp i §9 är klar först när dess testfall är gröna.

### 7.1 Testinfrastruktur

**Databas.** `test/helpers/postgres.ts` startar **en** Postgres-container per testkörning
direkt med `Bun.$` — ingen Testcontainers-dependency, ingen Ryuk:

```ts
import { $ } from 'bun';

const IMAGE = 'docker.io/library/postgres:17-alpine';   // fullkvalificerat, se §2.1
const id = (await $`podman run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test
                    -e POSTGRES_DB=postgres -P ${IMAGE}`.text()).trim();
// porten läses ut med `podman port ${id} 5432`, readiness med `podman exec ${id} pg_isready`
```

Migrationerna körs en gång mot `fastgig_template`, och varje testfil får en färsk databas:

```sql
CREATE DATABASE test_<n> TEMPLATE fastgig_template;
```

Det ger full isolering mellan filer utan att betala migrationskostnaden per fil.
`CREATE DATABASE … TEMPLATE` är verifierat mot `Bun.SQL` (§2.2). Containern rivs i
teardown (`podman rm -f`), och `--rm` ser till att inget blir kvar även vid krasch.

`TEST_DATABASE_URL` i miljön kringgår containerstarten helt och kör mot en redan uppe
Aspire-Postgres — praktiskt när man vill inspektera data i pgweb efter ett fallerande test.

Uppstarten hängs på `bunfig.toml`:

```toml
[test]
preload = ["./test/helpers/postgres.ts"]
```

**App.** `buildServer()` returnerar en `FastifyInstance` utan att lyssna på någon port.
Testerna använder `app.inject({ method, url, headers, payload })`. Ingen nätverksstack,
inga portkonflikter, millisekunder per anrop. Verifierat på Bun (§2.2).

**Aktörer.** `test/helpers/actors.ts` ger `const buyer = await actor(app, 'buyer')` med
`buyer.post(url, body)` som redan bär rätt `Authorization`-huvud. Testerna handlar då om
domänen, inte om token-hantering.

### 7.2 Testfallsmatris

Varje rad är ett `test()`. ID:t är stabilt och används som referens i prompt-dialogen
("kör A2.3", "ändra F6.4 till 422") och som filter: `bun test -t A2.3`.

| ID | Test |
|---|---|
| **A1** | **Registrering** |
| A1.1 | Giltig registrering ⇒ 201, användbar token, lösenordet syns inte i svaret |
| A1.2 | Dubblett-e-post (även med annan skiftlägesform) ⇒ 409 |
| A1.3 | Lösenord < 12 tecken ⇒ 422 med fältpekare |
| A1.4 | Trasig e-postadress ⇒ 422 |
| A1.5 | Lösenordet lagras aldrig i klartext (kontroll direkt mot tabellen, hashen är argon2id) |
| **A2** | **Inloggning** |
| A2.1 | Rätt uppgifter ⇒ 200 + token som accepteras av ett skyddat API |
| A2.2 | Fel lösenord ⇒ 401, identisk kropp som A2.3 |
| A2.3 | Okänd e-post ⇒ 401, ingen läcka om kontot finns |
| A2.4 | Utgången/manipulerad token mot skyddat API ⇒ 401 |
| **F5** | **Registrera förfrågan** |
| F5.1 | Giltig förfrågan ⇒ 201, status `open`, buyerId = anroparen |
| F5.2 | Utan token ⇒ 401 |
| F5.3 | Deadline i dåtid ⇒ 422 |
| F5.4 | Budget med negativt belopp ⇒ 422 |
| F5.5 | Titel över maxlängd ⇒ 422 |
| **F6** | **Registrera anbud** |
| F6.1 | Fastprisanbud ⇒ 201, status `submitted` |
| F6.2 | Timanbud med rate + estimatedHours ⇒ 201 |
| F6.3 | `type:'fixed'` men `rateMinor` skickas ⇒ 422 |
| F6.4 | Anbud på egen förfrågan ⇒ 403 |
| F6.5 | Andra anbudet från samma säljare på samma förfrågan ⇒ 409 |
| F6.6 | Anbud efter deadline ⇒ 422 |
| F6.7 | Anbud på okänd förfrågan ⇒ 404 |
| F6.8 | Anbud på `awarded` förfrågan ⇒ 422 |
| **L3** | **Lista egna förfrågningar med anbud** |
| L3.1 | Returnerar bara egna förfrågningar, aldrig andras |
| L3.2 | Inkluderar inlämnade anbud med plan, ersättning och status |
| L3.3 | Förfrågan utan anbud ⇒ tom `bids`-lista, inte utelämnat fält |
| L3.4 | Sidbrytning: `limit` respekteras, `cursor` ger nästa sida utan dubbletter |
| L3.5 | Utan token ⇒ 401 |
| **L4** | **Lista egna anbud** |
| L4.1 | Returnerar bara egna anbud |
| L4.2 | Status speglar avtalsflödet (`submitted` → `accepted`/`rejected`) |
| L4.3 | `contract`-fältet visar signaturläget, `null` innan avtal finns |
| L4.4 | `?status=submitted` filtrerar |
| **S7** | **Signera avtal** |
| S7.1 | Köparens signatur skapar avtal ⇒ 200, `pending_signatures`, terms frusna |
| S7.2 | Säljarens signatur därefter ⇒ `active` |
| S7.3 | Vid `active`: förfrågan blir `awarded`, övriga anbud `rejected` |
| S7.4 | Säljaren signerar först ⇒ 409 |
| S7.5 | Utomstående användare ⇒ 403 |
| S7.6 | Samma part signerar två gånger ⇒ 200, oförändrade tidsstämplar |
| S7.7 | Ändrat anbud efter avtalet påverkar inte `terms` |
| S7.8 | Två samtidiga signaturer ger exakt ett avtal (`FOR UPDATE`-test) |
| **D** | **Domänenheter (utan databas)** |
| D.1 | Ersättningsvalidering: alla giltiga/ogiltiga kombinationer |
| D.2 | Totalberäkning för timanbud (rate × timmar, avrundning i minorenhet) |
| D.3 | Signaturstatens övergångar som ren funktion |
| D.4 | `bigint`/`numeric` från `Bun.SQL` mappas till rätt JS-typ, aldrig implicit `string` |
| **X** | **Tvärsnitt** |
| X.1 | `/docs/json` validerar som OpenAPI 3.1 och innehåller alla sju operationerna |
| X.2 | Varje route har `operationId`, `tags` och beskrivna felsvar |
| X.3 | `/health` svarar 200 när databasen är nåbar, 503 annars |
| X.4 | Okänd väg ⇒ 404 i Problem Details-format |

Totalt 47 testfall. Matrisen är levande — den *ska* ändras i dialogen (§8.1).

### 7.3 Körning

```bash
bun test                      # hela sviten
bun test --watch              # primärt läge under dialogen
bun test -t S7                # kör en grupp via ID
bun test test/contract/bids.test.ts
```

---

## 8. Arbetssätt i löpande prompt-dialog

Kravet att testerna ska kunna påverkas löpande i dialog gör själva arbetsflödet till en
leverabel. Två skills ligger i `.claude/skills/`:

### 8.1 `tdd-api` — röd-grön-cykeln

Åberopas när användaren ber om ett nytt API, ändrat beteende eller ett nytt/ändrat testfall.
Skillen fastställer ordningen:

1. **Tolka** önskemålet mot matrisen i §7.2 — nytt ID, ändring, eller borttagning? Föreslå ID.
2. **Skriv testet först** och kör det. Visa att det är **rött** och av *rätt* skäl (fel
   assertion, inte typfel eller trasig fixtur).
3. **Implementera minsta möjliga** kod för grönt. Rör inga orelaterade filer.
4. **Kör hela sviten** — inga regressioner accepteras.
5. **Uppdatera §7.2** i detta dokument i samma svar, så matrisen aldrig divergerar från
   `test/`.
6. **Rapportera** kort: ID, rött→grönt, vilka filer som ändrades.

Skillen förbjuder uttryckligen: att ändra ett test för att få det grönt utan att användaren
bett om det, att markera något klart utan körd svit, och att lägga till API:er utanför §6
utan att först fråga.

### 8.2 `aspire-dev` — köra miljön

Åberopas vid "starta", "kör appen", "titta i databasen", "varför startar inte X".
Innehåller: podman-socketen och de fullkvalificerade image-namnen från §2.1,
`aspire run` / `aspire stop` / `aspire logs api`, var dashboarden och Swagger ligger, hur man
når pgweb, och de vanligaste felen (socket nere, kort image-namn, port upptagen, `bun.lock`
borttagen så Aspire faller tillbaka på Node).

### 8.3 Dialogens spelregler

- **Matrisen i §7.2 är gemensamt språk.** Användaren kan säga "ta bort L3.4, vi skippar
  sidbrytning" eller "lägg till F6.9: anbud i annan valuta än förfrågan ⇒ 422", och ändringen
  slår igenom i både `test/` och detta dokument.
- **Ett kravskifte som rör §6 markeras som sådant** innan kod skrivs, så API-kontraktet inte
  glider tyst.
- **`bun test --watch`** körs under hela sessionen; svarstiden på en ändring är sekunder.

---

## 9. Etapper

Varje etapp är en pull-liknande enhet med en tydlig grön-tröskel.

| # | Etapp | Innehåll | Klar när |
|---|---|---|---|
| **0** ✅ | Grund | `aspire init --language typescript`, `bun install` ⇒ `bun.lock`, bort med `package-lock.json` + `tsx`/`nodemon`, `aspire add postgresql`, `aspire add javascript`, bun-workspaces, podman-socket, `services/api`-skelett | **Klar.** `aspire start` gav alla resurser `Running/Healthy`; CLI-loggen visade `GuestRuntime for TypeScript (Bun)`; `/health` → `{"status":"ok","database":"up"}`; `/docs/json` → `openapi: 3.1.0`; `podman ps` visade `postgres:17-alpine` + `pgweb`; `aspire stop` rev båda |
| **1** | Testrigg | `Bun.$`-postgreshelper, template-databas, `buildServer()`, `actors.ts`, migrationsrunner, `bunfig.toml` | X.3 grön; en avsiktligt trasig assertion i ett dummytest fallerar på < 2 s |
| **2** | Konto & inloggning (API 1–2) | `users`-migrering, `Bun.password`, `@fastify/jwt`, `requireAuth` | A1.\*, A2.\* gröna |
| **3** | Förfrågningar (API 5) | `requests`-migrering, TypeBox-scheman, route | F5.\* gröna |
| **4** | Anbud (API 6) | `bids`-migrering, diskriminerad ersättningsunion, domänregler, beloppsmappning | F6.\*, D.1, D.2, D.4 gröna |
| **5** | Listnings-API:er (API 3–4) | Joins, sidbrytning, filter | L3.\*, L4.\* gröna |
| **6** | Avtalssignering (API 7) | `contracts`-migrering, transaktionell tillståndsmaskin med `sql.begin` + `SELECT … FOR UPDATE` | S7.\*, D.3 gröna |
| **7** | Dokumentation & finish | `operationId`/`tags`/felsvar på alla routes, Problem Details överallt, `docs/API.md` | X.\* gröna; hela sviten (47 fall) grön; Swagger UI körbar mot levande API |

Etapp 0–1 är infrastruktur och skrivs inte testdrivet i strikt mening — de *är* verktyget som
gör resten testdriven. Från etapp 2 gäller §8.1 utan undantag.

---

## 10. Medvetet utelämnat (skuld, inte glömska)

- **Refresh-tokens och utloggning** — access-token med 1 h livslängd i etapp 1.
- **Rate limiting** på `/auth/*` — `@fastify/rate-limit` är ett endagsjobb när det behövs.
- **E-postverifiering och lösenordsåterställning** — kräver utgående e-post.
- **Betalning, fakturering, tidrapportering** — nästa domänområde efter avtalet.
- **Migrationsverktyg med rollback** — meningslöst mot en icke-persistent databas, men
  krävs innan någon persistent miljö sätts upp. Detta är den skuld som förfaller först.
- **Publik sökning bland öppna förfrågningar** — säljare kan i etapp 1 bara lägga anbud på
  förfrågningar de känner till ID:t för. Ett `GET /requests`-API är det självklara API 8.
- **Distribution** — Aspire kan publicera (`aspire publish`; `addBunApp` använder
  `oven/bun:1` som basimage), men målet här är localhost.

---

## 11. Öppna frågor till beställaren

Ingen blockerar etapp 0–2; de behöver svar innan de etapper som anges.

1. **Valuta** — antas SEK genomgående, men fältet finns. Ska anbud i annan valuta än
   förfrågans budget avvisas? *(behövs i etapp 4)*
2. **Moms** — ska belopp anges exklusive eller inklusive moms, och ska det modelleras
   explicit? *(etapp 4)*
3. **Ändra/dra tillbaka anbud** — `withdrawn` finns i schemat men inget API. Behövs det i
   etapp 1? *(etapp 4)*
4. **Signaturens rättsliga innebörd** — räcker tidsstämpel + användar-ID, eller ska en
   hash av `terms` sparas som bevis? Det senare är billigt att lägga till nu och dyrt
   senare. *(etapp 6)*
