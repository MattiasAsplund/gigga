# gigga

Marknadsplats för distansuppdrag. **Köpare** publicerar uppdragsförfrågningar och
fastställer en kravspec, **säljare** lämnar anbud med en genomförandeplan och ett pris —
fast eller per timme — och parterna signerar ett avtal.

Repot innehåller tre tjänster under `services/`:

| Tjänst | Vad det är |
|---|---|
| **api** | Fastify-API med 29 endpoints under `/api/v1` och `/health`. Bun, PostgreSQL, TypeBox |
| **web** | React-gränssnitt ovanpå API:et på fem språk. Vite, react-router, oidc-client-ts |
| **e2e** | Playwright-svit som går hela flödet genom gränssnittet och fotar det till ett bildspel |

**Roller är inte knutna till konton.** Samma användare är köpare i en förfrågan och säljare
i en annan. Behörighet avgörs av ägarskap i raden — och ägaren är **organisationen**, inte
personen: kollegor på samma företag delar förfrågningar, anbud och avtal.

Identiteten ligger i **Keycloak**. API:et har inga egna konton, lösenord eller sessioner
utan verifierar Keycloaks tokens mot realmets JWKS. Varje konto hör till exakt en
organisation i Keycloak, och det är den som blir part i affären.

## Kom igång

```bash
systemctl --user enable --now podman.socket     # engångsåtgärd
bun install
aspire run
```

Aspire orkestrerar allt ur `apphost.mts` (en TypeScript-AppHost körd med bun) och kör
containrarna med podman. Dashboarden startar på `https://localhost:17173` (se
`aspire.config.json`) och länkar vidare till:

| Resurs | Vad du gör där |
|---|---|
| **web** | Gränssnittet, på `http://localhost:5173` |
| **api** | Swagger UI på `/docs`, OpenAPI 3.1 på `/docs/json`. Porten lottas; webben proxar dit |
| **keycloak** | Adminkonsolen, **`admin` / `admin`**. Konton, organisationer, inbjudningar |
| **mailpit** | All utgående post — bekräftelser, inbjudningar, larm. Inget skickas på riktigt |
| **pgweb** | Bläddrar i tabellerna |
| **minio** | Anbudsdokumenten som objekt |
| **e2e** | Playwright-sviten. Startas på begäran från dashboarden, inte vid `aspire run` |
| **pandoc** | Väntar på e2e och skriver bildspelet till `outputs/` när sviten gått igenom |

Postgres, MinIO och Keycloak är **icke-persistenta**: allt försvinner vid `aspire stop`.
Schemat migreras fram när API:et startar, och realmet importeras om vid varje start.

### Konton att börja med

Realmet seedas med två bekräftade konton, ett per sida av affären:

| Konto | Lösenord | Organisation | Roll |
|---|---|---|---|
| `buyer1` | `buyer1` | Nordvind Bygg (`nordvind`) | köpare |
| `seller1` | `seller1` | Sydlig Teknik (`sydlig`) | säljare |

Två organisationer till finns utan medlemmar: `gigga` (marknadsplatsen själv) och
`granskaren` (en utomstående som kan få läsrätt). Fler konton kommer in genom
**inbjudan** — ingen registrerar sig själv, realmet har `registrationAllowed: false`.
Adminkonsolen → realmet **gigga** → *Organizations* → företaget → *Members* → *Invite
member*. Brevet landar i mailpit; länken leder till ett registreringsformulär där
lösenordet sätts, och kontot är medlem i företaget från det ögonblicket. Adressen måste
bekräftas (nästa brev) innan inloggningen släpper in.

### Realmet är en mall

Keycloaks realm ligger som `gigga-realm.json` i roten — klienter, organisationer,
seedade konton, SMTP mot mailpit och folkid som identitetsleverantör. AppHosten skriver
ut den till `keycloak/realm/` (gitignorerad) innan Keycloak startar. Ändra mallen, inte
utskriften.

