# fastgig

Marknadsplats för distansuppdrag. **Köpare** publicerar uppdragsförfrågningar, **säljare**
lämnar anbud med en genomförandeplan och ett pris — fast eller per timme — och parterna
signerar ett avtal.

Repot innehåller ett REST-API med 25 endpoints, ett webbgränssnitt ovanpå det, och en
Playwright-svit som går hela flödet genom gränssnittet.

**Roller är inte knutna till konton.** Samma användare är köpare i en förfrågan och säljare
i en annan. Behörighet avgörs alltid av ägarskap i just den raden.

## Kom igång

```bash
systemctl --user enable --now podman.socket     # engångsåtgärd
bun install
aspire run
```

Dashboarden startar på `https://localhost:17173` (se `aspire.config.json`) och länkar
vidare till:

| Resurs | Vad du gör där |
|---|---|
| **web** | Gränssnittet — registrera, publicera, lämna anbud, signera |
| **api** | Swagger UI på `/docs`, OpenAPI 3.1 på `/docs/json` |
| **keycloak** | Konton, lösenord och organisationer. Adminkonsolen; uppgifterna står som parametrar i dashboarden |
| **mailpit** | Läser bekräftelse- och återställningsmail — inget skickas på riktigt |
| **pgweb** | Bläddrar i tabellerna |
| **minio** | Ser anbudsdokumenten som objekt |
| **e2e** | Playwright-sviten. Startas på begäran, inte vid `aspire run` |

Postgres, MinIO och Keycloak är **icke-persistenta**: allt försvinner vid `aspire stop`.
Schemat byggs upp vid varje start, och realmet importeras om ur
`keycloak/realm/fastgig-realm.json`.

Keycloak nås under `/auth` på webbens egen adress (`http://localhost:5173/auth`), proxad
dit av Vite. Det är vad som gör att tokenens issuer blir densamma vare sig du surfar på
localhost, kör e2e-sviten i en container eller går genom en cloudflare-tunnel.

### Visa upp miljön utanför maskinen

```bash
bun run dev-cloudflare
```

Samma miljö, plus två cloudflared-snabbtunnlar: en framför **web** och en framför
**mailpit**. Adresserna på `trycloudflare.com` hängs på respektive resurs i dashboarden,
bredvid localhost-länken. `PUBLIC_BASE_URL` följer med webbens tunnel, så bekräftelse- och
återställningslänkarna i breven pekar utåt och fungerar för den som öppnar gränssnittet
utifrån.

API:et får ingen egen tunnel och behöver ingen: Vites `/api`-proxy körs på värden, så det
sista hoppet till API:et sker aldrig över internet och webbläsaren ser bara ett
origin.

Tunnelprocesserna är långlivade — de överlever `aspire stop` och återanvänds vid nästa
start, så en utdelad länk fortsätter fungera över en omstart. Stäng dem från dashboarden
eller med `pkill cloudflared`.

Första körningen efter att tunnlarna dödats är dashboardens två länkar inte med: adressen
finns inte när resurserna byggs, och de länkarna räknas ut en gång. Breven pekar rätt ändå
— api startas om när tunneln svarar — och nästa `bun run dev-cloudflare` har allt på plats.

Kräver `cloudflared` i PATH. Länkarna är öppna för var och en som har dem, och mailpit
visar all post i miljön — dela dem därefter.

```bash
bun test                  # 297 tester, ~45 s
bun run test:coverage     # samma, plus täckningsrapport
```

Rapporten hamnar i `services/api/coverage/` (gitignorerad): `index.html` med annoterad
källkod, `lcov.info` för CI och `summary.txt` som textabell. Täckningen ligger på 92,9 %
av funktionerna och 94,9 % av raderna; det som saknas är främst SMTP- och S3-koden, som
testerna med flit ersätter med minnesvarianter.

---

## Arbetsflödet, från förfrågan till signerat avtal

Nio steg. Sätt `API` till API:ets adress från dashboarden.

