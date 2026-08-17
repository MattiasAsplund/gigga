# fastgig

Marknadsplats för distansuppdrag. **Köpare** publicerar uppdragsförfrågningar, **säljare**
lämnar anbud med en genomförandeplan och ett pris — fast eller per timme — och parterna
signerar ett avtal.

Det här är backenden: ett REST-API med 23 endpoints. Ingen frontend finns.

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
| **api** | Swagger UI på `/docs`, OpenAPI 3.1 på `/docs/json` |
| **mailpit** | Läser bekräftelse- och återställningsmail — inget skickas på riktigt |
| **pgweb** | Bläddrar i tabellerna |
| **minio** | Ser anbudsdokumenten som objekt |

Postgres och MinIO är **icke-persistenta**: allt försvinner vid `aspire stop`. Schemat
byggs upp vid varje start.

```bash
bun test                  # 263 tester, ~35 s
bun run test:coverage     # samma, plus täckningsrapport
```

Rapporten hamnar i `services/api/coverage/` (gitignorerad): `index.html` med annoterad
källkod, `lcov.info` för CI och `summary.txt` som textabell. Täckningen ligger på 92,5 %
av funktionerna och 94,7 % av raderna; det som saknas är främst SMTP- och S3-koden, som
testerna med flit ersätter med minnesvarianter.

---

## Arbetsflödet, från förfrågan till signerat avtal

Nio steg. Sätt `API` till API:ets adress från dashboarden.

```bash
API=http://localhost:PORT/api/v1
```

### 1. Två konton

```bash
curl -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"kim@example.se","password":"ett-langt-losenord","displayName":"Kim"}'
curl -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"robin@example.se","password":"ett-langt-losenord","displayName":"Robin"}'
```

Kim blir köpare, Robin säljare. Registreringen returnerar en access-token direkt — men den
duger inte förrän adressen är bekräftad.

### 2. Bekräfta adresserna

Öppna **mailpit** i dashboarden och klicka länken i vartdera mailet. Länken går till
`GET /validate-user?token=…`, gäller i 24 timmar och tål att klickas flera gånger. Tappat
mailet? `POST /auth/resend-verification`.

Utan det här steget svarar både inloggning och varje skyddad endpoint `403
email-not-verified`.

### 3. Logga in

```bash
token() {
  curl -s -X POST $API/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"ett-langt-losenord\"}" \
    | bun -e 'console.log((await Bun.stdin.json()).token)'
}
KT=$(token kim@example.se)      # köparen
ST=$(token robin@example.se)    # säljaren
```

Access-token gäller en timme, refresh-token trettio dagar. Byt den utgångna mot en ny med
`POST /auth/refresh` — varje refresh-token duger en gång och byts mot en ny.

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

### 5. Robin hittar uppdraget

```bash
curl -s "$API/requests" -H "authorization: Bearer $ST"
```

Katalogen visar bara uppdrag som faktiskt går att bjuda på: öppna, med deadline kvar. Varje
post säger hur många anbud som redan finns (`bidCount`), om du själv bjudit (`hasMyBid`)
och om du får bjuda (`canBid`) — det sista är falskt för dina egna förfrågningar.

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
| **Konton** | Registrering, inloggning, e-postbekräftelse med utgångstid, nytt bekräftelsemail, lösenordsåterställning |
| **Sessioner** | Access-token (1 h) + refresh-token (30 d) med rotation och läckagedetektering, utloggning per session, lösenordsbyte som stänger alla |
| **Förfrågningar** | Publicera, läsa egna med anbud, katalog över öppna med filter och sidbrytning |
| **Anbud** | Fast pris eller timpris, beräknat totalbelopp, ett aktivt anbud per säljare och förfrågan |
| **Dokument** | Markdown och PDF i objektlagring, namnbyte, radering, nedladdning av alla som ZIP |
| **Delning** | Läsrätt på en förfrågan till namngivna användare, återkallningsbar |
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

- **Anbud går inte att ändra eller dra tillbaka.** Statusen `withdrawn` finns i schemat men
  inget API sätter den. Fel i ett anbud kan bara rättas genom att köparen väljer ett annat.
- **Förfrågningar går inte att ändra eller avbryta.** `cancelled` finns, likaså oanvänd.
- **Katalogen har varken fritextsökning eller sortering.** Bara filter på ersättningsform.
- **Ett dokument vars innehåll tappats går inte att ersätta.** Raden markeras
  `available: false`; säljaren får radera och ladda upp på nytt, vilket ger ett nytt id.
- **Bara läsrätt finns som rättighetsnivå.** Kolumnen är förberedd för fler.
- **Aktiva sessioner går inte att lista.** Utloggning kräver att man har sin egen token.
- **Kvoträknarna lever i processen.** `/auth/resend-verification` och
  `/auth/forgot-password` har en gräns per anropare utöver kylperioden per konto, men
  räknarna nollställs vid omstart och delas inte mellan instanser. Övriga endpoints är
  okvoterade.
- **Migrationer kan inte rullas tillbaka.** Ofarligt mot en icke-persistent databas, men
  måste lösas innan någon miljö blir persistent.

Fyra frågor väntar dessutom på beställarens svar: valuta vid anbud i annan valuta än
budgeten, momshantering, om anbud ska kunna dras tillbaka, och om en signatur ska spara en
hash av villkoren som bevis. De står i §11 i [genomförandeplanen](docs/GENOMFORANDE.md).

---

## Teknik

Bun, Fastify och PostgreSQL, orkestrerat av Aspire med en TypeScript-AppHost. Podman kör
containrarna. Scheman skrivs en gång i TypeBox och driver både validering, TS-typer och
OpenAPI-dokumentationen — inget skrivs för hand två gånger.

Testerna är specifikationen: 263 fall med stabila ID:n som API:erna byggts fram genom.
Matrisen finns i §7.2 i [genomförandeplanen](docs/GENOMFORANDE.md).
