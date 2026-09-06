# fastgig API

Kort översikt. **Swagger är sanningen** — kör `aspire run` och öppna `/docs` för det
fullständiga, alltid aktuella kontraktet. Det här dokumentet finns för att komma igång och
för att förklara konventioner som ett schema inte kan uttrycka.

- Bas: `/api/v1`
- OpenAPI 3.1: `/docs/json`
- Swagger UI: `/docs`
- Hälsa: `/health` (utanför versionsprefixet)

## Autentisering

**gigga utfärdar inga tokens.** Identiteten ligger i **Keycloak**, och API:et är
resursserver: det verifierar access-token mot realmets JWKS (RS256) och kräver rätt
`iss` och `aud`. Skicka den som `Authorization: Bearer <token>`.

Token hämtas genom att logga in i webbgränssnittet, som gör authorization code + PKCE mot
Keycloak. Vill du anropa API:et för hand är enklaste vägen att logga in i webben och kopiera
token därifrån.

Alla misslyckanden med själva token — saknad, utgången, manipulerad, fel issuer, fel
mottagare — ger samma `401`. Skillnaden mellan dem säger bara något till den som gissar.

### Keycloak nås under `/auth`

Realmet ligger på webbens egen origin, proxat dit av Vite:
`http://localhost:5173/auth/realms/fastgig`. Det är inte bara bekvämt — Keycloak bygger
sin issuer ur adressen du kom in på, så tokenens `iss` blir densamma vare sig du surfar på
localhost, kör e2e-sviten i en container eller går genom en cloudflare-tunnel.

Adminkonsolen ligger på Keycloak-resursens egen URL i Aspire-dashboarden. Användarnamn och
lösenord genereras vid start och står som parametrar i dashboarden (`keycloak-user`,
`keycloak-password`).

### E-postadressen måste bekräftas

Realmet har `verifyEmail`, så Keycloak skickar bekräftelsemailet och släpper inte igenom
inloggningen förrän länken klickats. API:et kontrollerar dessutom `email_verified` i token
och svarar `403 email-not-verified` — en token kan ha utfärdats innan kravet slog till.

I utvecklingsmiljön går ingen post ut på riktigt: **mailpit** fångar allt, och dess
webbgränssnitt ligger som egen URL i Aspire-dashboarden. Det är där du hämtar länken — nu
för både bekräftelse och glömt lösenord, som båda skickas av Keycloak.

### Varje konto hör till en organisation

gigga är en marknadsplats mellan företag, och **organisationen är part i affären** — inte
personen. Token bär företaget i `organization`-claimen, och API:et kräver **exakt ett**:

| Utfall | Svar |
|---|---|
| Ingen organisation | `403 organization-missing` |
| Flera organisationer | `403 organization-ambiguous` |

**Ingen registrerar sig själv.** Realmet har `registrationAllowed: false`, och inbjudan är
enda vägen in. Den skickas av någon som redan är medlem i organisationen — det är svaret
på vem som godkänner att ett konto hör hemma i ett företag.

Organisationernas domäner avgör *ingenting* om medlemskap. Keycloak använder dem för att
styra identitetsförd inloggning vidare till ett företags egen inloggningstjänst. Att en
adress ser ut att höra till ett företag är alltså inget bevis för att den gör det, och
inget i systemet påstår att någon företräder en domän.

Den som tar emot inbjudan blir medlem när lösenordet satts, och bekräftar adressen
därefter. Notera att gigga känner till en person först efter hens **första inloggning**:
`users`-raden skapas då. Att ge läsrätt till någon som ännu bara finns i Keycloak ger
`404 user-not-found`. Ordningen är avsiktlig: medlemskapet finns **före** bekräftelsen, så
bekräftelselänken kan landa i katalogen i stället för på ett `403 organization-missing`.

Gränssnittet skiljer det från att vara utloggad. En giltig session som avvisas av API:et
visar skälet och en väg ut; den skickas *inte* tillbaka till inloggningen, som bara hade
loggat in igen och studsat tillbaka.

