---
name: aspire-dev
description: Starta, stoppa och felsöka fastgigs Aspire-miljö på localhost (TypeScript-AppHost körd med bun, Postgres i podman, Fastify-API, Swagger, pgweb). Använd när användaren vill köra appen, se loggar, titta i databasen, eller när AppHost/containern inte startar.
---

# Köra fastgig lokalt

Aspire TypeScript-AppHost (`apphost.mts`) orkestrerar en icke-persistent Postgres, Keycloak
och Fastify-API:et. Aspire CLI: `~/.aspire/bin/aspire`, version 13.5.3.

**Runtime är bun** — aldrig `npm`, `npx` eller `node`, varken för AppHosten, tjänsten eller
testerna.

## Containerruntime: podman, aldrig docker

`docker` finns inte på den här maskinen. Aspire talar Docker-API mot podmans kompatibla
socket:

```bash
systemctl --user enable --now podman.socket
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
```

Kontrollera först av allt vid startproblem:

```bash
systemctl --user is-active podman.socket    # ska svara: active
```

Är den `inactive` är det nästan alltid orsaken.

**Image-namn i egna `podman`-kommandon måste vara fullkvalificerade.** `registries.conf`
saknar `unqualified-search-registries`, så `postgres:17-alpine` misslyckas med
*"short-name did not resolve to an alias"*. Skriv `docker.io/library/postgres:17-alpine`.

**Men gör aldrig det i AppHosten.** Aspire fullkvalificerar själv. `withImage('docker.io/…')`
ger `docker.io/docker.io/library/postgres` och en `unauthorized`-pull som ser ut som ett
inloggningsproblem men är ett dubbelprefix. Använd bara `withImageTag('17-alpine')`.

## Bun-runtimen för AppHosten

Aspire väljer runtime efter lockfil. Med `bun.lock` i roten loggar CLI:t
`Selected TypeScript AppHost package manager 'bun'` och kör:

```
bun install
bun run tsc --noEmit -p tsconfig.apphost.json    # förkörningssteg: typkoll
bun run apphost.mts
```

Konsekvenser:

- `bun.lock` **måste vara incheckad**. Dyker en `package-lock.json` upp faller Aspire
  tillbaka på Node + tsx — ta bort den.
- Ett typfel i `apphost.mts` stoppar starten i förkörningssteget, före resurserna.
- Bekräfta vid tveksamhet i CLI-loggen: leta efter `GuestRuntime for TypeScript (Bun)`.

## Vardagskommandon

```bash
aspire run                 # startar allt interaktivt, dashboard-URL skrivs ut
aspire start               # samma, men i bakgrunden
aspire stop                # river Postgres-containern (databasen är borta — det är avsiktligt)
aspire ps                  # vilka AppHosts som kör
aspire logs api            # loggar från API-resursen
aspire logs postgres
aspire describe            # resursernas status och URL:er
```

Dashboarden ligger på `https://localhost:17173` (se `aspire.config.json`). Därifrån länkas:

- **api** → Fastify, med Swagger UI på `/docs` och OpenAPI-dokumentet på `/docs/json`
- **keycloak** → adminkonsolen, **`admin` / `admin`** (fast konto, satt i AppHosten)
- **pgweb** → bläddra i tabellerna utan psql
- **postgres** → anslutningssträngen, om du vill köra `psql` själv

`aspire resource <namn> start|stop|restart` styr en enskild resurs — så startas
e2e-sviten, som har `withExplicitStart`.

## Keycloak

Realmet importeras ur `keycloak/realm/fastgig-realm.json` vid varje start, och containern
är icke-persistent: konton du skapar försvinner vid `aspire stop`.

**Ingen registrerar sig själv** — realmet har `registrationAllowed: false`. Nya konton
kommer in genom en inbjudan: adminkonsolen → realmet fastgig → *Organizations* → företaget
→ *Members* → *Invite member*. Den som tar emot inbjudan blir medlem när lösenordet satts,
och bekräftar adressen därefter.

