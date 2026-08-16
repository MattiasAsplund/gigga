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
| Objektlagring | MinIO i container, `Bun.S3Client` | Anbudsdokument hör inte hemma i en anslutningspool. S3-klienten är inbyggd i Bun. |
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

Tre fallgropar i `Bun.SQL`, alla upptäckta genom att gå på dem:

1. **`bigint`- och `numeric`-kolumner kommer tillbaka som `string`.** Mappningen i
   `src/domain/money.ts` konverterar explicit och kastar hellre än tappar precision (D.4).
2. **En JS-array binds som komma-separerad sträng**, inte som en Postgres-array. Både
   `= ANY(${ids})` och `= ANY(${ids}::uuid[])` ger *"malformed array literal"*. Använd
   `IN ${sql(ids)}` — hjälparen expanderar till en parametriserad lista. Den kräver en
   icke-tom array, så anroparen måste returnera tidigt vid tom sida.
3. **En `jsonb`-kolumn kommer tillbaka som sträng**, medan ett `jsonb`-*uttryck*
   (`'{"a":1}'::jsonb`) kommer tillbaka som objekt. Skillnaden är lätt att missa: felet
   dyker inte upp vid läsningen utan i serialiseringen, som en 500:a med beskedet
   `"bidId" is required!`. `parseTerms` i `db/contracts.ts` parsar därför explicit.

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
│       ├── migrations/
│       │   ├── 001_users.sql
│       │   ├── 002_requests.sql
│       │   ├── 003_bids.sql
│       │   └── 004_contracts.sql
│       ├── src/
│       │   ├── server.ts       # buildServer(): FastifyInstance — inga sidoeffekter
│       │   ├── index.ts        # entrypoint: migrerar och lyssnar  ← bun kör denna direkt
│       │   ├── config.ts       # env-parsning, validerad med TypeBox
│       │   ├── db/
│       │   │   ├── sql.ts      # Bun.SQL-instans
│       │   │   ├── migrate.ts  # en transaktion per migration
│       │   │   ├── users.ts
│       │   │   ├── requests.ts
│       │   │   ├── bids.ts
│       │   │   ├── contracts.ts
│       │   │   └── listings.ts # frågorna bakom API 3 och 4
│       │   ├── plugins/
│       │   │   ├── swagger.ts
│       │   │   ├── auth.ts       # JWT + requireAuth
│       │   │   ├── errors.ts     # Problem Details
│       │   │   └── validation.ts # två Ajv-regimer + tom-kropp-parser
│       │   ├── schemas/        # TypeBox-scheman, delade mellan route och OpenAPI
│       │   │   ├── common.ts   # Problem, Money, Uuid
│       │   │   ├── auth.ts
│       │   │   ├── request.ts
│       │   │   ├── bid.ts
│       │   │   ├── contract.ts
│       │   │   └── me.ts
│       │   ├── domain/         # ren logik, inga I/O-beroenden och därmed snabba tester
│       │   │   ├── money.ts          # minorenhet in/ut ur bigint-kolumner
│       │   │   ├── bid-rules.ts      # diskriminerad ersättning, totalbelopp
│       │   │   ├── contract-rules.ts # signaturernas tillståndsmaskin
│       │   │   └── pagination.ts     # markör på (created_at, id)
│       │   └── routes/
│       │       ├── health.ts
│       │       ├── auth.ts     # API 1–2
│       │       ├── requests.ts # API 5
│       │       ├── bids.ts     # API 6
│       │       ├── me.ts       # API 3–4
│       │       └── contracts.ts# API 7
│       └── test/
│           ├── helpers/
│           │   ├── postgres.ts # podman via Bun.$ + malldatabas
│           │   ├── app.ts      # buildTestApp()
│           │   └── actors.ts   # actor(app, 'kopare')
│           ├── fixtures/       # migrationer att pröva runnern mot
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
| 8 | `GET /api/v1/requests` | ✔ | Lista öppna förfrågningar (katalogen) |
| 9 | `GET /api/v1/validate-user` | – | Bekräfta e-postadress via länken i mailet |
| 10 | `POST /api/v1/auth/resend-verification` | – | Begär ett nytt bekräftelsemail |
| 11 | `POST /api/v1/auth/forgot-password` | – | Begär lösenordsåterställning |
| 12 | `POST /api/v1/auth/reset-password` | – | Sätt nytt lösenord med koden ur mailet |
| 13 | `POST /api/v1/auth/logout` | ✔ | Avsluta den session token tillhör |
| 14 | `POST /api/v1/auth/refresh` | – | Byt refresh-token mot en ny access-token |
| 15 | `GET /api/v1/requests/{requestId}` | ✔ | Läs en förfrågan med dess anbud |
| 16 | `POST /api/v1/requests/{requestId}/permissions` | ✔ | Ge läsrätt |
| 17 | `GET /api/v1/requests/{requestId}/permissions` | ✔ | Lista tilldelade rättigheter |
| 18 | `DELETE /api/v1/requests/{requestId}/permissions/{userId}` | ✔ | Ta tillbaka läsrätt |
| 19 | `POST /api/v1/bids/{bidId}/attachments` | ✔ | Ladda upp ett dokument |
| 20 | `GET /api/v1/bids/{bidId}/attachments` | ✔ | Lista dokumentens metadata |
| 21 | `GET /api/v1/bids/{bidId}/attachments/archive` | ✔ | Ladda ner alla som ZIP |
| 22 | `PATCH /api/v1/bids/{bidId}/attachments/{attachmentId}` | ✔ | Byt filnamn |
| 23 | `DELETE /api/v1/bids/{bidId}/attachments/{attachmentId}` | ✔ | Radera dokument |

### 6.1 Detaljer per API

**1. `POST /auth/register`** → `201`
`{ email, password, displayName }` → `{ id, email, displayName, emailVerified, token }`.
Skickar ett bekräftelsemail med en verifieringslänk. Går mailet inte fram misslyckas
registreringen — bättre än ett konto som aldrig går att logga in på.
Lösenord ≥ 12 tecken, hashas med `Bun.password.hash` (argon2id). Dubblett-e-post ⇒ `409`.
E-post normaliseras (trim + lowercase, `citext`).

**9. `GET /validate-user?token=<uuid>`** → `200`
Målet för länken i bekräftelsemailet, och därför öppen — den klickas ur ett mailprogram
utan token. Sätter `email_verified = true` och svarar `{ verified, email }`.
Idempotent: länken tål att klickas flera gånger. Okänd token ⇒ `404`, token som inte är en
uuid ⇒ `422`.

`verification_token` är en **egen uuid på users**, inte användarens id. Id:t syns i
API-svaren och i avtalens frysta villkor, och får därför inte kunna användas för att
bekräfta ett konto.

**Länken gäller i 24 timmar.** En passerad länk ger `410 Gone` med
`verification-token-expired`, inte 404: skillnaden är åtgärdbar för användaren — begär ett
nytt mail — medan en okänd token inte är det. Att skilja dem kostar en extra `SELECT`, men
bara i missfallet.

Idempotensen väger tyngre än utgångstiden för ett **redan bekräftat** konto: en länk som
fungerade igår ska inte plötsligt bli ett fel, så `email_verified = true` kortsluter
utgångskontrollen (V.25).

**10. `POST /auth/resend-verification`** → `202`
`{ email }` → `{ accepted: true }`. Öppen, eftersom den som behöver den inte kan logga in.