Keycloak nås under **`/auth` på webbens egen adress** (`http://localhost:5173/auth`),
proxad dit av Vite. Keycloak bygger sin issuer ur Host-huvudet, så tokenens `iss` blir
webbens adress vare sig du surfar på localhost, kör e2e-sviten i en container eller går
genom en cloudflare-tunnel — utan konfiguration per miljö.

### Språk

Gränssnittet finns på fem språk: `sv-SE`, `en-GB`, `nb-NO`, `da-DK` och `fi-FI`. Väljaren står i mastheaden bredvid inloggningen och följer med in, så språket
går att byta mitt i ett formulär. Bytet slår igenom direkt på hela sidan — belopp och
datum formateras också efter det valda språket — och valet sparas i webbläsaren till
nästa besök. Standard är svenska.

Texterna ligger i `services/web/src/locales/<språk>.json`, en platt fil per språk med
samma nycklar (`bidDetail.sign`, `catalog.empty`, …) och `{namn}` som platshållare.
Koden anropar `_('nyckel', { namn })` ur `src/i18n.ts`; en nyckel som saknas visas som
den är och varnas för i konsolen. Ett nytt språk är en fil till och en rad i `LOCALES`.
Kvar på svenska i koden är bara det som inte är gränssnittstext: ordmärket, statusvärden
från API:et och utvecklarfel.

Katalogens innehåll översätts på samma sätt, helt i webben. Uppdragstypernas namn,
intervjuns frågor, hjälptexter och svarsalternativ samt mallarnas kriterierader ligger i
`services/api/catalog/` som **nycklar** (`question.integration.systems.prompt`,
`clause.bugfix.reproduction-gone.statement`), och API:et lagrar och skickar dem som de
är — det översätter ingenting. Webben slår upp dem med samma `_()`; en rad kunden skrivit
själv är fri text och visas oförändrad. Publiceringsblockerarna kommer likaså som nycklar
med parametrar. Felsvarens rubriker ur API:et är fortfarande på svenska.

### Visa upp miljön utanför maskinen

```bash
bun run dev-cloudflare
```

Samma miljö plus två cloudflared-snabbtunnlar, en framför **web** och en framför
**mailpit**. Adresserna på `trycloudflare.com` hängs på respektive resurs i dashboarden.
`PUBLIC_BASE_URL` följer med webbens tunnel, så länkarna i breven pekar utåt.

API:et behöver ingen tunnel: Vites `/api`-proxy körs på värden, och webbläsaren ser bara
ett origin. Tunnelprocesserna överlever `aspire stop` och återanvänds vid nästa start, så
en utdelad länk fortsätter fungera över en omstart; stäng dem från dashboarden eller med
`pkill cloudflared`. Första körningen efter att de dödats saknar dashboarden tunnellänkarna
— adressen finns inte när resurserna byggs — men breven pekar rätt ändå, och nästa körning
har allt på plats.

Kräver `cloudflared` i PATH. Länkarna är öppna för var och en som har dem, och mailpit
visar all post i miljön.

### Logga in med folkid

```bash
bun run dev-folkid
```

Slår på **folkid** som identitetsleverantör i realmet. folkid körs utanför det här
projektet med sina egna beroenden; AppHosten startar inget av det utan får bara adressen
som `--folkid-url={baseUrl}` (skriptet sätter `http://localhost:3005`). Med flaggan
ersätts `{baseUrl}` i mallen och leverantören slås på; utan den står den avstängd och
syns inte på inloggningssidan. Den incheckade mallen bär i dag adressen `http://folkid`
utan platshållare, så flaggan gör just nu bara det senare.

Adressen används både av webbläsaren och av Keycloak inne i sin container. `localhost`
räcker alltså bara om folkid svarar där även från containern; står folkid på samma maskin
är värdens adress på nätet det som fungerar. `bun run dev -- --folkid-url=...` når inte
fram — Aspire CLI skickar inte vidare argument till en TypeScript-AppHost — utan flaggan
ges i ett skript i `package.json` eller för hand med `bun apphost.mts --folkid-url=...`.

