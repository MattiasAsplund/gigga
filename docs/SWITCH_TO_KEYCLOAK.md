# Bytet till Keycloak

Identiteten flyttar ut ur gigga och in i Keycloak, över OIDC — och företagen blir
förstaklassbegrepp genom Keycloaks **Organizations**.

Dokumentet är skrivet för att läsas en gång uppifrån och ned, och därefter användas som
referens per etapp (§6). Det som står under §3 är **uppmätt**, inte antaget: allt där
kördes skarpt innan koden skrevs, och flera punkter motsäger vad dokumentationen antyder.

---

## 1. Varför

gigga ägde hela identitetshanteringen själv. `services/api/src/routes/auth.ts`
implementerade registrering, inloggning, e-postbekräftelse, glömt lösenord, utloggning och
refresh-rotation — åtta endpoints (API 1, 2, 9–14), sju migrationer (005–011) och sex
kontraktsviter på runt 1 600 rader. Lösenorden hashades med `Bun.password` (argon2id),
tokens signerades HS256 med `JWT_SECRET`, och `requireAuth` slog upp `token_version` och
`email_verified` i `users` vid varje skyddad begäran.

Det fungerade. Men det var identitetsinfrastruktur gigga inte har någon anledning att
bygga själv, och framför allt bar den inte den B2B-modell marknadsplatsen faktiskt
beskriver. Domänen är företag som köper och säljer uppdrag av varandra; identitetsmodellen
var enskilda personer med `email + display_name`. Kollegor nådde varandras förfrågningar
bara genom individuella tilldelningar, en åt gången — och `request_permissions` egen
kommentar sa rent ut vad som saknades: *"typiskt kollegor som ska bedöma anbuden"*.

Efter bytet:

- **Keycloak äger konton, lösenord, e-postbekräftelse och sessioner.** API:et är en ren
  resursserver som verifierar RS256-tokens mot realmets JWKS. Ingen `JWT_SECRET`, inga
  lösenord i databasen, inga egna refresh-tokens.
- **Organisationen är part i affären.** En användare handlar för sin organisations
  räkning. Ägarskap, anbudsspärren och signaturerna är organisationsskopade.
- **Bekräftelsemailen kommer från Keycloak**, genom samma mailpit som förut —
  `verifyEmail` och `smtpServer` i ett incheckat realm-JSON.
- **Webben skickar användaren till Keycloaks egna sidor** (authorization code + PKCE), så
  att required actions faktiskt spärrar inloggningen, och så att per-organisation-IdP
  fungerar den dag ett kundföretag vill logga in med sin egen Entra ID.

Databasen har ingen volym och töms vid varje `aspire stop`. Det gör en destruktiv
migration både trygg och ärlig — ingen bakfyllnad, ingen dubbelskrivningsperiod.

---

## 2. Besluten

Fyra vägval, tagna innan koden skrevs:

| Fråga | Val | Bortvalt |
|---|---|---|
| Tokenmodell | **Ren resursserver.** API:et utfärdar ingenting. | BFF, där API:et växlar in koden och ändå utfärdar egen HS256-token. Mindre omskrivning, men två tokensystem vars sessionsläge glider isär. |
| B2B | **Fullt ut nu.** Organizations påslaget, organisationer i realmet, organisationsskopat ägarskap. | Enbart individer, eller "grundplåt nu, organisationer sen". |
| "Verifieringskod via e-post" | **Keycloaks `verifyEmail`** — en länk, skickad av Keycloak genom mailpit. | Numerisk engångskod vid inloggning. Kräver en tredjeparts-SPI som JAR i containern; Keycloak har ingen inbyggd e-post-OTP till och med 26.7. |
| Inloggning i webben | **Keycloaks egna sidor, authorization code + PKCE.** | Behålla React-formulären mot Direct Access Grants. Går förbi required actions, är oförenligt med IdP-federation per organisation, och grantet är på väg bort. |

---

## 3. Vad som är verifierat, inte antaget

Kört skarpt mot `quay.io/keycloak/keycloak:26.6` och mot den genererade Aspire-SDK:n.
**Flera av punkterna motsäger det dokumentationen antyder** — de är därför de viktigaste
raderna i hela dokumentet.

1. **Den genererade SDK:n stämmer med planen.** `addKeycloak(name, { port, adminUsername,
   adminPassword })` och `withRealmImport(importPath)` finns båda. Dessutom finns
   **`withEnabledFeatures(features: string[])`** som förstklassig metod — använd den
   framför miljövariabeln `KC_FEATURES`.