**Svaret är identiskt i alla utfall** — okänd adress, redan bekräftat konto, eller begäran
inom kylperioden. Villkoren ligger i `WHERE`-satsen i `rotateVerificationToken`, så routen
*kan* inte råka svara olika: den vet inte vilket fall det var. Utan det vore endpointen ett
sätt att kartlägga vilka adresser som är registrerade.

**Token roteras**, vilket gör den föregående länken ogiltig. Bara det senast utskickade
mailet gäller — utan utgångstid är det den enda begränsningen som finns.

**Kylperiod på 60 sekunder.** En oautentiserad endpoint som skickar mail är annars ett sätt
att bombardera en adress. `verification_sent_at` bär tidsstämpeln; inom kylperioden skickas
inget, men svaret är detsamma.

**11–12. Lösenordsåterställning**
`POST /auth/forgot-password` `{ email }` → `202 { accepted: true }`, samma
läckagefria mönster och kylperiod som API 10.
`POST /auth/reset-password` `{ token, password }` → `200 { reset, email }`.

**Egna kolumner, skilda från verifieringen.** En återställningskod får aldrig kunna
användas för att bekräfta en adress, eller tvärtom — därför `password_reset_token` och inte
återanvänd `verification_token`.

**Koden gäller i 1 timme** — kortare än bekräftelselänkens 24, eftersom den är känsligare:
den byter lösenord i stället för att bara bekräfta en adress.

**Engångsbruk.** Vid lyckad återställning nollas token. Andra försöket ger `404`, inte
`410`: koden finns inte längre alls. Ett *misslyckat* försök — för kort lösenord — bränner
den däremot inte (R.10).

**Återställning bekräftar inte adressen.** Att kunna läsa mailen bevisar visserligen
kontroll över brevlådan, men flödena hålls isär: den som glömt lösenordet före bekräftelsen
får bekräfta separat (R.14). Enklare att resonera om, och de två koderna byter aldrig roll.

**Alla tidigare access-tokens slutar gälla.** `users.token_version` höjs i samma `UPDATE`
som byter lösenordet, och varje token bär versionen som `ver`-claim. `requireAuth` jämför
dem — uppslaget gör den ändå för verifieringskontrollen, så revokeringen kostar ingenting
extra. En token utan `ver`, utfärdad innan versionerna fanns, matchar aldrig och avvisas.

Svaret är `401 token-revoked` med besked om att lösenordet ändrats. Att säga varför röjer
inget: bäraren har redan en giltigt signerad token för kontot.

Det här är ett versionsnummer, inte ett sessionsregister. Det räcker för "byt lösenord och
lås ut alla", men inte för att logga ut en enskild enhet — det kräver fortfarande arbetet
i §10.

**13. `POST /auth/logout`** → `200 { loggedOut: true }`
Avslutar **den session token tillhör**. Andra sessioner för samma konto berörs inte — logga
ut på telefonen utan att datorn kastas ut. Vill man avsluta samtliga: byt lösenord.

En stateless JWT går inte att ta tillbaka, bara att neka. Varje token bär därför ett eget
`jti`, och utloggningen lägger det i `revoked_tokens` **till tokenens egen utgångstid** —
inte längre, raden behövs inte efter det.

Kontrollen kostar ingenting extra: `EXISTS`-uttrycket ryms i samma uppslag som redan görs
för tokenversion och e-postbekräftelse. Tabellen städas opportunistiskt vid varje
utloggning, vilket är precis när den växer — inget bakgrundsjobb behövs.

Andra gången samma token loggas ut ger `401 session-ended`; den är redan avslutad och
kommer aldrig förbi `requireAuth`.

**14. `POST /auth/refresh`** → `200 { token, expiresIn, refreshToken, refreshExpiresIn }`
Öppen: den som behöver refresha har per definition ingen giltig access-token.
Registrering och inloggning returnerar nu också `refreshToken` (30 dagar).

**Ogenomskinliga slumpsträngar, aldrig JWT.** De lever länge och måste gå att återkalla,
vilket en stateless token inte kan. Lagras som SHA-256 — värdet är redan 256 bitar slump,
så det finns inget att brute-forca, och uppslaget måste vara en indexträff (argon2 vore
fel verktyg här, till skillnad från för lösenord).

**Rotation med återanvändningsdetektering.** Varje token duger en gång. Dyker en redan
förbrukad upp igen finns den på två ställen — den ursprungliga klienten och någon annan —
och då avslutas hela sessionen. Den bestulne får logga in igen, tjuven kommer ingenstans.

**`session_id` överlever rotationen** och binder ihop kedjan med access-tokens `sid`-claim.
Det är så utloggning kan avsluta hela sessionen; utan den kopplingen räcker det att refresha
för att komma tillbaka in efter utloggning, och API 13 vore verkningslös.

**Lösenordsbyte återkallar alla sessioner.** `token_version` stänger access-tokens, men
refresh-tokens har ingen version att jämföra mot och måste återkallas var för sig.

**`consumed_at` och `revoked_at` är skilda kolumner**, för de betyder olika saker för den
som presenterar token: förbrukad-och-återanvänd betyder att den läckt, återkallad betyder
att sessionen avslutats. Slås de ihop får den som *loggat ut normalt* beskedet att deras
token blivit stulen. Det upptäcktes först när flödet kördes mot levande Aspire — testerna
kontrollerade bara statuskoden, som är 401 i båda fallen.

**2. `POST /auth/login`** → `200`
`{ email, password }` → `{ token, expiresIn }`. Fel användare *och* fel lösenord ger
samma `401` med samma svarstid (`Bun.password.verify` körs mot en dummyhash även för okänd
e-post — se testfall A2.3).

Login-schemat har medvetet **ingen** `minLength` på lösenordet, till skillnad från
register-schemat: annars kan man läsa ut lösenordsreglerna genom att se ett kort lösenord
ge `422` istället för `401`.

**Obekräftad adress ⇒ `403 email-not-verified`.** Kontrollen sker *efter* lösenordet, inte
före: annars gick det att kartlägga vilka adresser som finns registrerade genom att jämföra
`401` mot `403`. Den som redan kan lösenordet får däremot veta exakt vad som saknas.

Samma spärr gäller **varje skyddad route**, inte bara inloggningen: `requireAuth` slår upp
kontot efter att token verifierats och avvisar obekräftade med `403`, samt token vars konto
inte längre finns med `401`. Det kostar en primärnyckelträff per skyddad begäran.

Alternativet — `email_verified` som claim i token — vore fel byte: claimen blir inaktuell i
samma stund användaren klickar på bekräftelselänken, och registreringens token skulle då
aldrig kunna börja fungera. Med uppslaget gäller i stället att **samma token börjar fungera
direkt efter bekräftelsen, utan ny inloggning** (V.11).

**3. `GET /me/requests`** → `200`
`{ items: [{ …request, bids: [{ id, sellerId, sellerDisplayName, plan, compensation, estimatedTotalMinor, status, createdAt }] }], nextCursor }`.
Endast anropande användares egna förfrågningar. Anbudens `plan`-fält ingår — köparen ska
kunna bedöma dem. Sortering: nyaste först. Sidbrytning via `?limit&cursor` (default 20,
max 100).

Markören är ogenomskinlig (base64url av `created_at|id`) och pekar på sista raden i
föregående sida. Inte offset: med offset tappar eller upprepar man rader när nya
förfrågningar tillkommer mitt i bläddringen. `nextCursor` är `null` på sista sidan.