**Vad det betyder i praktiken:** en kollega ser organisationens förfrågningar och anbud
utan att något delats ut, får ändra företagets anbud och får signera dess avtal — men får
inte lämna anbud på den egna organisationens förfrågan. Tilldelad läsrätt
(API 16–18) är därmed vägen **över** företagsgränsen, inte inom den.

`GET /me` svarar `{ id, email, displayName, organization }`. Id:t där är gigga:s eget, inte
Keycloaks `sub` — det är det som ägarskap i övriga svar jämförs mot.

**Rollerna är inte fasta.** Samma organisation kan vara köpare i en förfrågan och säljare i
en annan. Behörighet avgörs alltid av ägarskap i just den raden.

### Glömt lösenord, utloggning, sessioner

Allt detta sköts av Keycloak, på dess egna sidor. gigga har inga sådana endpoints kvar.

## Konventioner

**Belopp** anges som heltal i minorenhet (öre) med separat valuta — `4500000` är 45 000,00
kr. Aldrig decimaltal. `currency` är valfri och betyder `SEK` om den utelämnas.

**Tid** är alltid ISO 8601 med tidszon, i UTC.

**Fel** följer RFC 9457 och kommer som `application/problem+json`:

```json
{
  "type": "https://fastgig.dev/problems/validation-failed",
  "title": "Ogiltig indata",
  "status": 422,
  "detail": "Begäran validerade inte mot schemat.",
  "errors": [{ "path": "budget.amountMinor", "message": "must be >= 1" }]
}
```

`type` är stabil och den enda delen ett program bör grena på. Statuskoderna används så här:

| Kod | Betyder |
|---|---|
| 401 | Token saknas, är utgången eller ogiltig — inklusive fel issuer och fel mottagare |
| 403 | Inloggad, men fel part för resursen — eller obekräftad adress, eller ingen organisation |
| 404 | Resursen finns inte |
| 410 | Fanns, men gäller inte längre |
| 409 | Konflikt med befintligt tillstånd |
| 413 | Filen är större än 10 MB |
| 415 | Filtypen tas inte emot, eller innehållet matchar inte ändelsen |
| 422 | Syntaktiskt giltig men semantiskt ogiltig indata |
| 400 | Trasig JSON — inte schemabrott, de blir 422 |

**Sidbrytning** är markörbaserad. Skicka `?limit=20&cursor=<nextCursor>`; markören är
ogenomskinlig och kommer från föregående svar. `nextCursor: null` betyder sista sidan.
Offset används inte — det tappar och upprepar rader när nya poster tillkommer under
bläddringen.

## Endpoints