Keycloak nås under **`/auth` på webbens adress** (`http://localhost:5173/auth`), proxad dit
av Vite. Gå den vägen och inte till Keycloak-resursens egen URL när något ska felsökas:
Keycloak bygger sin issuer ur Host-huvudet, och API:et väntar sig webbens adress.

| Symtom | Orsak | Åtgärd |
|---|---|---|
| `keycloak` blir `Unhealthy` fast servern svarar | `KC_HTTP_RELATIVE_PATH` flyttar även hälsokontrollen | `KC_HTTP_MANAGEMENT_RELATIVE_PATH=/` pinnar tillbaka den (satt i AppHosten) |
| `unrecognized feature: organizations` | flaggan heter `organization`, i singular | `withEnabledFeatures(["organization"])` |
| API:et svarar 401 på en token som ser rätt ut | issuern matchar inte | jämför `iss` i token med `PUBLIC_BASE_URL` — de ska vara samma origin |
| 403 `organization-missing` | kontot hör inte till någon organisation | bjud in det: realmet fastgig → Organizations → företaget → Members → Invite member |
| Inbjudningslänken säger "no longer valid" | brevets adress byggs ur den begäran som skickade inbjudan; skickas den från en annan värd än den webbläsaren surfar på avvisas token | skicka inbjudan från samma origin som webbläsaren använder |

## Icke-persistent databas — förväntat beteende

Postgres startas utan `withDataVolume()` och med `withSessionLifetime()`. Data försvinner
vid varje `aspire stop`. Migrationerna i `services/api/migrations/` körs vid API:ets boot,
så schemat finns alltid. Ser du tom data efter en omstart är det inte ett fel.

## Vanliga fel

| Symtom | Orsak | Åtgärd |
|---|---|---|
| `Cannot connect to Docker daemon` | podman-socketen nere eller `DOCKER_HOST` osatt | `systemctl --user enable --now podman.socket`, sätt `DOCKER_HOST` |
| `short-name … did not resolve to an alias` | kort image-namn i ett eget podman-kommando | fullkvalificera: `docker.io/library/postgres:17-alpine` |
| `docker.io/docker.io/…: unauthorized` | registry angivet i `withImage()` i AppHosten | ta bort registryt, använd `withImageTag()` |
| AppHosten startar med node/tsx istället för bun | `package-lock.json` finns, eller `bun.lock` saknas | `rm package-lock.json && bun install` |
| API:et startar men kraschar direkt | migrering fallerar mot tom databas | `aspire logs api`, kör migrationsfilen manuellt mot anslutningssträngen |
| `port already in use` | tidigare AppHost lever kvar | `aspire ps` → `aspire stop`, annars `podman ps` + `podman rm -f <id>` |
| Testerna beter sig konstigt mot en gammal databas | testcontainern `fastgig-test-pg` återanvänds mellan körningar med flit | `podman rm -f fastgig-test-pg` för att börja om |
| Containrar hopar sig | avbrutna körningar | `podman container prune` |
| `aspire run` hittar ingen AppHost | fel arbetskatalog | kör från repo-roten där `aspire.config.json` ligger |

## Röra AppHosten

`apphost.mts` redigeras för hand. `.aspire/modules/*.mts` är **genererad SDK** — redigera
aldrig; regenerera med `aspire restore` efter `aspire add <integration>`.

Nya integrationer läggs till med CLI:t, inte i package.json:

```bash
aspire add <namn>            # t.ex. postgresql, javascript
aspire integration search <q>
```

Efter `aspire add` finns nya `builder.add*`-metoder i den genererade modulen — slå upp
signaturen där istället för att gissa. Tjänsten körs med
`addBunApp(name, appDirectory, scriptPath)`, som startar `bun <script>` direkt utan
transpileringssteg.