Anbuden hämtas i **en** extra fråga för hela sidan, inte en per förfrågan.

**4. `GET /me/bids`** → `200`
`{ items: [{ id, requestId, requestTitle, plan, compensation, estimatedTotalMinor, status, contract: { id, status, buyerSigned, sellerSigned } | null, createdAt }], nextCursor }`.
Endast egna anbud. Filtrering via `?status=`, och samma markörsidbrytning som API 3 —
en obegränsad lista är ett problem som växer tyst.

**5. `POST /requests`** → `201`
`{ title, description, compensationPref, budget?: { amountMinor, currency }, deadlineAt? }`.
`deadlineAt` måste ligga i framtiden. Skaparen blir köpare.

**6. `POST /requests/{id}/bids`** → `201`
`{ plan, compensation: { type:'fixed', amountMinor, currency? } | { type:'hourly', rateMinor, estimatedHours, currency? } }`.
Svaret innehåller dessutom `estimatedTotalMinor` — beräknat totalbelopp, för timanbud
rate × timmar avrundat till hela ören. Köparen ska kunna jämföra anbud utan att räkna själv.
`403` på egen förfrågan, `409` vid dubbelt anbud, `422` om förfrågan är stängd eller deadline passerat.

> **Avvikelse från planen.** Unionen uttrycks som `anyOf` med `const` på `type`, inte som
> OpenAPI:s `discriminator`. TypeBox genererar `anyOf`, medan Ajv:s discriminator-stöd
> kräver `oneOf`, och nyckelordet fälls dessutom av strict mode
> (*"unknown keyword: discriminator"*). Att slå av `strictSchema` globalt för en ren
> dokumentationsvinst är fel byte — valideringen blir identisk, och F6.3 fångas av
> `additionalProperties: false` i varje gren.
>
> Av samma orsak har `currency` **ingen `default` i schemat**: Ajv applicerar inte defaults
> inuti `anyOf`-grenar och fäller schemat i strict mode. Fältet är valfritt och fylls i av
> koden (`currencyOr` i `domain/money.ts`). Samma sak gäller `budget.currency` i API 5, så
> reglerna är desamma på båda ställena.

**7. `POST /bids/{bidId}/contract/signatures`** → `200`
Ingen body. Semantik:
- Anropas av **köparen** (ägare av förfrågan) när inget avtal finns ⇒ avtalet skapas med
  `terms` frusna från anbudet, `buyer_signed_at` sätts, status `pending_signatures`.
- Anropas av **säljaren** (anbudsägaren) när avtal finns ⇒ `seller_signed_at` sätts.
- När båda finns ⇒ `active`, förfrågan `awarded`, övriga anbud `rejected`.
- Säljaren först, innan köparen skapat avtalet ⇒ `409` (det finns inget att signera).
- Tredje part ⇒ `403`. Redan signerat av samma part ⇒ `200`, oförändrat.

Svar: `{ contractId, status, buyerSignedAt, sellerSignedAt, terms }`.

**Ingen kropp — men `content-type: application/json` måste tålas.** Fastify avvisar annars
en tom kropp med 400 (*"Body cannot be empty…"*), och de flesta HTTP-klienter sätter
content-type på varje POST oavsett. Det upptäcktes först när flödet kördes mot levande
Aspire: `inject()` utan payload sätter ingen content-type, så hela testsviten missade det.
Parsern i `plugins/validation.ts` gör en tom kropp till `undefined`, vilket för routes som
kräver en kropp faller ut som 422 istället för 400. Låst av S7.1b–S7.1d.

**Serialisering.** Låset tas på **förfrågningsraden** (`FOR UPDATE OF r`), inte på avtalet:
avtalet finns inte ännu när den första signaturen kommer, så det går inte att låsa. En
förfrågan kan bara ha ett avtal, vilket gör förfrågan till rätt seriliseringspunkt.

**8. `GET /requests`** → `200`
Katalogen: uppdrag som faktiskt går att lämna anbud på. Filtrerar på `status = 'open'` och
deadline som inte passerat — en tilldelad eller utgången förfrågan är brus för den som letar
uppdrag. Sidbrytning som API 3–4, filter via `?compensationPref=`.

Varje post bär `buyerDisplayName`, `bidCount` och `hasMyBid`, plus `canBid` som är falskt
för egna förfrågningar och när anroparen redan lämnat anbud — det sparar ett anrop som ändå
skulle ge 403 eller 409.

**Anbudens innehåll lämnas aldrig ut här**, bara antalet. Vem som bjudit vad är en sak
mellan köparen och respektive säljare, och L8.7 vaktar det.

**15–18. Läsrättigheter på en förfrågan**
Köparen äger sin förfrågan och kan låta andra läsa den — typiskt kollegor som ska bedöma
anbuden. Tilldelas med e-postadress, för man känner sin kollegas adress och inte hens uuid.
Okänd adress ger `404`, vilket röjer att adressen inte finns registrerad; alternativet
vore ett id ingen kan få tag på.

Bara ägaren tilldelar, listar och återkallar (`403` annars) — en behörig kan inte dela
vidare. Dubbel tilldelning är idempotent: `200` i stället för `201`, och `granted_at` rörs
inte. Återkallande stänger åtkomsten omedelbart, vid nästa anrop.

`GET /requests/{id}` tillkom för att göra läsrätten meningsfull: utan den kan en behörig
varken se vilka anbud som finns eller nå deras id:n, och rättigheten öppnar bara dörrar
man inte hittar. Katalogen (`GET /requests`) är fortfarande vägen in för den som *letar*
uppdrag; den här är för den som redan vet vilken förfrågan det gäller.

**Läsningen är öppen för alla inloggade, anbuden är det inte.** Endpointen nekade först
alla utom köparen och den med läsrätt, men då kunde en säljare aldrig öppna förfrågan hen
just hittat i katalogen — och alla säljare får lämna anbud till vilken köpare som helst.
Det är *anbuden* som är känsliga, inte förfrågan: köparen och den med läsrätt ser alla,
alla andra ser bara sitt eget. Samma regel som L8.7 vaktar i katalogen, och rättigheten
behåller sitt värde — den handlar om att få se anbuden.

**19–23. Anbudsdokument**
Markdown och PDF, högst 10 MB per fil och 20 per anbud. Får läggas till **när som helst**,
även efter signerat avtal — villkoren i `contracts.terms` är fortfarande frysta (S7.7),
dokument är komplement och inte avtalsinnehåll.

**Filtypen avgörs av innehållet.** En PDF måste börja med `%PDF-`, Markdown måste vara
giltig UTF-8. Filändelsen är ett påstående från klienten; kontrollen är vad som hindrar att
något annat smugglas in som `anbud.pdf`. Fel innehåll ger `415`, inte `422` — det är
medietypen som inte duger. Ett *filnamn* som inte duger är däremot ett vanligt fältfel.

**Filnamn saneras** från sökvägar, `..` och kontrolltecken innan de sparas: namnet hamnar i
ett arkiv som packas upp på någon annans dator. Åäö behålls — arkivet ska vara läsbart.
Namnet är unikt inom anbudet, annars kolliderar två filer i samma ZIP.

**Innehållet ligger i objektlagring**, inte i databasen. `bid_attachments` bär bara
`storage_key`, och nyckeln är `bids/{bidId}/{attachmentId}` — utan filnamnet, så ett
namnbyte är en ren databasoperation som aldrig rör lagringen (B.18).