```bash
API=http://localhost:PORT/api/v1
```

### 1. Ingen registrerar sig själv

Realmet har `registrationAllowed: false`. **Inbjudan är enda vägen in**, och den skickas av
någon som redan är medlem i organisationen — det är svaret på vem som godkänner att ett
konto hör hemma i ett företag.

Domänerna på organisationerna (`nordvind.test` och de andra) avgör *ingenting* om
medlemskap. Keycloak använder dem för att styra identitetsförd inloggning vidare till ett
företags egen inloggningstjänst, inget mer. Att en adress ser ut att höra till ett företag
är alltså inget bevis för att den gör det.

Fyra organisationer finns i realmet:

| Alias | Namn | Domän | Roll i genomgången |
|---|---|---|---|
| `gigga` | Gigga AB | `provider.test` | marknadsplatsen själv — härifrån bjuds kundföretagen in |
| `nordvind` | Nordvind Bygg | `nordvind.test` | köpare |
| `sydlig` | Sydlig Teknik | `sydlig.test` | säljare |
| `granskaren` | Granskaren AB | `granskaren.test` | utomstående med tilldelad läsrätt |

### 2. Bjud in fyra personer

Öppna **keycloak** i dashboarden och logga in som **`admin` / `admin`** — ett fast konto,
satt i AppHosten, så att inbjudningar går att skicka utan att slå upp ett lottat lösenord
vid varje omstart. Det gäller bara den här utvecklingsmiljön; Keycloak här är
icke-persistent och lever på localhost.

Välj realmet **fastgig** → *Organizations* → företaget → *Members* → *Invite member*, och
bjud in:

| Person | Företag | Roll i flödet |
|---|---|---|
| Kim | `nordvind` | köpare |
| Lo | `nordvind` | Kims kollega |
| Robin | `sydlig` | säljare |
| Mio | `granskaren` | utomstående som får läsrätt |

### 3. Ta emot inbjudan och bekräfta adressen

Öppna **mailpit** och klicka länken i inbjudan. Den leder till ett registreringsformulär —
trots att självregistreringen är avstängd. Det är token i länken som öppnar dörren, och
bara för den adressen. Namnet är ifyllt; lösenordet är det som saknas.

När lösenordet satts är kontot **medlem i företaget direkt**, med bekräftelsen kvar som
krav. Ordningen är värd att lägga märke till: medlemskapet finns *före* bekräftelsen, så
bekräftelselänken kan landa i katalogen i stället för på ett `403 organization-missing`.

Logga sedan in i **web**. Keycloak kräver bekräftad adress, skickar brevet, och när länken
klickats är man inne.

### 3b. Token för curl

Resten av det här dokumentet anropar API:et direkt. Token hämtas ur webbläsaren efter
inloggning — `sessionStorage`, nyckeln som börjar på `oidc.user:`:

```bash
API=http://localhost:5173/api/v1   # genom webbens proxy, samma origin som gränssnittet
KT=<Kims access-token>             # köparen
ST=<Robins access-token>           # säljaren
```

### 4. Kim publicerar en förfrågan

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

### 4b. Kim fastställer kravspecen

En förfrågan går inte att bjuda på förrän kunden sagt vilken sorts uppdrag det är, svarat
på frågorna som hör till den sorten och godkänt acceptanskriterierna. I gränssnittet är
det en sida — `/requests/<id>/spec` — och den vägen är den avsedda. Samma sak genom API:et:

```bash
curl -s "$API/gig-types" -H "authorization: Bearer $KT"          # typerna att välja mellan

curl -s -X POST $API/requests/$REQ/spec -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' -d '{"gigTypes":["integration"]}'

# Svaret bär frågorna. Ett steg i taget, i den form frågetypen anger:
curl -s -X PUT $API/requests/$REQ/spec/answers -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' \
  -d '{"answers":[{"questionKey":"integration.systems","value":"Fortnox och vårt ordersystem"}]}'

# Varje acceptanskriterium godkänns aktivt, och sedan publiceras lydelsen:
curl -s -X POST $API/requests/$REQ/spec/criteria/$RAD/approval -H "authorization: Bearer $KT"
curl -s -X POST $API/requests/$REQ/spec/publication -H "authorization: Bearer $KT"
```

