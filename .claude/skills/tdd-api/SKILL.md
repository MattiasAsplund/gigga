---
name: tdd-api
description: Röd-grön-cykeln för giggas REST-API:er, körd med bun test. Använd när användaren ber om ett nytt API, ändrat API-beteende, ett nytt eller ändrat testfall, eller säger något i stil med "lägg till F6.9", "ta bort L3.4", "det ska ge 422 istället". Håller testfallsmatrisen i docs/GENOMFORANDE.md §7.2 synkad med test/.
---

# TDD-cykeln för gigga-API:er

Testerna är specifikationen. Matrisen i `docs/GENOMFORANDE.md` §7.2 är det gemensamma
språket mellan dig och användaren — varje testfall har ett stabilt ID (`A1.2`, `F6.4`, `S7.8`).

**Allt körs med bun.** Aldrig `npm`, `npx`, `node`, `vitest` eller `jest` — varken i kommandon,
i `package.json`-skript eller i dokumentation.

## Ordningen — avvik inte

1. **Tolka önskemålet mot matrisen.**
   Är det ett nytt ID, en ändring av ett befintligt, eller en borttagning? Säg vilket ID du
   använder innan du skriver kod. Nya ID:n numreras löpande i sin grupp (`F6.9`, inte `F6.4b`).

2. **Skriv testet först och kör det.**
   ```bash
   cd services/api && bun test -t <ID>
   ```
   Visa att det är **rött av rätt skäl** — en fallerad assertion, inte ett typfel, en saknad
   fixtur eller en 500:a från en trasig helper. Är det rött av fel skäl: laga riggen först,
   sedan tillbaka hit.

3. **Implementera minsta möjliga kod för grönt.**
   Rör inga filer som testet inte kräver. Ingen "medan jag ändå är här"-städning.

4. **Kör hela sviten.**
   ```bash
   cd services/api && bun test
   ```
   Regressioner accepteras inte. En röd rad någon annanstans stoppar etappen.

5. **Uppdatera §7.2 i `docs/GENOMFORANDE.md` i samma svar.**
   Matrisen får aldrig divergera från `test/`. Ändrar du ett API-kontrakt måste även §6
   uppdateras — och det ska sägas uttryckligen, kontraktet får inte glida tyst.

6. **Rapportera kort:** ID, rött → grönt, vilka filer som ändrades. Ingen sammanfattning av
   vad TDD är.

## Förbjudet

- Ändra ett befintligt test för att få det grönt utan att användaren bett om det.
  Går ett gammalt test sönder av ny kod är det en regression tills användaren säger annat.
- Rapportera något som klart utan att ha kört sviten i det svaret.
- Lägga till API:er utanför §6 utan att först fråga.
- `test.skip` / `test.todo` som sätt att bli grön.
- Införa ett npm-paket som duplicerar något Bun redan har inbyggt (`bun test`,
  `Bun.SQL`, `Bun.password`, `Bun.$`).

## Konventioner i den här koden

- Tester importerar från `bun:test` (`test`, `expect`, `beforeAll`, `afterAll`) och anropar
  `app.inject(...)`, aldrig en riktig port.
- Varje testfil får en egen databas från `test/helpers/postgres.ts` (template-kopia).
  Ingen delad state mellan filer, inga `beforeEach`-truncates.
- Aktörer skapas med `await actor(app, 'buyer')` från `test/helpers/actors.ts` — de bär
  själva sitt `Authorization`-huvud.
- Ett schema per request/response i `src/schemas/` (TypeBox). Samma schema driver validering,
  TS-typer och Swagger — skriv aldrig OpenAPI för hand.
- Belopp är heltal i minorenhet (öre). Dyker en float upp i ett testfall är testet fel.
- **`Bun.SQL` returnerar `bigint` och `numeric` som `string`.** Konvertering sker i mapparna
  i `src/db/`, aldrig i en route eller ett test. Assertion mot ett belopp jämför med ett
  `number` — får du en `string` är det mapparen som saknas, inte testet som är fel.
- Fel är RFC 9457 Problem Details. Assertion mot felsvar kollar `status` **och** `type`.

## Statuskoder som används

| Situation | Kod |
|---|---|
| Skapat | 201 |
| Ok / idempotent upprepning | 200 |
| Saknad eller ogiltig token | 401 |
| Inloggad men fel part | 403 |
| Resursen finns inte (eller ska inte röjas) | 404 |
| Konflikt med befintligt tillstånd | 409 |
| Syntaktiskt giltig men semantiskt ogiltig indata | 422 |

Föreslår användaren en kod som bryter mot tabellen: gör som de säger, men nämn avvikelsen
i en mening.