Ordningen vid uppladdning är objekt först, rad sedan: **ett objekt utan rad är skräp som
går att städa, en rad utan objekt är ett dokument som inte går att ladda ner.** Avvisas
raden — filnamnet upptaget — städas objektet bort direkt (B.19). Skulle de ändå glida isär
hoppas ett saknat objekt över i arkivet i stället för att fälla hela nedladdningen (B.20);
resten av dokumenten är fortfarande vad mottagaren bad om.

`Bun.S3Client` hanterar objekten, men inte buckets, och MinIO startar tom vid varje
`aspire run`. Bucketen skapas därför vid boot med en signerad `PUT` via `aws4fetch` —
`409` betyder att den redan finns, vilket är precis vad vi ville uppnå.

**Föräldralösa objekt städas av ett sopjobb** (`storage/sweeper.ts`), som var 60:e minut
listar bucketen och raderar objekt utan rad i `bid_attachments`. Två skydd gör det ofarligt:

- **En frist på en timme.** Objekt yngre än så rörs inte — annars kunde jobbet radera en
  fil som just nu ligger mellan `put` och `INSERT`.
- **Tomt dokumentregister stoppar allt.** Noll rader plus objekt i lagringen är mycket
  troligare en felkonfiguration — tjänsten pekar på fel databas — än en bucket som råkar
  bestå av enbart skräp. Raderingen är oåterkallelig, så jobbet avstår och säger ifrån.
  Priset är att "alla dokument raderade, skräp kvar" inte städas; det felar åt rätt håll.

Jobbet startas i `index.ts` och inte i `buildServer`: en timer hör till processen, inte
till appen, och testerna ska aldrig få en bakgrundstråd på köpet. Databasen frågas en gång
per sida om vilka nycklar som är kända — aldrig hela registret i minnet, aldrig en fråga
per objekt.

**Rader utan objekt behandlas tvärtom.** Samma genomgång stämmer av åt andra hållet: en rad
vars innehåll saknas i lagringen **markeras, aldrig raderas**. Ett föräldralöst objekt är
skräp; en rad utan objekt är ett *fel* någon behöver få veta om. Raden är beviset på att
säljaren bifogat något, och att tyst ta bort den vore att låta ett lagringsfel se ut som om
dokumentet aldrig funnits.

Markeringen (`content_missing_since`) syns i API:et som `available: false` — köparen ser
att dokumentet finns, att det saknas, och slipper undra varför det inte ligger i ZIP-filen.
Kommer objektet tillbaka, till exempel efter en återläsning, tas markeringen bort igen.

Skyddet är spegelvänt mot det första: **en bucket utan ett enda objekt markerar ingenting.**
Rader men noll objekt är troligare fel bucket än att varenda fil försvunnit, och att
markera allt som trasigt vore lika fel som att radera allt.

Nycklarna samlas under samma genomgång som skräpletandet, så avstämningen kostar inga extra
anrop. Minnet växer med antalet objekt i bucketen — bara strängar, men värt att veta:
alternativet vore ett HEAD-anrop per rad.

**Larm när något markeras.** En markering betyder att lagringen tappat data, vilket är mer
än en loggrad värt. `STORAGE_ALERT_EMAIL` får ett mail som namnger dokumenten; i
utvecklingsmiljön är det `drift@fastgig.dev` och landar i mailpit bland all annan post.

**Ett mail per körning, aldrig ett per dokument.** Ett lagringsfel kan slå ut tusen
dokument på en gång, och tusen mail är inte ett larm utan ett haveri i sig. Listan kortas
av efter 15 poster, men antalet framgår alltid.

**Ingen upprepning behövs.** Ett redan markerat dokument markeras inte en andra gång
(G.11), så varje trasigt dokument larmar exakt en gång — utan kylperiod, utan tillstånd att
hålla reda på. Det följer av markeringen och behövde inte byggas.

Ett misslyckat larm fäller inte städningen: markeringen är gjord och står kvar i databasen,
och `alertFailed` skiljer "posten gick inte fram" från "städningen misslyckades".
Larmet ligger i `storage/sweep-job.ts` och inte i `index.ts`, så det går att pröva utan att
starta en process med en timer i.

**Rättighetsmatrisen:** skriva (ladda upp, byta namn, radera) är säljarens ensak. Läsa och
ladda ner ZIP kan säljaren, förfrågans köpare, och den som tilldelats läsrätt. Ett anbud
utan dokument ger ett **tomt arkiv med `200`**, inte `404`: frågan "vad har säljaren
bifogat?" har svaret "ingenting", vilket inte är ett fel.

> **ZIP-arkivet byggs med JSZip, inte fflate.** fflate sätter inte UTF-8-flaggan (bit 11)
> i ZIP-huvudet, så `unzip` tolkar filnamnen som CP437 och `förslag.md` blir
> `f├╢rslag.md` hos mottagaren. Testet läste tillbaka arkivet med *samma bibliotek som
> skrev det* och märkte ingenting — felet syntes först när arkivet packades upp med
> systemets `unzip`. B.9 granskar nu flaggbiten i råa byten i stället för att lita på en
> rundtur.

> Detta är den enda designtolkning i planen som inte är direkt given av uppgiften: kravlistan
> nämner "signera avtal" men inget separat "acceptera anbud". Vi låter köparens signatur
> *vara* accepterandet, vilket håller ytan vid sju API:er utan att tappa något steg i flödet.
> Om ett explicit accept-steg önskas är det en additiv ändring (nytt API 8), inte en omskrivning.

---

## 7. Testdriven leverans

Testerna är specifikationen. Ingen route-kod skrivs innan ett rött test finns som beskriver
den, och varje etapp i §9 är klar först när dess testfall är gröna.

### 7.1 Testinfrastruktur

**Databas.** `test/helpers/postgres.ts` styr podman direkt med `Bun.$` — ingen
Testcontainers-dependency, ingen Ryuk. Containern har ett **fast namn**
(`fastgig-test-pg`) och **återanvänds mellan körningar**: finns den redan igång används
den som den är, annars startas den.

Migrationerna körs en gång per körning mot `fastgig_template`, och varje testfil får en
färsk databas:

```sql
CREATE DATABASE test_<pid>_<n> TEMPLATE fastgig_template;
```

Det ger full isolering mellan filer utan att betala migrationskostnaden per fil.
`CREATE DATABASE … TEMPLATE` är verifierat mot `Bun.SQL` (§2.2).

Återanvändningen kostar inget i isolering — malldatabasen byggs om vid varje körning
(`DROP … WITH (FORCE)` + `CREATE`) och kvarlämnade `test_%`-databaser städas bort vid
uppstart — men den avgör om dialogloopen är användbar. Mätt i etapp 1:

| | Full svit | Ett fallerande test |
|---|---|---|
| Kall (containern startas) | 3,3 s | 3,3 s |
| Varm (containern återanvänds) | **1,4 s** | **0,95 s** |

Containern lämnas alltså kvar när körningen är slut. Riv den för hand med
`podman rm -f fastgig-test-pg` när du vill börja om från noll.

`TEST_DATABASE_URL` i miljön kringgår podman helt och kör mot en redan uppe
Aspire-Postgres — praktiskt när man vill inspektera data i pgweb efter ett fallerande test.

En fallgrop värd att känna till: **flerradiga `Bun.$`-literaler bryter kommandot vid
radbytet** (`bun: command not found: -e`). Långa podman-anrop byggs som en argumentarray
och interpoleras i ett svep: `` $`podman ${runArgs}` ``.