Frågorna är **data**, inte kod: de kommer ur `services/api/catalog/` och en ny uppdragstyp
är en fil där. En klient ska rendera det den får i `questions` — `kind`, `options` och
`config` säger hur fältet ser ut — och aldrig hårdkoda en frågenyckel. Villkorade frågor
dyker upp när svaret på frågan de hänger på är sparat.

`completeness` i svaret säger vad som återstår, och det är samma räkning som publiceringen
gör: inga överraskningar i sista steget.

### 5. Robin hittar uppdraget

```bash
curl -s "$API/requests" -H "authorization: Bearer $ST"
```

Katalogen visar bara uppdrag som faktiskt går att bjuda på: öppna, med deadline kvar. Varje
post säger hur många anbud som redan finns (`bidCount`), om du själv bjudit (`hasMyBid`),
om kravspecen är publicerad (`hasPublishedSpec`) och om du får bjuda (`canBid`) — det
sista är falskt för dina egna förfrågningar, när du redan bjudit, och när kravspecen inte
är fastställd.

### 6. Robin lämnar anbud

```bash
BID=$(curl -s -X POST $API/requests/$REQ/bids -H "authorization: Bearer $ST" \
  -H 'content-type: application/json' \
  -d '{"plan":"Kartläggning, bygge, överlämning.",
       "compensation":{"type":"hourly","rateMinor":95000,"estimatedHours":40}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')
```

Antingen `{"type":"fixed","amountMinor":…}` eller
`{"type":"hourly","rateMinor":…,"estimatedHours":…}` — aldrig fält från båda. Svaret räknar
ut `estimatedTotalMinor` så anbud går att jämföra utan huvudräkning.

### 7. Robin bifogar dokument

```bash
curl -X POST $API/bids/$BID/attachments -H "authorization: Bearer $ST" \
  -F "file=@offert.pdf"
```

Markdown och PDF, högst 10 MB per fil och 20 per anbud, **när som helst** — även efter att
avtalet signerats. Filtypen avgörs av innehållet, inte av filändelsen. Dokument går att
byta namn på och radera så länge anbudet är ditt.

### 8. Kim läser anbuden

```bash
curl -s "$API/me/requests" -H "authorization: Bearer $KT"          # med alla anbud
curl -OJ "$API/bids/$BID/attachments/archive" -H "authorization: Bearer $KT"
```

Ska en kollega vara med och bedöma? Ge läsrätt med
`POST /requests/$REQ/permissions` och adressen — då når hen förfrågan, anbuden och
dokumenten, men kan varken bjuda, signera eller dela vidare. `DELETE` på samma väg stänger
åtkomsten omedelbart.

### 9. Båda signerar

```bash
curl -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $KT"  # köparen
curl -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $ST"  # säljaren
```

Det finns inget separat "acceptera anbud" — **köparens signatur är accepterandet.** Den
skapar avtalet med anbudets villkor frysta i `terms`; ändras anbudet därefter rör det inte
avtalet. Säljarens signatur aktiverar det, och i samma transaktion blir förfrågan `awarded`,
det vinnande anbudet `accepted` och övriga `rejected`.

Anropet är idempotent: samma part kan signera igen utan att något ändras.

---

## Vad backenden gör

