# fastgig API

Kort översikt. **Swagger är sanningen** — kör `aspire run` och öppna `/docs` för det
fullständiga, alltid aktuella kontraktet. Det här dokumentet finns för att komma igång och
för att förklara konventioner som ett schema inte kan uttrycka.

- Bas: `/api/v1`
- OpenAPI 3.1: `/docs/json`
- Swagger UI: `/docs`
- Hälsa: `/health` (utanför versionsprefixet)

## Autentisering

`POST /auth/register` och `POST /auth/login` ger en **access-token** (1 timme) och en
**refresh-token** (30 dagar). Skicka access-token som `Authorization: Bearer <token>`.

När access-token gått ut: `POST /auth/refresh` med `{ refreshToken }` ger ett nytt par.
Den gamla refresh-token förbrukas i samma anrop — **spara alltid den nya**. Använder du en
redan förbrukad token antas den ha läckt, och hela sessionen avslutas (`401
refresh-token-reused`); då återstår inloggning med lösenord.

**Utloggning.** `POST /auth/logout` avslutar den session token tillhör; därefter svarar
den `401 session-ended`. Andra sessioner för samma konto påverkas inte — logga ut på
telefonen utan att datorn kastas ut. För att avsluta samtliga sessioner: byt lösenord.

**E-postadressen måste bekräftas.** Registreringen skickar ett mail med en länk till
webbens `/verify?token=<uuid>`, som i sin tur anropar `GET /validate-user?token=<uuid>`
och visar hur det gick. Innan den klickats svarar `/auth/login` med
`403 email-not-verified` — och **det gör varje skyddad endpoint också**, även med den token
registreringen returnerade. Länken är idempotent och tål att klickas flera gånger.

Samma token börjar fungera direkt när länken klickats; ingen ny inloggning behövs. En token
vars konto inte finns kvar ger `401`.

**Länken gäller i 24 timmar.** Därefter svarar den `410 verification-token-expired`. En
länk som redan använts fortsätter dock svara `200` även efter utgången — kontot är ju
bekräftat.

**Tappat mailet, eller gått ut?** `POST /auth/resend-verification` med `{ email }` skickar
ett nytt och gör den gamla länken ogiltig — bara det senaste mailet gäller. Svaret är alltid
`202 { "accepted": true }`, oavsett om adressen finns, redan är bekräftad eller nyss fått
ett mail. Det är avsiktligt: allt annat vore ett sätt att ta reda på vilka adresser som är
registrerade. Ett nytt mail skickas som mest en gång per minut och konto.

I utvecklingsmiljön går ingen post ut på riktigt: **mailpit** fångar allt, och dess
webbgränssnitt ligger som egen URL i Aspire-dashboarden. Det är där du hämtar länken.

**Rollerna är inte fasta.** Samma konto kan vara köpare i en förfrågan och säljare i en
annan. Behörighet avgörs alltid av ägarskap i just den raden, aldrig av en roll på kontot.

### Glömt lösenord

`POST /auth/forgot-password` med `{ email }` skickar en kod och svarar alltid
`202 { "accepted": true }` — samma läckagefria mönster och kylperiod som bekräftelsemailen.

Båda endpointsen har dessutom en **kvotgräns per anropare: 5 anrop per 15 minuter**, var
för sig. Över gränsen svarar de `429 too-many-requests` med `retry-after` i sekunder, och
inget mail skickas. Kylperioden ligger per konto och biter inte på den som varierar
adressen — det är vad kvoten är till för.

`POST /auth/reset-password` med `{ token, password }` sätter det nya lösenordet. Koden
gäller i **en timme** och **en gång**: efter användning ger den `404`, efter utgången `410`.
Ett misslyckat försök — för kort lösenord — bränner den inte.

**Mailet bär koden i klartext med instruktioner**, eftersom webben ännu inte har någon
sida för att sätta nytt lösenord — till skillnad från bekräftelselänken, som går via
`/verify`. Sätt `PASSWORD_RESET_URL` när sidan finns, så skickas en klickbar länk i stället.

**Alla tidigare access-tokens slutar gälla** vid lösenordsbytet och ger `401 token-revoked`.
Logga in igen för att få en ny. Andra användares tokens berörs förstås inte.

En sak att känna till: återställningen **bekräftar inte** e-postadressen — det är ett eget
flöde.

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
| 202 | Mottaget — utan besked om vad som hände (se resend-verification) |
| 401 | Token saknas, är utgången, ogiltig — eller återkallad av ett lösenordsbyte |
| 403 | Inloggad, men fel part för resursen — eller obekräftad e-postadress |
| 404 | Resursen finns inte |
| 410 | Fanns, men gäller inte längre — utgången verifieringslänk |
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
| `POST /auth/register` | – | Skapar konto, returnerar token |
| `POST /auth/login` | – | Loggar in, returnerar token |
| `GET /validate-user` | – | Bekräftar e-postadressen; anropas av webbens `/verify` |
| `POST /auth/resend-verification` | – | Begär ett nytt bekräftelsemail |
| `POST /auth/refresh` | – | Byter refresh-token mot en ny access-token |
| `POST /auth/logout` | ✔ | Avslutar den session token tillhör |
| `POST /auth/forgot-password` | – | Begär lösenordsåterställning |
| `POST /auth/reset-password` | – | Sätter nytt lösenord med koden ur mailet |
| `GET /requests` | ✔ | Listar öppna uppdrag att lämna anbud på |
| `POST /requests` | ✔ | Publicerar en uppdragsförfrågan |
| `POST /requests/{requestId}/bids` | ✔ | Lämnar anbud (kräver publicerad kravspec) |
| `PATCH /bids/{bidId}` | ✔ | Ändrar plan, ersättning eller båda |
| `POST /bids/{bidId}/withdrawal` | ✔ | Drar tillbaka anbudet |
| `GET /me/requests` | ✔ | Egna förfrågningar, var och en med sina anbud |
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

kopare=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"kim@example.se","password":"ett-langt-losenord","displayName":"Kim"}')
saljare=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"robin@example.se","password":"ett-langt-losenord","displayName":"Robin"}')

# Hämta bekräftelselänkarna ur mailpit (URL:en syns i Aspire-dashboarden) och klicka dem
# innan inloggning. Registreringens token fungerar direkt, men /auth/login kräver bekräftelse.

KT=$(echo "$kopare"  | bun -e 'console.log((await Bun.stdin.json()).token)')
ST=$(echo "$saljare" | bun -e 'console.log((await Bun.stdin.json()).token)')

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