2. **Funktionen heter `organization`, i singular.** `--features=organizations` avvisas med
   *"unrecognized feature"*, och realmet startar utan organisationsstöd. Upptäckt genom
   att gå på det.

3. **Organisationer importeras från realm-JSON.** Det gick inte att bekräfta ur
   dokumentationen — flera sökträffar beskriver phasetwo-tillägget, inte den inbyggda
   funktionen. Uppmätt: båda organisationerna, deras domäner och samtliga realm-flaggor
   (`organizationsEnabled`, `verifyEmail`, `registrationAllowed`, `resetPasswordAllowed`,
   `registrationEmailAsUsername`, `bruteForceProtected`) landade rätt, utan fel i
   importloggen. Ingen reservväg över admin-API:et behövdes.

4. **`organization`-claimen är en lista av alias**, inte id:n: `"organization": ["nordvind"]`,
   skriven av det inbyggda `organization`-scopets `oidc-organization-membership-mapper`.
   Det förenklar speglingen — `organizations`-tabellen nycklas på aliaset och behöver
   inget uppslag mot admin-API:et. Det betyder också att en användare *kan* höra till
   flera organisationer; gigga kräver exakt en och avvisar annars med en tydlig Problem.

5. **Tokenens form**, som API:et validerar mot: `iss`, `aud: ["gigga-api", "account"]`
   (audience-mapparen fungerar), `azp: "gigga-web"`, `sub`, `email`, `email_verified`,
   `name`, `organization`. Realmets JWKS bär **två** nycklar — en RS256 för signatur och en
   RSA-OAEP för kryptering — så nyckelval på `kid`/`use` är verkligt, inte teoretiskt.

6. **Keycloak bygger sin issuer ur `Host`-huvudet.** Uppmätt: en begäran med
   `Host: localhost:5173` ger `issuer: http://localhost:5173/auth/realms/gigga`. Det är
   grunden för hela adressupplägget i §4.

7. **`KC_HTTP_RELATIVE_PATH` flyttar även hälsokontrollen.** Managementgränssnittet ärver
   sökvägen, så `/health/ready` blir `/auth/health/ready` medan Aspire frågar den gamla
   adressen. Resursen blir `Unhealthy` fast servern är uppe, och allt som väntar på den
   står kvar i `Waiting`. Rättas med `KC_HTTP_MANAGEMENT_RELATIVE_PATH=/`.

8. **Aspires Keycloak-endpoint är https med ett utvecklingscertifikat som bun inte har
   någon kedja till.** `NODE_EXTRA_CA_CERTS` (som Aspire sätter) och `SSL_CERT_FILE` ger
   båda *"unable to verify the first certificate"*; bara avstängd verifiering fungerar,
   vilket inte är en godtagbar rättning i en produkt. Se §4 för hur det löstes.

9. **Lottad port, inte fast.** En fast port 8080 kolliderade på riktigt med en orelaterad
   `typst-server` på maskinen, vilket gjorde keycloak `Unhealthy` och höll api och web i
   `Waiting`. Exakt den fallgrop commit `8dc843a` beskriver för API:ets port.

10. **Att lägga till en organisationsmedlem över admin-API:et kräver
    `Content-Type: application/json`** med användarens id som rå kropp. `text/plain`
    misslyckas tyst — inget fel, ingen medlem.

---

## 4. Adressupplägget, och varför det ser ut som det gör

Det här är den enda verkligt kluriga biten, och den lösning som faller ut är enklare än
problemet.

**Problemet.** Tokenens `iss` måste vara byte-identisk med den adress webbläsaren
faktiskt loggade in på. Men webbläsaren är olika saker i olika lägen: på värden
(`localhost:5173`), inne i e2e-containern (en bryggadress) och bakom en cloudflare-tunnel
(`*.trycloudflare.com`). Ett fast `KC_HOSTNAME` hade tvingat fram konfiguration per miljö,
och en tunnel framför Keycloak hade blivit en tredje sak att hålla i synk.

**Lösningen.** Vite proxar `/auth` vidare till Keycloak, precis som den redan proxar
`/api`. Eftersom Keycloak bygger issuern ur `Host`-huvudet (§3.6) följer den då webbens
origin av sig själv, i alla tre lägena, utan en rad konfiguration per miljö:

- `KC_HTTP_RELATIVE_PATH=/auth` — Keycloak ligger under `/auth` på webbens origin.
- `KC_PROXY_HEADERS=xforwarded` — bakom tunneln är det `X-Forwarded-Proto` som bär https.
  Utan det byggs issuern med `http` och matchar inte adressen användaren kom in på.
