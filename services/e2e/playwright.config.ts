import { defineConfig, devices } from '@playwright/test';

/**
 * Sviten körs i Playwrights egen image via AppHosten, så webbläsarversionen följer
 * imagen och inte värdmaskinen. Adresserna kommer in som miljövariabler eftersom
 * containern når allt över `--network=host`.
 */
export default defineConfig({
  testDir: './tests',
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
