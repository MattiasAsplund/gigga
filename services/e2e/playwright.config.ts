import { defineConfig, devices } from '@playwright/test';

/**
 * Sviten körs i Playwrights egen image via AppHosten, så webbläsarversionen följer
 * imagen och inte värdmaskinen. Webben når containern över en tunnel på
 * containerbryggan, vars adress kommer in som BASE_URL.
 */
const target = new URL(process.env.BASE_URL ?? 'http://localhost:5173');

/*
 * Webbläsaren surfar på `localhost` och löser upp det till tunnelns värdnamn.
 *
 * Det är inte kosmetika, och inte heller ett sätt att slippa skriva en adress. Två saker
 * hänger på det:
 *
 * 1. **Säker kontext.** Inloggningen är authorization code + PKCE, och kodutmaningen
 *    räknas ut med `crypto.subtle` — som bara finns på https eller localhost. På
 *    `http://aspire.dev.internal:5173` saknas den, och inloggningen går inte att starta:
 *    *"Crypto.subtle is available only in secure contexts (HTTPS)."* Chromium räknar
 *    localhost som betrott, oavsett vad namnet råkar peka på.
 *
 * 2. **Issuern.** Keycloak bygger sin issuer ur Host-huvudet. Surfar containern på
 *    tunnelns namn blir tokenens `iss` det namnet, medan API:et väntar sig webbens
 *    adress (PUBLIC_BASE_URL) — och avvisar varenda token. Med localhost i webbläsaren
 *    ser containern exakt det värden ser.
 */
const hostRule = `MAP localhost ${target.hostname}`;

export default defineConfig({
  testDir: './tests',
  // Bildspelet (slides/) skrivs om från grunden vid varje körning — annars hade
  // bilderna från förra körningen legat kvar och numreringen börjat mitt i.
  globalSetup: './tests/slides.ts',
  fullyParallel: false,
  workers: 1,
  // Flödet är en kedja: varje steg bygger på föregående, så ett omtag mitt i vore
  // missvisande snarare än hjälpsamt.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Testartefakterna delar mapp i Playwright — video, spår och skärmbilder hamnar alla
  // här. Mappen ligger under bindmonteringen, så inspelningarna når värden direkt.
  outputDir: './recordings',
  use: {
    baseURL: `${target.protocol}//localhost:${target.port || '5173'}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Alltid på: flödet är en kedja där ett fel långt in är lättare att förstå med
    // stegen före på film. Retries är 0, så det finns inget omtag att spara till.
    video: 'on',
    locale: 'sv-SE',
  },
  projects: [
    {
      name: 'chromium',
      // Vyporten sätts efter spridningen, inte i `use` ovanför: `devices` bär en egen
      // viewport, och projektets `use` vinner över den yttre.
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 764 },
        launchOptions: { args: [`--host-resolver-rules=${hostRule}`] },
      },
    },
  ],
});