**Två valideringsregimer.** Fastify har en validator-kompilator, men kroppar och
query-parametrar har olika behov, så `plugins/validation.ts` väljer regim per `httpPart`:

- **body** — inget typtvång. `{"amountMinor": "4500000"}` ska ge 422, inte tyst städas upp
  till ett tal. Låst av testfall F5.4c.
- **querystring och params** — typtvång på. Allt kommer in som strängar över HTTP, så utan
  det går ett heltal i `?limit=2` inte att uttrycka i schemat alls.

**App.** `buildServer()` returnerar en `FastifyInstance` utan att lyssna på någon port.
Testerna använder `app.inject({ method, url, headers, payload })`. Ingen nätverksstack,
inga portkonflikter, millisekunder per anrop. Verifierat på Bun (§2.2).

**Aktörer.** `test/helpers/actors.ts` ger `const buyer = await actor(app, 'buyer')` med
`buyer.post(url, body)` som redan bär rätt `Authorization`-huvud. Testerna handlar då om
domänen, inte om token-hantering.

Hjälparen bygger på `POST /auth/register` och kunde därför inte skrivas förrän det API:t
fanns. Den landade i **etapp 2**, driven av A1-testfallen, inte i etapp 1 — att skriva en
hjälpare som ingenting kan köra är precis den sortens obekräftad kod planen försöker
undvika.

**Prövning utan publik route.** `buildTestApp({ extraRoutes })` registrerar routes som bara
finns i testet, före `app.ready()`. Det är så `requireAuth` prövas (A2.1, A2.4) utan att
API-ytan växer utanför de sju i §6.

### 7.2 Testfallsmatris

Varje rad är ett `test()`. ID:t är stabilt och används som referens i prompt-dialogen
("kör A2.3", "ändra F6.4 till 422") och som filter: `bun test -t A2.3`.