- **`changeOrigin: false`** i Vites proxy, till skillnad från `/api`. Skrivs `Host` om till
  containerns adress bygger Keycloak issuern ur *den*, och webbläsaren skickas till en
  adress den inte når.
- `secure: false` — Aspires endpoint är https med utvecklingscertifikat, och trafiken går
  till localhost.

Webben härleder sin `authority` ur `window.location.origin`, så samma bygge fungerar
överallt. Och eftersom Keycloak nu delar origin med webben försvinner CORS och `webOrigins`
som frågeställning helt.

**Nycklarna.** Ursprungligen skulle API:et hämta JWKS direkt från Keycloak-containern, för
att inte behöva webben uppe. Det gick inte: bun litar inte på Aspires certifikat (§3.8).
Rättningen är inte en nödlösning utan den mer korrekta varianten — **JWKS härleds ur
issuern**, `${OIDC_ISSUER}/protocol/openid-connect/certs`, vilket är precis vad
OIDC-discovery hade svarat. Nycklarna som hör till en issuer publiceras av den issuern; att
hämta dem någon annanstans ifrån vore att lita på en nyckel som inte kan visa att den hör
ihop med det som skrev token.

Bieffekten är att `--enable-cloudflare` rättar sig självt: `PUBLIC_BASE_URL` skrivs redan
om till tunnelns adress av den befintliga callbacken, och issuern och nyckeladressen följer
med på köpet. Den risk som var öppen när planen skrevs finns alltså inte längre.

---

## 5. Så här ser det ut efteråt

### 5.1 AppHosten

`aspire.config.json` får `"Aspire.Hosting.Keycloak": "13.5.3-preview.1.26425.3"` — preview
är den enda kanal paketet finns på, och versionen följer SDK:n.

Resursen deklareras efter mailpit (SMTP:n går dit) och före api, med lottad port,
genererade adminuppgifter, `withEnabledFeatures(["organization"])`, realmimport och
sessionslivstid. `api` och `web` väntar båda in den.

Miljön: `JWT_SECRET` och parametern `jwt-secret` försvinner helt. `api` får
`OIDC_AUDIENCE`; issuern och nyckeladressen räknas ut ur `PUBLIC_BASE_URL` i
`services/api/src/config.ts`. `web` får `KEYCLOAK_TARGET` som endpointreferens.

### 5.2 Realmet som data

`keycloak/realm/gigga-realm.json`, incheckad. Hela autentiseringskonfigurationen i en
granskningsbar fil, i samma anda som `catalog/` — konfiguration som data, inte klick i en
adminkonsol. Bär `verifyEmail`, `organizationsEnabled`, SMTP mot mailpit, klienterna
`gigga-web` (publik, PKCE `S256`) och `gigga-api` (audience), samt två organisationer
med domäner.

> **Skuld.** `redirectUris` och `webOrigins` står som `*`. Adresserna är lottade i tre av
> fyra lägen (bryggadress, tunnel), och realmet är ett icke-persistent
> utvecklingsrealm utan publik exponering. Ett produktionsrealm måste nagla fast dem.

### 5.3 API:et

`jose` in, `@fastify/jwt` ut. Ny `src/auth/keys.ts` med samma söm som `Mailer` och
`ObjectStore`: `createRemoteKeys` i drift, `createLocalKeys` i testerna. `buildServer`
tar emot `keys` bredvid `mailer` och `objects`.

`requireAuth` läser bearer-huvudet, verifierar mot JWKS med `issuer` och `audience`,
avvisar obekräftad adress (403) och saknad eller tvetydig organisation (403), och speglar
sedan identiteten. Alla misslyckanden med själva token — saknad, utgången, manipulerad,
fel issuer, fel mottagare — ger samma 401, som A2.4 alltid krävt.

**Borttaget:** `routes/auth.ts`, `schemas/auth.ts`, `db/sessions.ts`,
`mail/verification-email.ts`, `mail/password-reset-email.ts`, `plugins/rate-limit.ts`,
`domain/rate-limit.ts`. Kvotgränsen ersätts av `bruteForceProtected` i realmet.

### 5.4 Speglingen

`migrations/018_keycloak_identities.sql`: ny `organizations`-tabell; `users` får
`keycloak_sub` och `organization_id` och tappar lösenords-, verifierings- och
återställningskolumnerna; `refresh_tokens` och `revoked_tokens` faller.

