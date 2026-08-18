import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** Unik per körning: databasen lever kvar så länge Aspire kör. */
export const RUN = Date.now().toString(36);

export const PASSWORD = 'ett-langt-losenord';

export interface Person {
  email: string;
  displayName: string;
}

export const person = (name: string): Person => ({
  email: `${name}-${RUN}@example.se`,
  displayName: name,
});

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/** Väntar in mailet till adressen och returnerar dess textinnehåll. */
export async function latestMail(address: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()) as {
      messages: MailpitMessage[];
    };
    const message = list.messages.find(
      (candidate) => candidate.To[0]?.Address.toLowerCase() === address.toLowerCase(),
    );

    if (message) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
        Text: string;
      };
      return full.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Inget mail till ${address} inom rimlig tid`);
}

/**
 * Vägen från brevlådan tillbaka till gigga, gången genom mailpits gränssnitt i stället
 * för dess API: det är så en användare gör, och bildspelet får med både listan och
 * brevet på köpet.
 *
 * Två saker görs åt länken innan den klickas, och båda är små:
 *
 * - **Värden byts.** Mailet bär den adress API:et känner till, och API:et är en process
 *   på värdmaskinen — medan webbläsaren sitter i en container och når webben under ett
 *   annat namn. Bara värddelen skrivs om; token kommer ur brevet som det står där.
 * - **`target="_top"` sätts.** Länken ligger i mailpits förhandsgranskning, som är en
 *   iframe, och skulle annars öppna gigga antingen i en egen flik eller inuti brevet.
 */
export async function verifyFromMailbox(page: Page, who: Person): Promise<void> {
  // Adressen webbläsaren når gigga på, hämtad ur sidan den redan står på.
  const gigga = new URL(page.url()).origin;

  // Att brevet kommit fram vet API:et först. Mailpits lista fyller på sig själv över
  // websocket, men att veta att mailet finns innan brevlådan öppnas är enklare att lita
  // på än att vänta in en rad som ska dyka upp.
  await latestMail(who.email);

  await page.goto(MAILPIT);
  const brev = page.locator('a[href^="/view/"]').first();
  // Översta brevet ska vara det som just skickades. Står någon annans adress där är det
  // fel brev som öppnas, och det är värt att stanna på i stället för att klicka vidare.
  await expect(brev).toContainText(who.email);
  await brev.click();

  const länk = page.frameLocator('#preview-html').locator('a[href*="/verify"]');
  await expect(länk).toBeVisible();
  await länk.evaluate((element, origin) => {
    const anchor = element as HTMLAnchorElement;
    const url = new URL(anchor.href);
    anchor.href = origin + url.pathname + url.search;
    anchor.target = '_top';
  }, gigga);
  await länk.click();
}

/** Steg 1–2: skapa konto och bekräfta adressen genom gränssnittet. */
export async function registerAndVerify(page: Page, who: Person): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('displayName').fill(who.displayName);
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('registered')).toBeVisible();

  await verifyFromMailbox(page, who);
  await expect(page.getByTestId('verified')).toContainText(who.email);
}

/** Bifogar ett dokument till anbudet som sidan redan står på. */
export async function attach(
  page: Page,
  name: string,
  mimeType: string,
  content: string,
): Promise<void> {
  await page.getByTestId('file').setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
  await page.getByTestId('upload').click();
}

/** Steg 3: logga in och landa i katalogen. */
export async function signIn(page: Page, who: Person): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('current-user')).toHaveText(who.email);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
}