| ID | Test |
|---|---|
| **A1** | **Registrering** |
| A1.1 | Giltig registrering ⇒ 201, lösenordet syns inte i svaret, och token duger först efter bekräftelse |
| A1.2 | Dubblett-e-post (även med annan skiftlägesform) ⇒ 409 |
| A1.3 | Lösenord < 12 tecken ⇒ 422 med fältpekare |
| A1.4 | Trasig e-postadress ⇒ 422 |
| A1.5 | Lösenordet lagras aldrig i klartext (kontroll direkt mot tabellen, hashen är argon2id) |
| **A2** | **Inloggning** |
| A2.1 | Rätt uppgifter ⇒ 200 + token som accepteras av ett skyddat API |
| A2.2 + A2.3 | Fel lösenord respektive okänd e-post ⇒ 401 med **byte-identisk** kropp (ett testfall, eftersom likheten är själva påståendet) |
| A2.4 | Utgången, manipulerad, obegriplig och saknad token ⇒ 401 |
| **F5** | **Registrera förfrågan** |
| F5.1 | Giltig förfrågan ⇒ 201, status `open`, buyerId = anroparen, budget som `number` |
| F5.1b | Budget och deadline är valfria ⇒ `null` i svaret, inte utelämnade fält |
| F5.2 | Utan token ⇒ 401 |
| F5.3 | Deadline i dåtid ⇒ 422 med pekare på `deadlineAt` |
| F5.4 | Budget med negativt belopp ⇒ 422 med pekare på `budget.amountMinor` |
| F5.4b | Nollbudget ⇒ 422 |
| F5.4c | Belopp som sträng i kroppen typtvingas **inte** ⇒ 422 (låser fast att kroppar valideras strikt, se §7.1) |
| F5.5 | Titel över maxlängd (120) ⇒ 422 |
| F5.5b | Tom titel ⇒ 422 |
| F5.5c | Okänd `compensationPref` ⇒ 422 |
| **F6** | **Registrera anbud** |
| F6.1 | Fastprisanbud ⇒ 201, status `submitted`, timkolumnerna tomma i databasen |
| F6.2 | Timanbud med rate + estimatedHours ⇒ 201, `estimatedTotalMinor` beräknad |
| F6.2b | Anbud utan token ⇒ 401 |
| F6.3 | `type:'fixed'` men `rateMinor` skickas ⇒ 422 |
| F6.3b | `type:'hourly'` utan `estimatedHours` ⇒ 422 |
| F6.4 | Anbud på egen förfrågan ⇒ 403 |
| F6.5 | Andra anbudet från samma säljare på samma förfrågan ⇒ 409 |
| F6.5b | En annan säljare får lämna anbud på samma förfrågan ⇒ 201 |
| F6.6 | Anbud efter deadline ⇒ 422 |
| F6.7 | Anbud på okänd förfrågan ⇒ 404 |
| F6.7b | `requestId` som inte är en uuid ⇒ 422 |
| F6.8 | Anbud på `awarded` förfrågan ⇒ 422 |
| **L3** | **Lista egna förfrågningar med anbud** |
| L3.1 | Returnerar bara egna förfrågningar, aldrig andras |
| L3.2 | Inkluderar inlämnade anbud med plan, ersättning, säljarens namn och status |
| L3.2b | Anbud på andras förfrågningar läcker inte in i svaret |
| L3.3 | Förfrågan utan anbud ⇒ tom `bids`-lista, inte utelämnat fält |
| L3.4 | Sidbrytning: `limit` respekteras, `cursor` ger nästa sida utan dubbletter och utan tappade rader |
| L3.4b | Nyaste först |
| L3.4c | Trasig `cursor` ⇒ 422 med pekare på `cursor` |
| L3.4d | `limit` utanför 1–100 ⇒ 422 |
| L3.5 | Utan token ⇒ 401 |
| **L4** | **Lista egna anbud** |
| L4.1 | Returnerar bara egna anbud |
| L4.1b | Anbudet bär förfrågans titel och beräknat totalbelopp |
| L4.1c | Utan token ⇒ 401 |
| L4.2 | Status speglar avtalsflödet (`submitted` → `accepted`/`rejected`) |
| L4.3 | `contract` är `null` innan avtal finns |
| L4.3b | `contract` visar signaturläget när avtal finns |
| L4.4 | `?status=` filtrerar |
| L4.4b | Okänd status ⇒ 422 |
| L4.4c | Sidbrytning fungerar som för förfrågningar |
| **S7** | **Signera avtal** |
| S7.1 | Köparens signatur skapar avtal ⇒ 200, `pending_signatures`, terms frusna, förfrågan fortfarande `open` |
| S7.1b | Tom kropp med `content-type: application/json` ⇒ 200 (se §6.1) |
| S7.1c | Tom kropp där en kropp krävs ⇒ 422, inte 400 |
| S7.1d | Trasig JSON ⇒ 400 |
| S7.2 | Säljarens signatur därefter ⇒ `active` |
| S7.3 | Vid `active`: förfrågan blir `awarded`, vinnande anbud `accepted`, övriga `rejected` |
| S7.3b | Ett avslaget anbud går inte att signera ⇒ 422 |
| S7.4 | Säljaren signerar först ⇒ 409 |
| S7.4b | Okänt anbud ⇒ 404 |
| S7.4c | Utan token ⇒ 401 |
| S7.5 | Utomstående användare ⇒ 403 |
| S7.5b | Utomstående ⇒ 403 även innan avtalet finns |
| S7.6 | Samma part signerar två gånger ⇒ 200, oförändrade tidsstämplar, ett avtal i tabellen |
| S7.6b | Signatur på ett redan aktivt avtal ändrar ingenting |
| S7.7 | Ändrat anbud efter avtalet påverkar inte `terms` |
| S7.8 | Två samtidiga signaturer ger exakt ett avtal (`FOR UPDATE`-test) |
| S7.8b | Samtidiga signaturer från båda parter aktiverar avtalet en gång |
| **M** | **Migrationsrunner** (etapp 1) |
| M.1 | Migrationerna läses i filnamnsordning |
| M.2 | En katalog utan migrationer är inte ett fel |
| M.3 | `migrate` applicerar i ordning och är idempotent vid andra körningen |
| M.4 | En migration som fallerar halvvägs rullas tillbaka helt och bokförs inte |
| M.5 | Migrering från tom databas: malldatabasen rivs och byggs om vid varje testkörning, så hela migrationskedjan körs från noll varje gång. Endast `index.ts`-anropet vid boot är otestat, och det verifierades manuellt mot Aspire i etapp 2 |
| **D** | **Domänenheter (utan databas)** |
| D.1 | Ersättningsformen till och från kolumner: fastpris fyller bara fixed-kolumnen, timpris bara timkolumnerna, ogiltiga belopp och timmar kastar, och en rad som bryter mot formen tolkas inte utan kastar |
| D.2 | Totalberäkning: fastpris är sitt eget total, timpris = rate × timmar avrundat i minorenhet, halva ören uppåt, ingen flyttalsdrift |
| D.3 | Signaturstatens övergångar som ren funktion: första signaturen aktiverar inte, andra gör det, ordningen är likgiltig, samma part igen är verkningslös, `void` går inte att signera, indata muteras inte |
| D.4 | `bigint` från `Bun.SQL` (string) → `number`; null förblir null; belopp utanför säkra heltal och skräp kastar; `toMinorColumn` kräver positivt heltal |
| **L8** | **Lista öppna förfrågningar** (API 8) |
| L8.1 | En säljare ser öppna förfrågningar från andra, med köparens namn |
| L8.2 | Utan token ⇒ 401 |
| L8.3 | Tilldelade förfrågningar visas inte |
| L8.4 | Passerad deadline visas inte; förfrågan helt utan deadline visas |
| L8.5 | `bidCount` räknar anbuden, `hasMyBid` speglar bara anroparens eget |
| L8.6 | `canBid` är falskt för egen förfrågan och när anbud redan lämnats |
| L8.7 | Inga anbudsdetaljer läcker — varken plan eller belopp |
| L8.8 | `?compensationPref` filtrerar; okänt värde ⇒ 422 |
| L8.9 | Sidbrytning utan dubbletter, nyaste först |
| **V** | **E-postverifiering** (API 9) |
| V.1 | Registrering skickar ett mail till adressen med en verifieringslänk |
| V.2 | Ett nytt konto är overifierat och bär en egen token, skild från användarens id |
| V.3 | Länken ur mailet sätter `email_verified` och svarar `{ verified, email }` |
| V.4 | Samma länk igen är ofarlig — 200 och oförändrat svar |
| V.5 | Okänd token ⇒ 404 |
| V.6 | Token som inte är uuid ⇒ 422; helt utan token ⇒ 422 |
| V.7 | Inloggning före verifiering ⇒ 403 `email-not-verified` |
| V.7b | Fel lösenord på ett overifierat konto ⇒ fortfarande 401, inget läckage |
| V.8 | Inloggning efter verifiering fungerar |
| V.9 | Mailet innehåller inte lösenordet |
| V.10 | Registreringens token duger inte mot ett skyddat API före verifiering ⇒ 403 |
| V.11 | Samma token börjar fungera när adressen bekräftats, utan ny inloggning |
| V.12 | Token för ett konto som inte finns kvar ⇒ 401 |
| V.13 | Begäran om nytt mail skickar ett nytt mail med en ny länk |
| V.14 | Den gamla länken slutar gälla ⇒ 404 |
| V.15 | Den nya länken verifierar kontot, och inloggning fungerar därefter |
| V.16 | Okänd adress ⇒ 202 utan att något mail skickas |
| V.17 | Redan verifierat konto ⇒ 202 utan mail |
| V.18 | Svaret är byte-identiskt i alla tre fallen |
| V.19 | Upprepad begäran inom kylperioden skickar inte fler mail |
| V.20 | Trasig e-postadress ⇒ 422 |
| V.21 | Utgångstiden sätts vid registrering och ligger ~24 h fram |
| V.22 | En passerad länk ⇒ 410 `verification-token-expired`, och kontot förblir obekräftat |
| V.23 | Ett nytt bekräftelsemail ger en länk som fungerar igen |
| V.24 | Rotationen flyttar fram utgångstiden |
| V.25 | Ett redan bekräftat konto tål att länken passerat — idempotensen består |
| **R** | **Lösenordsåterställning** (API 11–12) |
| R.1 | Begäran skickar ett mail med en kod, och utan det gamla lösenordet |
| R.2 | Okänd adress ⇒ 202 utan mail |
| R.3 | Svaret är identiskt för känd och okänd adress |
| R.4 | Kylperioden stoppar upprepade utskick |
| R.5 | Koden sätter ett nytt lösenord, och inloggning med det fungerar |
| R.6 | Det gamla lösenordet slutar fungera ⇒ 401 |
| R.7 | Koden går bara att använda en gång ⇒ 404 andra gången |
| R.8 | Utgången kod ⇒ 410, och det gamla lösenordet gäller fortfarande |
| R.9 | Okänd kod ⇒ 404 |
| R.10 | För kort nytt lösenord ⇒ 422, och koden bränns inte |
| R.11 | En ny begäran ogiltigförklarar den förra koden |
| R.12 | Trasig e-postadress ⇒ 422 |
| R.13 | Kod som inte är uuid ⇒ 422 |
| R.14 | Återställning bekräftar inte adressen |
| R.15 | En token utfärdad före återställningen ⇒ 401 `token-revoked` |
| R.16 | En token utfärdad efter återställningen fungerar |
| R.17 | Andra användares tokens påverkas inte |
| R.18 | En token utan `ver`-claim avvisas |
| R.19 | Varje återställning ogiltigförklarar den föregående sessionen |
| **U** | **Utloggning** (API 13) |
| U.1 | Utloggning ⇒ 200, och token ger sedan 401 `session-ended` |
| U.2 | Utloggning utan token ⇒ 401 |
| U.3 | Samma token loggar inte ut två gånger ⇒ 401 |
| U.4 | Andra sessioner för samma användare påverkas inte |
| U.5 | Andra användare påverkas inte |
| U.6 | Ny inloggning efter utloggning fungerar |
| U.7 | Utloggning städar bort utgångna rader ur `revoked_tokens` |
| U.8 | Utloggning och lösenordsbyte krockar inte |
| **T** | **Refresh-tokens** (API 14) |
| T.1 | Inloggning returnerar en refresh-token med egen, längre livslängd |
| T.2 | Registrering returnerar också en |
| T.3 | Refresh ger en ny fungerande access-token, utan att kräva någon |
| T.4 | Rotation: den förbrukade token slutar gälla, den nya fungerar |
| T.5 | Återanvänd token ⇒ 401 `refresh-token-reused`, och hela kedjan dör |
| T.6 | Okänd token ⇒ 401; tom ⇒ 422 |
| T.7 | Utgången token ⇒ 401 |
| T.8 | Utloggning hindrar refresh — och ger `invalid`, inte `reused` |
| T.9 | Utloggning berör bara sin egen session |
| T.10 | Lösenordsbyte dödar alla refresh-tokens, utan att anklaga någon |
| T.11 | Token lagras aldrig i klartext |
| T.12 | En token ger access till sitt eget konto, inte anroparens |
| **P** | **Läsrättigheter** (API 15–18) |
| P.1 | Köparen kan ge en kollega läsrätt ⇒ 201 |
| P.2 | Dubbel tilldelning är idempotent ⇒ 200, oförändrad tidpunkt |
| P.3 | Okänd e-postadress ⇒ 404 |
| P.4 | Köparen kan inte tilldela sig själv ⇒ 422 |
| P.5 | Bara ägaren får tilldela; en behörig kan inte dela vidare ⇒ 403 |
| P.6 | Okänd förfrågan ⇒ 404 |
| P.7 | Ägaren ser listan; andra nekas ⇒ 403 |
| P.8 | Rättigheten går att ta tillbaka; okänd ⇒ 404; bara ägaren får ⇒ 403 |
| P.9 | Ägaren kan läsa sin förfrågan med anbud |
| P.10 | En behörig kan läsa förfrågan och dess anbud |
| P.11 | Utan rättighet ⇒ 200, men utan andras anbud |
| P.12 | Återkallad rättighet stänger anbuden omedelbart |
| P.13 | Läsrätt påverkar inte rätten att lägga anbud |
| P.14 | Rättigheter försvinner med förfrågan |
| P.15 | Säljaren ser sitt eget anbud men inte en annan säljares |
| **B** | **Anbudsdokument** (API 19–23) |
| B.1 | Säljaren kan ladda upp PDF och Markdown ⇒ 201 |
| B.2 | Filtypen avgörs av innehållet: falsk PDF, trasig UTF-8 och andra typer ⇒ 415 |
| B.3 | Filnamn saneras från sökvägar; svenska tecken behålls |
| B.4 | Samma filnamn två gånger ⇒ 409 |
| B.5 | Tom fil ⇒ 422 |
| B.6 | Fler än 20 dokument ⇒ 422 |
| B.7 | Bara säljaren får ladda upp; okänt anbud ⇒ 404 |
| B.8 | Säljare, köpare och behörig ser listan; utomstående ⇒ 403 |
| B.9 | Arkivet innehåller allt med rätt innehåll, svenska filnamn, och **UTF-8-flaggad** |
| B.10 | Anbud utan dokument ⇒ tomt arkiv med 200 |
| B.11 | Behörig kan ladda ner; återkallad rättighet stänger omedelbart; utomstående ⇒ 403 |
| B.12 | Namnbyte fungerar; ändelsen låst; upptaget namn ⇒ 409; samma namn ofarligt |
| B.13 | Radering fungerar, frigör namnet, är säljarens ensak, och andra gången ⇒ 404 |
| B.14 | Dokument följer med anbudet när det raderas |
| B.15 | Dokument går att lägga till även efter signerat avtal |
| B.16 | Innehållet ligger i objektlagringen; `bid_attachments` har ingen `content`-kolumn |
| B.17 | Radering tar bort objektet, inte bara raden |
| B.18 | Namnbyte rör inte lagringen — nyckeln bär inte filnamnet |
| B.19 | En avvisad uppladdning lämnar inget skräp i lagringen |
| B.20 | Ett saknat objekt fäller inte hela arkivet |
| B.21 | Ett dokument redovisas som `available: true` |
| B.22 | Ett dokument vars innehåll saknas redovisas som `available: false`, med metadata kvar, och utelämnas ur arkivet |
| **G** | **Städning av föräldralösa objekt** |
| G.1 | Ett föräldralöst objekt äldre än fristen raderas |
| G.2 | Ett objekt med rad i databasen rörs inte |
| G.3 | Ett nyligen uppladdat objekt rörs inte, även utan rad |
| G.4 | Objekt utanför prefixet rörs inte |
| G.5 | En tom dokumenttabell stoppar städningen helt |
| G.6 | Städningen klarar fler objekt än en sida |
| G.7 | En körning utan skräp rapporterar noll raderade |
| G.8 | En rad vars objekt saknas markeras |
| G.9 | En markerad rad raderas aldrig automatiskt |
| G.10 | Markeringen tas bort om objektet dyker upp igen |
| G.11 | En markerad rad markeras inte om igen |
| G.12 | En tom bucket markerar ingenting |
| G.13 | Markerade dokument namnges i resultatet |
| G.14 | Ett larm skickas när något markeras |
| G.15 | Ett larm per körning, inte ett per dokument |
| G.16 | Inget larm när inget markeras |
| G.17 | Utan konfigurerad larmadress skickas inget |
| G.18 | Ett misslyckat larm fäller inte städningen |
| G.19 | Larmet är avkortat men säger hur mycket som utelämnats |
| **X** | **Tvärsnitt** |
| X.1 | `/docs/json` är OpenAPI 3.1 med ifylld `info` |
| X.1b | Alla sju API:erna finns på rätt metod och väg, med rätt `operationId` |
| X.1c | API-ytan är **exakt** de sju plus `/health` — en oavsiktlig route faller ut här |
| X.1d | Varje `$ref` går att slå upp i `components` |
| X.2 | Varje operation har unikt `operationId`, `tags` och `summary` |
| X.2b | Varje 4xx-svar är beskrivet och har ett kroppsschema |
| X.2c | Skyddade operationer deklarerar `bearerAuth`, öppna gör det inte |
| X.2d | Varje skyddad operation dokumenterar 401 **och** 403 |
| X.3 | `/health` svarar 200 när databasen är nåbar, 503 annars |
| X.4 | Okänd väg ⇒ 404 i Problem Details-format |
| X.4b | Fel metod på en känd väg ⇒ 404 i samma format |
| X.4c | Felsvar från en riktig route är också `application/problem+json` |