**`users.id` står kvar som primärnyckel.** Det är hela poängen med en spegling — requests,
bids, contracts och request_permissions rör sig inte ur fläcken, och Keycloaks `sub` blir
en alternativnyckel istället för en ny identitet att skriva om domänen kring.

`db/identities.ts` speglar vid första anropet. Läsningen först är ingen optimering på
måfå: den ersätter precis det uppslag `requireAuth` gjorde förut, så en skyddad begäran
kostar lika mycket som innan. Skrivning sker bara när något faktiskt skiljer sig.

### 5.5 Organisationsskopningen

Ett mönster, åtta ställen: en ägarskapsjämförelse mot användaren blir en jämförelse av
organisationer. `requests.buyer_id` och `bids.seller_id` står kvar (de bär *vem som
agerade*) och får `buyer_organization_id` / `seller_organization_id` bredvid sig (*vilken
part*).

Berörda: `routes/bids.ts` (egen förfrågan, anbudsägarskap), `routes/permissions.ts`
(ägarskap, vem som ser alla anbud), `routes/contracts.ts` (vem som är part),
`routes/attachments.ts` (skriv- och läsrätt), `routes/request-specs.ts` (kravspecen är
köparorganisationens arbete), `db/listings.ts` (”mina” blir organisationens).

**Invarianterna i `GENOMFORANDE.md` §5.1.** Invariant 3 överlever oförändrad — en
organisation är köpare i en förfrågan och säljare i en annan, precis som en person var.
Invariant 4 *skärps*: en kollega kan inte längre lämna anbud på den egna organisationens
förfrågan, vilket är vad regeln alltid betytt. Anbudsspärren flyttar med:
`bids_one_active_per_seller_idx` ersätts av ett index på
`(request_id, seller_organization_id)` — två kollegor med var sitt anbud är inte två
anbud, det är ett företag som talar med två röster.

**Två medvetna beteendeändringar:**

1. `GET /me/requests` och `/me/bids` betyder organisationens, inte personens. För en
   marknadsplats där företaget är avtalspart är det rätt läsning, och det är vad som gör en
   kollega användbar. Det är ändå en synlig ändring av API 3 och 4.
2. `request_permissions` smalnar av. Kollegor läser genom medlemskapet, så uttrycklig
   tilldelning blir mekanismen **över** företagsgränsen. Att tilldela en kollega avvisas
   med 422 — en tilldelning som inte betyder något vore värre än ett fel, den ser ut att
   ha gjort någonting.

### 5.6 `GET /api/v1/me`

Ny endpoint: `{ id, email, displayName, organization: { id, alias, name } }`.

Inte pynt. Webben hade en `subjectOf()` som avkodade `sub` ur token för att få det lokala
användar-id:t, och jämförde det mot `buyerId`/`sellerId` i svaren. Keycloaks `sub` är inte
`users.id`, så det tricket dör och gränssnittet behöver någonstans att fråga.

> **Skuld.** Organisationens visningsnamn följer inte med i `organization`-claimen — den
> bär bara alias — och API:et ska inte behöva Keycloaks admin-API för att ta emot en
> begäran. `organizations.name` sätts därför till aliaset första gången företaget syns.

### 5.7 Webben

`oidc-client-ts`, inte `keycloak-js` — spec-generisk, så gränssnittet inte kopplas till
Keycloak, vilket är hela poängen med att gå över OIDC istället för en leverantörs-SDK.

`auth.tsx` blir en `UserManager` med PKCE och tyst förnyelse; tokens i `sessionStorage`
(överlever omladdning, inte en stängd flik). `Login`, `Register`, `Verify`,
`ForgotPassword` och `ResetPassword` raderas; `Callback.tsx` tillkommer. `RequireAuth`
skickar till Keycloak istället för till `/login`, och väntar in `loading` — utan det hade
en omladdning av en skyddad sida hunnit se `account === null` och skickat en redan
inloggad användare på en ny inloggningsrunda.

Mastheaden får en enda väg in. Keycloaks inloggningssida bär registreringslänken själv, så
gigga behöver ingen egen väg till ett formulär Keycloak redan äger — och kan därmed inte
råka gå förbi kravet på bekräftad adress.

### 5.8 Testerna

`test/helpers/keys.ts` slår fram en RS256-nyckel per körning och signerar tokens med
`jose`. Ingen Keycloak, ingen port, inget nät — `bun test` behåller sin karaktär.

`actor()` blir mindre: den skriver sin token direkt istället för att gå via registrering
och bekräftelselänk. Det är ingen genväg förbi något — kontot skapas ändå på riktigt, av
`requireAuth`, vid aktörens första anrop.