| Område | Stöd |
|---|---|
| **Konton** | Registrering, inloggning, e-postbekräftelse med utgångstid, nytt bekräftelsemail, lösenordsåterställning, kvotgräns per anropare på de två som skickar mail |
| **Sessioner** | Access-token (1 h) + refresh-token (30 d) med rotation och läckagedetektering, utloggning per session, lösenordsbyte som stänger alla |
| **Förfrågningar** | Publicera, läsa egna med anbud, katalog över öppna med filter och sidbrytning |
| **Anbud** | Fast pris eller timpris, beräknat totalbelopp, ett aktivt anbud per säljare och förfrågan, ändra och dra tillbaka |
| **Dokument** | Markdown och PDF i objektlagring, namnbyte, radering, nedladdning av alla som ZIP |
| **Företag** | Organisationen är part i affären: kollegor delar förfrågningar, anbud och avtal genom sitt medlemskap |
| **Delning** | Läsrätt över företagsgränsen till namngivna användare, återkallningsbar |
| **Avtal** | Tvåpartssignering med frysta villkor, tilldelning och avslag i en transaktion |
| **Drift** | `/health`, OpenAPI som genereras ur koden, städning av lagringen med larm |

Alla felsvar följer RFC 9457 (`application/problem+json`) med ett stabilt `type` att grena
på. Se [docs/API.md](docs/API.md) för konventioner och
[docs/GENOMFORANDE.md](docs/GENOMFORANDE.md) för besluten bakom dem.

---

## Vad som saknas

**Flödet slutar vid ett signerat avtal.** Allt som händer efter det saknas helt: ingen
leveransrapportering, ingen tidrapportering, ingen fakturering och ingen betalning. Ett
"genomfört anbud" är i dagsläget ett anbud vars avtal är `active` — systemet vet inte om
arbetet faktiskt blev gjort.

Utöver det:

- **Förfrågningar går inte att ändra eller avbryta.** `cancelled` finns i schemat men
  inget API sätter den. Säljaren kan ändra och dra tillbaka sitt anbud, köparen har ingen
  motsvarande väg ut ur sin förfrågan.
- **Katalogen har varken fritextsökning eller sortering.** Bara filter på ersättningsform.
- **Ett dokument vars innehåll tappats går inte att ersätta.** Raden markeras
  `available: false`; säljaren får radera och ladda upp på nytt, vilket ger ett nytt id.
- **Bara läsrätt finns som rättighetsnivå.** Kolumnen är förberedd för fler.
- **Onboarding saknar sista steget.** Ett konto som registrerats i Keycloak hör inte till
  någon organisation, och måste kopplas för hand innan det kan användas. Keycloak har
  inbjudningar; gigga använder dem inte än.
- **Ett konto kan bara höra till ett företag.** Flera organisationer i token ger
  `403 organization-ambiguous` — en konsult som arbetar för två bolag behöver ett val i
  gränssnittet, och det valet måste följa med i varje begäran.
- **Organisationens visningsnamn når aldrig fram.** `organization`-claimen bär bara
  aliaset, så "Nordvind Bygg" visas som `nordvind`.
- **Migrationer kan inte rullas tillbaka.** Ofarligt mot en icke-persistent databas, men
  måste lösas innan någon miljö blir persistent.

Tre frågor väntar dessutom på beställarens svar: valuta vid anbud i annan valuta än
budgeten, momshantering, och om en signatur ska spara en hash av villkoren som bevis. De
står i §11 i [genomförandeplanen](docs/GENOMFORANDE.md).

---

## Teknik

Bun, Fastify och PostgreSQL, orkestrerat av Aspire med en TypeScript-AppHost. Podman kör
containrarna. Scheman skrivs en gång i TypeBox och driver både validering, TS-typer och
OpenAPI-dokumentationen — inget skrivs för hand två gånger.

Identiteten ligger i **Keycloak** över OIDC: API:et utfärdar inga tokens utan verifierar
Keycloaks mot realmets JWKS. Webben loggar in med authorization code + PKCE mot Keycloaks
egna sidor. Realmet — klienter, organisationer, SMTP och verifieringskravet — är en
incheckad JSON-fil, inte klick i en adminkonsol.

Testerna är specifikationen: 263 fall med stabila ID:n som API:erna byggts fram genom.
Matrisen finns i §7.2 i [genomförandeplanen](docs/GENOMFORANDE.md).