Totalt 263 testfall, **alla gröna**. Matrisen är levande — den *ska* ändras i
dialogen (§8.1).

X-gruppen var grön redan när den skrevs, eftersom den beskriver tvärsnitt som byggdes upp
etapp för etapp. Ett test som aldrig varit rött är värdelöst tills motsatsen är visad, så
de muterades: ett duplicerat `operationId`, en borttagen `security` och ett borttaget
401-svar fällde fyra av dem. Mutationerna återställdes.

### 7.3 Körning

```bash
bun test                      # hela sviten
bun test --watch              # primärt läge under dialogen
bun test -t S7                # kör en grupp via ID
bun test test/contract/bids.test.ts
bun run test:coverage         # hela sviten med täckningsrapport
```

**Täckningsrapporten** skrivs till `services/api/coverage/` (gitignorerad):
`lcov.info` för verktyg och CI, `summary.txt` som läsbar tabell. Rapporten omfattar
`src/` — testfilerna och deras hjälpare är bortfiltrerade i `bunfig.toml`, eftersom de
per definition körs till hundra procent och bara späder ut siffran.

Skriptet sätter **`set -o pipefail`**, och det är inte kosmetika: utan det ärver
skriptet exitkoden från `tee` i stället för från `bun test`, och en körning med
fallerande tester skulle rapportera framgång. Verifierat genom att lägga in ett
avsiktligt trasigt test och kontrollera att exitkoden blev 1.

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
| **1** ✅ | Testrigg | `Bun.$`-postgreshelper med återanvänd container + malldatabas, `buildTestApp()`, migrationsrunner med transaktion per migration | **Klar.** X.3 grön (både 200- och 503-vägen); migrationsrunnern har fyra egna testfall (ordning, tom katalog, idempotens, rollback); 6/6 gröna; trasig assertion ger svar på 0,95 s varm |
| **2** ✅ | Konto & inloggning (API 1–2) | `users`-migrering (citext), `Bun.password` (argon2id), `@fastify/jwt`, `requireAuth`, Problem Details-hanteraren, `actors.ts` | **Klar.** A1.\*, A2.\* gröna; 14/14 i hela sviten; register/dubblett/login/fel-lösenord verifierade mot levande Aspire |
| **3** ✅ | Förfrågningar (API 5) | `requests`-migrering (enum-typer, budget-check, sidbrytningsindex), TypeBox-scheman, `domain/money.ts`, route | **Klar.** F5.\* och D.4 gröna; 28/28 i hela sviten |
| **4** ✅ | Anbud (API 6) | `bids`-migrering med CHECK på ersättningsformen och partiellt unikt index, `domain/bid-rules.ts`, route | **Klar.** F6.\*, D.1, D.2 gröna; 49/49 i hela sviten |
| **5** ✅ | Listnings-API:er (API 3–4) | Joins utan N+1, markörsidbrytning, filter, `004_contracts.sql` (tidigarelagd), dubbla valideringsregimer | **Klar.** L3.\*, L4.\* gröna; 68/68 i hela sviten |
| **6** ✅ | Avtalssignering (API 7) | `domain/contract-rules.ts`, transaktionell tillståndsmaskin med `sql.begin` + `FOR UPDATE OF r`, frysta villkor, tom-kropp-parser | **Klar.** S7.\*, D.3 gröna; 92/92 i hela sviten; hela flödet kört mot levande Aspire |
| **7** ✅ | Dokumentation & finish | OpenAPI-tvärsnittstester, `docs/API.md` | **Klar.** X.\* gröna; hela sviten 103/103; Swagger UI och hela flödet körda mot levande Aspire |
| **20** ✅ | Larm vid tappat innehåll | `storage/sweep-job.ts`, `mail/storage-alert-email.ts`, `STORAGE_ALERT_EMAIL` | **Klar.** G.13–G.19 gröna; 263/263; larmet läst i mailpit efter att två objekt raderats i MinIO, och andra körningen larmade inte igen |
| **19** ✅ | Rader utan objekt | `015_attachment_missing_content.sql`, avstämning i sopjobbet, `available` i API:et | **Klar.** G.8–G.12, B.21–B.22 gröna; 256/256; verifierat mot MinIO genom att radera ett objekt bakom ryggen på tjänsten |
| **18** ✅ | Städning av föräldralösa objekt | `storage/sweeper.ts`, listning i `ObjectStore`, periodiskt jobb i `index.ts` | **Klar.** G.\* gröna; 249/249; körd mot levande MinIO med planterade skräpobjekt — fristen skonade allt, utan frist försvann bara skräpet |
| **17** ✅ | Objektlagring för dokument | `014_attachment_object_storage.sql`, MinIO i AppHosten, `storage/object-store.ts` | **Klar.** B.16–B.20 gröna; 242/242; uppladdning, ZIP och radering verifierade mot MinIO — objekten inspekterade med `mc` i containern |
| **16** ✅ | Dokument och rättigheter (API 15–23) | `012_request_permissions.sql`, `013_bid_attachments.sql`, `domain/attachments.ts`, multipart, ZIP | **Klar.** P.\* och B.\* gröna; 237/237; uppladdning, rättigheter och ZIP verifierade mot levande Aspire — arkivet uppackat med systemets `unzip` |
| **15** ✅ | Refresh-tokens (API 14) | `011_refresh_tokens.sql`, rotation med återanvändningsdetektering, `sid` som binder ihop sessionen | **Klar.** T.\* gröna; 186/186; rotation, läckagedetektering och utloggning verifierade mot levande Aspire |
| **14** ✅ | Utloggning (API 13) | `010_revoked_tokens.sql`, `jti` per token, `db/sessions.ts` | **Klar.** U.\* gröna; 171/171; två samtidiga sessioner verifierade mot levande Aspire |
| **13** ✅ | Revokering vid lösenordsbyte | `009_token_version.sql`, `ver`-claim, jämförelse i `requireAuth` | **Klar.** R.15–R.19 gröna; 163/163; verifierat mot levande Aspire |
| **12** ✅ | Lösenordsåterställning (API 11–12) | `008_password_reset.sql`, engångskod med 1 h giltighet, `mail/password-reset-email.ts` | **Klar.** R.\* gröna; 158/158; hela flödet kört mot mailpit i levande Aspire |
| **11** ✅ | Utgångstid på verifieringslänken | `007_verification_expiry.sql`, tre utfall ur `verifyUserByToken` | **Klar.** V.21–V.25 gröna; 144/144; 410-vägen och återhämtningen via nytt mail körda mot levande Aspire |
| **10** ✅ | Nytt bekräftelsemail (API 10) | `006_verification_resend.sql`, `rotateVerificationToken` med kylperiod | **Klar.** V.13–V.20 gröna; 138/138; kylperiod, rotation och läckagefrihet verifierade mot mailpit |
| **9** ✅ | E-postverifiering (API 9) | `005_email_verification.sql`, mailpit i AppHosten, `src/mail/`, spärr i både `/auth/login` och `requireAuth` | **Klar.** V.\* gröna; 130/130; hela flödet kört mot mailpit i levande Aspire |
| **8** ✅ | Katalogen (API 8) | `GET /requests` med `bidCount`/`hasMyBid`/`canBid`, filter och sidbrytning | **Klar.** L8.\* gröna; 116/116; körd mot levande Aspire. Tillkom efter att luckan påpekats — säljare kunde bara lägga anbud på förfrågningar de kände till ID:t för |