**Varje aktör får ett eget företag som standard.** Med flit: en svit som skriver
`actor(app, 'kim')` och `actor(app, 'robin')` menar två motparter, och skulle de dela
organisation vore robins anbud plötsligt ett anbud på den egna förfrågan. Kollegor begärs
uttryckligen, med `colleagueOf`.

Nya serier: **O** (token från Keycloak — signatur, issuer, mottagare, utgång, obekräftad
adress, saknad och tvetydig organisation, speglingens idempotens, ändrad adress) och **B**
(organisationen som part — kollegan ser, kollegan får inte bjuda, ett anbud per företag,
kollegan får ändra och signera, tilldelning inom och över företagsgränsen).

Borttagna sviter: `auth`, `verification`, `password-reset`, `refresh`, `logout`,
`rate-limit` (kontrakt) och `rate-limit` (domän).

---

## 6. Etapper och läge

| # | Etapp | Läge |
|---|---|---|
| 1 | Keycloak i AppHosten | **klar** |
| 2 | Realmet som data | **klar** |
| 3 | API:et som resursserver | **klar** |
| 4 | Speglingen och migrationen | **klar** |
| 5 | Organisationsskopningen | **klar** |
| 6 | `GET /me` | **klar** |
| 7 | Webben | **klar** |
| 8 | Testerna | **klar** — 286 gröna |
| 9 | E2E och dokumentationen | **återstår** |

### Etapp 9, det som återstår

`services/e2e/` är ännu **orörd**, och `flow.spec.ts` är därmed trasig i nuläget:

- `registerAndVerify` fyller i de raderade `/register`- och `/verify`-sidorna.
- `signIn` postar mot den raderade `/login`-sidan istället för att gå till Keycloak.
- Steget *"Obekräftat konto släpps inte in"* och hela glömt-lösenord-kedjan prövar flöden
  API:et inte längre serverar.
- `publishSpec` läser token ur `localStorage.getItem('gigga.account')`; den ligger nu
  under `oidc-client-ts` nyckel i `sessionStorage`.
- De tre personerna har inga organisationer, så ingenting prövar det B2B-beteende hela
  ändringen handlar om.

`latestMail` behöver däremot inte röras — den matchar på mottagare, inte ämne — och
`clickMailLink` går fortfarande genom mailpits gränssnitt, vilket bevarar bildspelets bästa
bildrutor.

**Följdverkan:** `flow.spec.ts` är också bildspelets källa, genom `slides.ts` och
`pandoc`-resursen. Skärmbilderna kommer nu att innehålla Keycloaks sidor, så berättelsen i
decket och i README:s steg 1–3 ändras med dem.

**Dokumentation att uppdatera:** `GENOMFORANDE.md` §1 (teknikval), §3 (repostruktur —
`keycloak/realm/`), §4 (AppHosten), §5.1 (invariant 3 och 4), §6 (endpointtabellen tappar
åtta rader och får `GET /me`), §6.1, §7.2 (A/V/R/T/U/K pensioneras, O och B tillkommer),
§10; `docs/API.md`; `README.md` §§1–3 och Teknik.

---

## 7. Att verifiera

- `bun test` från `services/api` — hela sviten grön, offline, utan Keycloak igång.
- `bun run typecheck` och `bun run lint` i roten.
- `aspire run`: `keycloak`, `api` och `web` når alla `Running/Healthy`. `/health` svarar
  `{"status":"ok","database":"up"}`.
- Genom webbens proxy ska
  `http://localhost:5173/auth/realms/gigga/.well-known/openid-configuration` ge
  `issuer: http://localhost:5173/auth/realms/gigga` — alltså webbens origin, inte
  Keycloaks egen adress. Det är kontrollen som fångar hela §4.
- En riktig token från realmet ska accepteras av `/api/v1/me`, och svaret ska bära det
  lokala id:t och organisationen.
- Registrera i webbläsaren, läs bekräftelsemailet i mailpit (`http://localhost:8025`),
  bekräfta, och landa tillbaka i gränssnittet.
- Starta `e2e`-resursen från dashboarden och kontrollera både sviten och det omgenererade
  bildspelet i `outputs/`.
````

**En sak att vara ärlig om i §6:** rättningen i §4 — att härleda JWKS ur issuern istället för att gå direkt mot Keycloak-containern — är skriven och typkollad, men den var ännu inte omstartad och verifierad end-to-end när arbetet avbröts. Punkt 5 och 6 i §7 är alltså de två kontroller som står närmast på tur, och etapp 9 kan inte bli grön förrän de är det.
