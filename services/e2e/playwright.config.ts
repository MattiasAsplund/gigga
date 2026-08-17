import { defineConfig, devices } from '@playwright/test';

/**
 * Sviten körs i Playwrights egen image via AppHosten, så webbläsarversionen följer
 * imagen och inte värdmaskinen. Adresserna kommer in som miljövariabler eftersom
 * containern når allt över `--network=host`.
 */
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
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
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
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 764 } },
    },
  ],
});