På folkid-sidan ska klienten `gigga` vara registrerad med hemligheten
`gigga-folkid-dev-secret` och återanropsadressen
`http://localhost:5173/auth/realms/gigga/broker/folkid/endpoint`.

## Tester

```bash
bun test                  # API:ets svit: 286 tester, ~22 s
bun run test:coverage     # samma, plus täckningsrapport i services/api/coverage/
bun run typecheck         # AppHosten; tjänsterna har egna typecheck-skript
bun run lint              # biome
```

API-testerna kör mot en riktig Postgres i podman (`gigga-test-pg`, återanvänd mellan
körningar) och ersätter SMTP och S3 med minnesvarianter. Tokens signeras med en
testnyckel i stället för att gå mot Keycloak. Testerna är specifikationen: fallen bär
stabila ID:n och API:erna har byggts fram genom dem, matrisen står i §7.2 i
[genomförandeplanen](docs/GENOMFORANDE.md).

**E2E-sviten** startas från dashboarden (`aspire resource e2e start`) och kör i
Playwrights egen image mot den levande miljön. Fyra serialiserade test: hela flödet från
inbjudan till signerat avtal, ändra och dra tillbaka anbud, ett bekräftat konto utan
organisation, och en ogiltig bekräftelselänk. Varje navigering fotas till
`services/e2e/slides/`; när sviten gått igenom skriver **pandoc**-resursen
`outputs/flow-dokument.pdf` och `outputs/flow.marp`, det senare att presentera med
`bun run marp`. Video och spår hamnar i `services/e2e/recordings/`, rapporten i
`services/e2e/report/`.

## Flödet, från förfrågan till signerat avtal

Gränssnittet är den avsedda vägen. Sidorna:

| Sida | Vad som händer där |
|---|---|
| `/` | Landningssida med inloggningsknappen — den enda öppna sidan |
| `/requests` | Katalogen: öppna uppdrag som går att bjuda på, med filter på ersättningsform |
| `/requests/new` | Ny förfrågan |
| `/requests/:id/spec` | Kravspecen: uppdragstyp, intervju, acceptanskriterier, publicering |
| `/requests/:id` | Förfrågan med sina anbud; läsrätt ges och tas bort här |
| `/me/requests`, `/me/bids` | Organisationens egna förfrågningar respektive anbud |
| `/bids/:id` | Anbudet: dokument, ändra, dra tillbaka, signera |

Samma sak går att göra mot API:et direkt. Token hämtas ur webbläsarens `sessionStorage`
efter inloggning (nyckeln som börjar på `oidc.user:`), och anropen går genom webbens
proxy så att issuern stämmer:

```bash
API=http://localhost:5173/api/v1
KT=<köparens access-token>
ST=<säljarens access-token>
```

### 1. Köparen publicerar en förfrågan

```bash
REQ=$(curl -s -X POST $API/requests -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' \
  -d '{"title":"Bygg en Fortnox-integration",
       "description":"Synk av fakturor varje timme, allt på distans.",
       "compensationPref":"any",
       "budget":{"amountMinor":5000000,"currency":"SEK"},
       "deadlineAt":"2026-12-01T00:00:00Z"}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')
```

Belopp anges alltid i **minorenhet** — `5000000` är 50 000,00 kr. Aldrig decimaltal.
`compensationPref` är `fixed`, `hourly` eller `any`.

### 2. Köparen fastställer kravspecen

En förfrågan går inte att bjuda på förrän köparen valt uppdragstyp, svarat på frågorna
som hör till den och godkänt acceptanskriterierna. Elva typer finns — integration,
datamigrering, API-endpoint, skärm, rapport, automatisering, buggfix, prestanda, miljö,
förstudie och övrigt — och de är **data**, inte kod: `services/api/catalog/` bär mallarna
och frågorna, och en ny typ är en fil där. Bakgrunden står i
[docs/gigga-acceptansmallar.md](docs/gigga-acceptansmallar.md).

