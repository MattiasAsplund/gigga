# fastgig API

Kort översikt. **Swagger är sanningen** — kör `aspire run` och öppna `/docs` för det
fullständiga, alltid aktuella kontraktet. Det här dokumentet finns för att komma igång och
för att förklara konventioner som ett schema inte kan uttrycka.

- Bas: `/api/v1`
- OpenAPI 3.1: `/docs/json`
- Swagger UI: `/docs`
- Hälsa: `/health` (utanför versionsprefixet)

## Autentisering

`POST /auth/register` och `POST /auth/login` ger en access-token. Skicka den som
`Authorization: Bearer <token>`. Livslängd 1 timme; det finns inga refresh-tokens ännu.

**E-postadressen måste bekräftas.** Registreringen skickar ett mail med en länk till
`GET /validate-user?token=<uuid>`. Innan den klickats svarar `/auth/login` med
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
| 401 | Token saknas, är utgången eller ogiltig |
| 403 | Inloggad, men fel part för resursen — eller obekräftad e-postadress |
| 404 | Resursen finns inte |
| 410 | Fanns, men gäller inte längre — utgången verifieringslänk |
| 409 | Konflikt med befintligt tillstånd |
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
| `GET /validate-user` | – | Bekräftar e-postadressen via länken i mailet |
| `POST /auth/resend-verification` | – | Begär ett nytt bekräftelsemail |
| `GET /requests` | ✔ | Listar öppna uppdrag att lämna anbud på |
| `POST /requests` | ✔ | Publicerar en uppdragsförfrågan |
| `POST /requests/{requestId}/bids` | ✔ | Lämnar anbud med plan och ersättning |
| `GET /me/requests` | ✔ | Egna förfrågningar, var och en med sina anbud |
| `GET /me/bids` | ✔ | Egna anbud med status och avtalsläge |
| `POST /bids/{bidId}/contract/signatures` | ✔ | Signerar avtalet |

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

Fritextsökning och sortering i katalogen, ändra eller dra tillbaka anbud, refresh-tokens,
utloggning, nytt bekräftelsemail på begäran, lösenordsåterställning, betalning och
tidrapportering. Se §10 i
[GENOMFORANDE.md](GENOMFORANDE.md).
