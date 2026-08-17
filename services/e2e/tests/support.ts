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
 * Bekräftelselänken ur mailet, som väg att navigera till — samma väg en användare
 * klickar. Bara sökvägen används: mailet bär värdens adress, medan containern når
 * webben under ett annat namn, och det är Playwrights baseURL som vet vilket.
 */
export async function verificationPath(address: string): Promise<string> {
  const text = await latestMail(address);
  const link = /https?:\/\/\S*\/verify\S*/.exec(text)?.[0]?.trim();
  if (!link) throw new Error(`Ingen bekräftelselänk i mailet till ${address}:\n${text}`);

  const url = new URL(link);
  if (!url.searchParams.get('token')) throw new Error(`Länken saknar token: ${link}`);
  return url.pathname + url.search;
}

/** Steg 1–2: skapa konto och bekräfta adressen genom gränssnittet. */
export async function registerAndVerify(page: Page, who: Person): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('displayName').fill(who.displayName);
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('registered')).toBeVisible();

  await page.goto(await verificationPath(who.email));
  await expect(page.getByTestId('verified')).toContainText(who.email);
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