| Metod & väg | Auth | Gör |
|---|---|---|
| `GET /me` | ✔ | Egen identitet och organisation |
| `GET /requests` | ✔ | Listar öppna uppdrag att lämna anbud på |
| `POST /requests` | ✔ | Publicerar en uppdragsförfrågan |
| `POST /requests/{requestId}/bids` | ✔ | Lämnar anbud (kräver publicerad kravspec) |
| `PATCH /bids/{bidId}` | ✔ | Ändrar plan, ersättning eller båda |
| `POST /bids/{bidId}/withdrawal` | ✔ | Drar tillbaka anbudet |
| `GET /me/requests` | ✔ | Organisationens förfrågningar, var och en med sina anbud |
| `GET /me/bids` | ✔ | Egna anbud med status och avtalsläge |
| `POST /bids/{bidId}/contract/signatures` | ✔ | Signerar avtalet |
| `GET /requests/{requestId}` | ✔ | Läser en förfrågan med dess anbud |
| `POST /requests/{requestId}/permissions` | ✔ | Ger någon läsrätt till förfrågan |
| `GET /requests/{requestId}/permissions` | ✔ | Listar tilldelade rättigheter |
| `DELETE /requests/{requestId}/permissions/{userId}` | ✔ | Tar tillbaka läsrätt |
| `POST /bids/{bidId}/attachments` | ✔ | Laddar upp ett anbudsdokument |
| `GET /bids/{bidId}/attachments` | ✔ | Listar dokumentens metadata |
| `GET /bids/{bidId}/attachments/archive` | ✔ | Laddar ner alla dokument som ZIP |
| `PATCH /bids/{bidId}/attachments/{attachmentId}` | ✔ | Byter filnamn |
| `DELETE /bids/{bidId}/attachments/{attachmentId}` | ✔ | Raderar ett dokument |
| `GET /gig-types` | ✔ | Listar uppdragstyperna kunden väljer mellan |
| `GET /gig-types/interview` | ✔ | Intervjufrågorna för valda typer, sammanslagna |
| `GET /requests/{requestId}/spec` | ✔ | Läser kravspecen |
| `POST /requests/{requestId}/spec` | ✔ | Öppnar kravspecen med valda typer |
| `POST /requests/{requestId}/spec/revisions` | ✔ | Öppnar nästa utkast som kopia |
| `PUT /requests/{requestId}/spec/answers` | ✔ | Sparar svar på intervjufrågorna |
| `POST /requests/{requestId}/spec/criteria` | ✔ | Lägger till en egen kriterierad |
| `PATCH /requests/{requestId}/spec/criteria/{criterionId}` | ✔ | Skriver om en rad |
| `DELETE /requests/{requestId}/spec/criteria/{criterionId}` | ✔ | Stryker en rad |
| `POST /requests/{requestId}/spec/criteria/{criterionId}/approval` | ✔ | Godkänner en rad |
| `POST /requests/{requestId}/spec/publication` | ✔ | Publicerar kravspecen |

### Katalogen

`GET /requests` är säljarens ingång. Den visar bara uppdrag som faktiskt går att lämna
anbud på — `open` och med deadline kvar. Varje post har:

- `bidCount` — hur många anbud som redan lämnats. **Innehållet i dem lämnas aldrig ut här.**
- `hasMyBid` — har du själv ett aktivt anbud?
- `canBid` — falskt för dina egna förfrågningar och när du redan bjudit, så du slipper ett
  anrop som ändå skulle ge 403 eller 409.

Filtrera med `?compensationPref=fixed|hourly|any`, sidbryt som vanligt.

### Ersättning i ett anbud

Diskriminerad på `type` — exakt en av formerna, aldrig fält från båda:

```json
{ "type": "fixed",  "amountMinor": 4500000, "currency": "SEK" }
{ "type": "hourly", "rateMinor": 95000, "estimatedHours": 40, "currency": "SEK" }
```

Svaret innehåller `estimatedTotalMinor` — för timanbud `rateMinor × estimatedHours`
avrundat till hela ören — så att anbud går att jämföra utan att räkna själv.

### Ändra eller dra tillbaka ett anbud

```bash
curl -X PATCH $API/bids/$BID -H "authorization: Bearer $ST" \
  -H 'content-type: application/json' \
  -d '{"compensation":{"type":"fixed","amountMinor":3900000,"currency":"SEK"}}'

curl -X POST $API/bids/$BID/withdrawal -H "authorization: Bearer $ST"
```

`plan` och `compensation` går att ändra var för sig, men **ersättningen byts i sin helhet**
— en halvt ifylld form går inte att räkna på. En kropp utan fält alls ger `422`.

Båda kräver att du är anbudets säljare (`403`), att förfrågan är öppen och att deadline
inte passerat (`422`). **När köparen signerat är anbudet låst: `409 contract-exists`** —
villkoren ligger frysta i avtalet, och ångrar du dig räcker det att låta bli att signera.

Tillbakadragande är idempotent och svarar `200` även andra gången. Ett tillbakadraget
anbud räknas inte i katalogen, och du får lämna ett **nytt** anbud på samma förfrågan.

### Anbudsdokument