```bash
curl -s "$API/gig-types" -H "authorization: Bearer $KT"

curl -s -X POST $API/requests/$REQ/spec -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' -d '{"gigTypes":["integration"]}'

curl -s -X PUT $API/requests/$REQ/spec/answers -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' \
  -d '{"answers":[{"questionKey":"integration.systems","value":"Fortnox och vårt ordersystem"}]}'

curl -s -X POST $API/requests/$REQ/spec/criteria/$RAD/approval -H "authorization: Bearer $KT"
curl -s -X POST $API/requests/$REQ/spec/publication -H "authorization: Bearer $KT"
```

Svaret på `GET /requests/{id}/spec` bär frågorna med `kind`, `options` och `config` —
en klient renderar det den får och hårdkodar aldrig en frågenyckel. Villkorade frågor
dyker upp när svaret de hänger på är sparat. `completeness` säger vad som återstår, och
det är samma räkning som publiceringen gör. Kriterier går att lägga till, ändra och ta
bort (`/spec/criteria`), och en publicerad lydelse går att öppna på nytt som en ny
revision (`/spec/revisions`).

### 3. Säljaren hittar uppdraget

```bash
curl -s "$API/requests" -H "authorization: Bearer $ST"
```

Katalogen visar öppna förfrågningar med sista anbudsdag kvar. Varje post säger hur många
anbud som finns (`bidCount`), om din organisation redan bjudit (`hasMyBid`), om kravspecen
är publicerad (`hasPublishedSpec`) och om du får bjuda (`canBid`) — falskt för egna
förfrågningar, när ni redan bjudit och när kravspecen inte är fastställd.

### 4. Säljaren lämnar anbud

```bash
BID=$(curl -s -X POST $API/requests/$REQ/bids -H "authorization: Bearer $ST" \
  -H 'content-type: application/json' \
  -d '{"plan":"Kartläggning, bygge, överlämning.",
       "compensation":{"type":"hourly","rateMinor":95000,"estimatedHours":40}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')
```

Antingen `{"type":"fixed","amountMinor":…}` eller
`{"type":"hourly","rateMinor":…,"estimatedHours":…}`, aldrig fält från båda. Svaret räknar
ut `estimatedTotalMinor`. Ett aktivt anbud per organisation och förfrågan; det går att
ändra (`PATCH /bids/{id}`) och dra tillbaka (`POST /bids/{id}/withdrawal`) fram till att
köparen signerat, och efter en tillbakadragning går det att lämna ett nytt.

### 5. Säljaren bifogar dokument

```bash
curl -X POST $API/bids/$BID/attachments -H "authorization: Bearer $ST" -F "file=@offert.pdf"
```

Markdown och PDF, högst 10 MB per fil och 20 per anbud, när som helst — även efter att
avtalet signerats. Filtypen avgörs av innehållet, inte av ändelsen. Dokument går att byta
namn på och radera så länge anbudet är ert, och alla går att hämta som ZIP på
`/bids/{id}/attachments/archive`.

### 6. Köparen läser anbuden och delar med en granskare

```bash
curl -s "$API/me/requests" -H "authorization: Bearer $KT"
curl -s -X POST $API/requests/$REQ/permissions -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' -d '{"email":"mio@granskaren.test"}'
```

Kollegor i samma organisation ser förfrågan och anbuden utan vidare. Någon utanför —
en granskare — får **läsrätt** per förfrågan: hen når förfrågan, anbuden och dokumenten
men kan varken bjuda, signera eller dela vidare. `DELETE` på samma väg stänger åtkomsten.
Läsrätt går bara att ge den som redan loggat in en gång: raden i `users` skapas vid
personens första anrop, dessförinnan svarar API:et `404 user-not-found`.

### 7. Båda signerar