Etapp 0–1 är infrastruktur och skrivs inte testdrivet i strikt mening — de *är* verktyget som
gör resten testdriven. Från etapp 2 gäller §8.1 utan undantag.

---

## 10. Medvetet utelämnat (skuld, inte glömska)

- **Lista aktiva sessioner** — `refresh_tokens` har allt som behövs (`session_id`,
  `created_at`, `revoked_at`), men inget API exponerar det. Ett `GET /me/sessions` med
  möjlighet att avsluta en enskild är nästa naturliga steg.
- **Åtgärd för markerade dokument** — `available: false` syns, men det finns ingen väg att
  ladda upp innehållet på nytt till en befintlig rad. Säljaren får radera och ladda upp
  igen, vilket ger ett nytt id.
- **Fler rättighetsnivåer** — `permission_level` har bara `read`. Kolumnen finns för att
  slippa en migrering den dag det behövs fler.
- **Städning av `refresh_tokens`** — rader ligger kvar efter utgång. `revoked_tokens`
  städas vid utloggning; motsvarande saknas här.
- **Rate limiting** på `/auth/*` — `@fastify/rate-limit` är ett endagsjobb när det behövs.
  `/auth/resend-verification` har en egen kylperiod per konto, men inget skydd mot en
  angripare som varierar adressen.
- **Betalning, fakturering, tidrapportering** — nästa domänområde efter avtalet.
- **Migrationsverktyg med rollback** — meningslöst mot en icke-persistent databas, men
  krävs innan någon persistent miljö sätts upp. Detta är den skuld som förfaller först.
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