Ett anbud kan kompletteras med **Markdown och PDF** när som helst, även efter att avtalet
signerats — dokument är komplement, inte avtalsinnehåll.

```bash
curl -X POST $API/bids/$BID/attachments -H "authorization: Bearer $ST" \
  -F "file=@förslag.md"
```

Filerna lagras i objektlagring (MinIO i utvecklingsmiljön), inte i databasen — men det
märks inte utifrån: API:et är detsamma.

Högst 10 MB per fil och 20 filer per anbud. **Filtypen avgörs av innehållet**, inte av
ändelsen: en `.pdf` som inte börjar med `%PDF-` avvisas med `415`. Filnamn saneras från
sökvägar och måste vara unika inom anbudet (`409` annars). Ett namnbyte får inte ändra
filändelsen.

Varje dokument i listan har `available`. Är det `false` har innehållet försvunnit ur
lagringen — metadata finns kvar, så du ser att dokumentet bifogats, men filen går inte att
hämta och utelämnas ur ZIP-arkivet. Raden raderas aldrig automatiskt; säljaren får ladda
upp dokumentet på nytt.

Ladda ner allt på en gång:

```bash
curl -OJ $API/bids/$BID/attachments/archive -H "authorization: Bearer $KT"
```

Arkivet är öppet för säljaren som lämnat anbudet, förfrågans köpare, och den som fått
läsrätt. Ett anbud utan dokument ger ett tomt arkiv med `200`, inte `404`.

### Dela en förfrågan

Köparen kan låta andra läsa sin förfrågan — typiskt kollegor som ska bedöma anbuden:

```bash
curl -X POST $API/requests/$REQ/permissions -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' -d '{"email":"kollega@example.se"}'
```

`GET /requests/{id}` är öppen för alla inloggade — en säljare måste kunna läsa förfrågan
för att lämna anbud på den — men visar bara anroparens *eget* anbud. Läsrätten är det som
ger **alla** anbud, med dokumentlistan och ZIP-arkiven. Den ger
**inte** rätt att dela vidare, signera eller ändra något. Ta tillbaka med
`DELETE /requests/{id}/permissions/{userId}` — åtkomsten stängs vid nästa anrop.

### Signering

Det finns inget separat "acceptera anbud". **Köparens signatur är accepterandet:**

1. Köparen signerar → avtalet skapas med anbudets villkor **frysta** i `terms`, status
   `pending_signatures`. Förfrågan är fortfarande `open` — ett halvsignerat avtal binder
   ingen.
2. Säljaren signerar → status `active`. I samma transaktion blir förfrågan `awarded`, det
   vinnande anbudet `accepted` och övriga anbud `rejected`.

Säljaren kan inte signera först — då finns inget avtal, och svaret är `409`.

Anropet är **idempotent**: samma part kan signera igen utan att något ändras, inte ens
tidsstämpeln. Ändras anbudet efter att avtalet skapats rör det inte `terms`.

Endast förfrågans köpare och anbudets säljare är parter; alla andra får `403`.

### Uppdragstyp och kravspec

**Anbud kräver en publicerad kravspec.** Utan den svarar `POST /requests/{id}/bids` med
`409 spec-not-published`, och katalogen visar `hasPublishedSpec: false` och `canBid: false`
på förfrågan. Ett utkast räcker inte — det är den publicerade lydelsen anbudet binds till.


En förfrågan blir prissättbar först när kunden sagt vilken sorts uppdrag det är och svarat
på frågorna som hör till den sortens uppdrag. Flödet:

1. `GET /gig-types` — typerna att välja mellan. Flera får väljas.
2. `POST /requests/{id}/spec` med `{ "gigTypes": ["data-migration"] }` — öppnar kravspecen.
   Svaret bär `questions` (basmallens frågor plus typernas, sammanslagna) och `criteria`
   (utkast till acceptanskriterier, minimikrav, ingår-inte och villkor).
3. `PUT /requests/{id}/spec/answers` — ett steg i taget. Svaren prövas mot frågans egen
   form; ett heltal där en sträng skickas ⇒ `422` med frågenyckeln som pekare.