```bash
curl -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $KT"  # köparen
curl -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $ST"  # säljaren
```

Det finns inget separat "acceptera anbud": **köparens signatur är accepterandet.** Den
skapar avtalet med anbudets villkor frysta i `terms`. Säljarens signatur aktiverar det,
och i samma transaktion blir förfrågan `awarded`, det vinnande anbudet `accepted` och
övriga `rejected`. Anropet är idempotent.

Alla felsvar följer RFC 9457 (`application/problem+json`) med ett stabilt `type` att
grena på. Konventionerna och hela endpointlistan står i [docs/API.md](docs/API.md).

## Vad som saknas

**Flödet slutar vid ett signerat avtal.** Leveransrapportering, tidrapportering,
fakturering och betalning finns inte. Kriteriernas utfall vid acceptans (`met`, `failed`,
`waived`) finns i modellen men har ingen väg dit.

Utöver det:

- **Förfrågningar går inte att ändra eller avbryta.** `cancelled` finns i schemat men
  inget API sätter den.
- **Katalogen har varken fritextsökning eller sortering**, bara filter på ersättningsform.
  En förfrågan utan publicerad kravspec syns ändå, märkt `canBid: false`.
- **Intervjun sparar när man trycker Spara**, inte per fält. Lämnar man sidan mitt i ett
  steg är fälten tomma igen.
- **Inbjudningar skickas i Keycloaks adminkonsol**, inte i gigga. Den som ska bjuda in en
  kollega behöver ett adminkonto i realmet.
- **Ett konto kan bara höra till en organisation.** Flera i token ger
  `403 organization-ambiguous`.
- **Organisationens visningsnamn når inte fram.** `organization`-claimen bär bara
  aliaset, och speglingen sätter namnet till aliaset — "Nordvind Bygg" visas som
  `nordvind`.
- **Inloggningen sker med lösenord, inga passkeys.** Keycloak-bilden stödjer dem, men
  realmet slår inte på dem. En passkey är bunden till sin origin, och gigga låter originen
  flyta för issuerns skull — en passkey från localhost erbjuds inte bakom tunneln.
- **Ett dokument vars innehåll tappats går inte att ersätta.** Raden märks
  `available: false`; säljaren får radera och ladda upp på nytt.
- **Bara läsrätt finns som rättighetsnivå.** Kolumnen är förberedd för fler.
- **Realmet släpper in vilken redirect-adress som helst** (`*`), med flit i en miljö där
  adresserna lottas. Ett skarpt realm måste peka ut dem.
- **Migrationer kan inte rullas tillbaka.** Ofarligt mot en icke-persistent databas, men
  måste lösas innan någon miljö blir persistent.

Hela listan, med skälen, står i §10 i [genomförandeplanen](docs/GENOMFORANDE.md), och tre
frågor väntar på beställarens svar i §11: valuta vid anbud i annan valuta än budgeten,
moms, och om en signatur ska spara en hash av villkoren som bevis.

## Teknik

Bun, Fastify och PostgreSQL. Scheman skrivs en gång i TypeBox och driver validering,
TS-typer och OpenAPI-dokumentationen. Anbudsdokumenten ligger i MinIO över S3-API:et; ett
städjobb rensar föräldralösa objekt och larmar via mail när lagringen tappat innehåll.

Webben är React med Vite, och all text går genom `_()` mot en JSON-fil per språk (se
*Språk* ovan). Keycloak över OIDC: webben loggar in med authorization code + PKCE mot
Keycloaks egna sidor, API:et verifierar token mot realmets JWKS och speglar identiteten och
organisationen i egna tabeller vid första anropet. Bakgrunden till bytet från egna konton
står i [docs/SWITCH_TO_KEYCLOAK.md](docs/SWITCH_TO_KEYCLOAK.md).

Aspire med en TypeScript-AppHost orkestrerar miljön, podman kör containrarna.
`.claude/skills/aspire-dev/` bär vardagskommandon och de fel som brukar dyka upp.