4. `POST|PATCH|DELETE …/spec/criteria…` — kunden lägger till, skriver om och stryker rader.
5. `…/spec/criteria/{id}/approval` — varje kriterium godkänns aktivt, och godkännandet
   tidsstämplas. En omskriven rad tappar sitt godkännande.
6. `POST …/spec/publication` — publicerar, om allt som krävs finns.

**Frågorna är data, inte kod.** Vilka typer som finns och vilka frågor de ställer kommer ur
`services/api/catalog/`. En klient ska rendera det den får i `questions` — `kind`, `options`
och `config` säger hur fältet ska se ut — och aldrig hårdkoda en frågenyckel.

**Villkorade frågor.** En fråga med `condition` ställs bara när villkoret stämmer mot redan
lämnade svar; `visible` i svaret är villkoret redan utvärderat. En dold fråga hindrar inte
publicering.

**`completeness`** är fullständighetsindikatorn: `requiredQuestions`, `answeredRequired`,
`criteria`, `approvedCriteria`, `publishable` och `blockers` med en rad per brist. Den räknar
exakt det publiceringen kräver, så gränssnittet kan visa hur långt kunden kommit i stället
för att överraska i sista steget.

**Efter publicering är lydelsen låst.** Skrivningar ger `409 spec-not-draft`, och anbud som
lämnas därefter binds till versionen. Ändras omfattningen under den publika frågefasen:
`POST …/spec/revisions` öppnar nästa utkast som en kopia — den publicerade versionen står
kvar som gällande tills det nya publiceras.

**Vem ser vad.** Köparen och den med läsrätt ser sitt utkast. Alla andra inloggade ser den
publicerade versionen, och `404` innan dess: ett utkast är köparens interna arbete.

## Ett helt flöde

```bash
API=http://localhost:PORT/api/v1   # porten syns i Aspire-dashboarden

# Kontona skapas i Keycloak, inte här: öppna webben, registrera Kim och Robin, klicka
# bekräftelselänkarna i mailpit, och koppla var och en till sin organisation. Därefter
# hämtas token ur webbläsarens sessionStorage (nyckeln börjar på "oidc.user:").
KT=<Kims access-token>
ST=<Robins access-token>

REQ=$(curl -s -X POST $API/requests -H "authorization: Bearer $KT" \
  -H 'content-type: application/json' \
  -d '{"title":"Bygg en Fortnox-integration","description":"Synk varje timme, på distans.","compensationPref":"any","budget":{"amountMinor":5000000,"currency":"SEK"}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')

curl -s "$API/requests" -H "authorization: Bearer $ST"      # katalogen: hittar uppdraget

BID=$(curl -s -X POST $API/requests/$REQ/bids -H "authorization: Bearer $ST" \
  -H 'content-type: application/json' \
  -d '{"plan":"Kartläggning, bygge, överlämning.","compensation":{"type":"hourly","rateMinor":95000,"estimatedHours":40,"currency":"SEK"}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')

curl -s -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $KT"   # pending_signatures
curl -s -X POST $API/bids/$BID/contract/signatures -H "authorization: Bearer $ST"   # active

curl -s "$API/me/requests" -H "authorization: Bearer $KT"   # awarded, med anbudens status
curl -s "$API/me/bids"     -H "authorization: Bearer $ST"   # accepted, med avtalets läge
```

Signeringsanropen har ingen kropp. `content-type: application/json` utan kropp är tillåtet.

## Vad som inte finns än

Fritextsökning och sortering i katalogen, betalning och tidrapportering, och kriteriernas
utfall vid acceptans (`met`/`failed`/`waived` finns i modellen men har ingen väg dit).
Intervjun sparar först när man trycker på Spara — inget autospar per fält — och
indikatorns brister går inte att klicka sig till. Se §10 i
[GENOMFORANDE.md](GENOMFORANDE.md).
