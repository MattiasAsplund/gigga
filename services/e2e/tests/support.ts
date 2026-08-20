import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** Unik per körning: databasen lever kvar så länge Aspire kör. */
export const RUN = Date.now().toString(36);

export const PASSWORD = 'ett-langt-losenord';
/** Lösenordet efter en återställning. Minst tolv tecken, som API:et kräver. */
export const NEW_PASSWORD = 'ett-annat-langt-losenord';

export interface Person {
  email: string;
  displayName: string;
  /**
   * Följer med kontot i stället för att ligga som en konstant i inloggningen. Efter en
   * återställning är det ett annat, och signIn ska använda rätt utan att varje anropare
   * håller reda på vilket.
   */
  password: string;
}

export const person = (name: string): Person => ({
  email: `${name}-${RUN}@example.se`,
  displayName: name,
  password: PASSWORD,
});

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/** Väntar in mailet till adressen och returnerar det. */
export async function latestMail(address: string): Promise<{ Text: string; HTML: string }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()) as {
      messages: MailpitMessage[];
    };
    const message = list.messages.find(
      (candidate) => candidate.To[0]?.Address.toLowerCase() === address.toLowerCase(),
    );

    if (message) {
      return (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
        Text: string;
        HTML: string;
      };
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
 * Länken klickas som den står, men klicket fångas och skickas vidare till den här
 * fliken på en adress webbläsaren faktiskt når. Varför båda delarna behövs står vid
 * greppet längre ner.
 */
async function clickMailLink(page: Page, who: Person, path: string): Promise<void> {
  // Adressen webbläsaren når gigga på, hämtad ur sidan den redan står på.
  const gigga = new URL(page.url()).origin;

  // Att brevet kommit fram vet API:et först. Mailpits lista fyller på sig själv över
  // websocket, men att veta att mailet finns innan brevlådan öppnas är enklare att lita
  // på än att vänta in en rad som ska dyka upp.
  const brevet = await latestMail(who.email);

  await page.goto(MAILPIT);
  const brev = page.locator('a[href^="/view/"]').first();
  // Översta brevet ska vara det som just skickades. Står någon annans adress där är det
  // fel brev som öppnas, och det är värt att stanna på i stället för att klicka vidare.
  await expect(brev).toContainText(who.email);
  await brev.click();

  // Bekräftelsemailet har en html-del och visas i mailpits förhandsgranskning, en iframe.
  // Återställningsmailet är ren text och hamnar i sidan själv. Vilket av dem det är står
  // i brevet och inte i sidan — att fråga sidan vore en kapplöpning med mailpits egen
  // rendering.
  const val = `a[href*="${path}"]`;
  const länk = brevet.HTML
    ? page.frameLocator('#preview-html').locator(val)
    : page.locator(`.tab-content ${val}`);

  // Adressen brevet bär. Att den står i sidan är kvittot på att det är det här brevet
  // som visas, och inte det förra som ännu inte hunnit bytas ut.
  const iBrevet = new RegExp(`https?://\\S*${path}\\S*`).exec(brevet.Text)?.[0];
  if (!iBrevet) throw new Error(`Ingen ${path}-länk i brevet till ${who.email}:\n${brevet.Text}`);
  await expect(länk).toHaveAttribute('href', iBrevet);

  // Klicket fångas där det sker i stället för att länken skrivs om i förväg: mailpit
  // sätter target="_blank" på länkarna i förhandsgranskningen, och sätter tillbaka det
  // ett par hundra millisekunder efter att den laddat. Ett omskrivet attribut hinner
  // alltså skrivas över, och klicket öppnar gigga i en flik som testet inte håller i.
  //
  // Adressen byts på vägen. Brevet bär den adress API:et känner till, och API:et är en
  // process på värdmaskinen — medan webbläsaren sitter i en container och når webben
  // under ett annat namn. Bara värddelen byts; token kommer ur brevet som det står där.
  const mål = new URL(iBrevet);
  await länk.evaluate((element, href) => {
    element.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        window.top!.location.href = href;
      },
      { capture: true },
    );
  }, gigga + mål.pathname + mål.search);
  await länk.click();
}

/** Bekräftelselänken ur mailet, klickad i brevlådan. */
export async function verifyFromMailbox(page: Page, who: Person): Promise<void> {
  await clickMailLink(page, who, '/verify');
}

/**
 * Återställningslänken ur mailet, klickad i brevlådan, och det nya lösenordet satt på
 * sidan den leder till. Lösenordet skrivs in på personen: nästa signIn ska använda det
 * utan att veta att en återställning hänt.
 */
export async function resetFromMailbox(page: Page, who: Person, password: string): Promise<void> {
  await clickMailLink(page, who, '/reset-password');
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
  who.password = password;
}

/** Steg 1–2: skapa konto och bekräfta adressen genom gränssnittet. */
export async function registerAndVerify(page: Page, who: Person): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('displayName').fill(who.displayName);
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(who.password);
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
  await page.getByTestId('password').fill(who.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('current-user')).toHaveText(who.email);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
}

/**
 * Publicerar en kravspec via API:et, med köparens egen token.
 *
 * Huvudflödet går klickvägen genom intervjun (`runInterview`). Den här genvägen finns
 * kvar för de kedjor som handlar om något annat — att gå igenom trettio frågor i
 * gränssnittet för att kunna dra tillbaka ett anbud är att betala för fel sak.
 */
export async function publishSpec(
  page: Page,
  requestId: string,
  gigTypes: string[] = ['integration'],
): Promise<void> {
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('fastgig.account');
    return raw ? (JSON.parse(raw) as { token: string }).token : null;
  });
  if (!token) throw new Error('Ingen inloggad användare att publicera kravspecen som.');

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `/api/v1/requests/${requestId}/spec`;

  const opened = await page.request.post(base, { headers, data: { gigTypes } });
  if (!opened.ok()) throw new Error(`öppna kravspec: ${opened.status()} ${await opened.text()}`);

  interface Spec {
    questions: {
      key: string;
      kind: string;
      visible: boolean;
      answered: boolean;
      config: Record<string, unknown>;
      options: { key: string }[];
    }[];
    criteria: { id: string; kind: string }[];
    completeness: { answeredRequired: number; requiredQuestions: number };
  }

  const value = (question: Spec['questions'][number]): unknown => {
    switch (question.kind) {
      case 'bool':
        return true;
      case 'integer':
        return typeof question.config.minimum === 'number' ? question.config.minimum : 1;
      case 'date':
        return '2026-09-01';
      case 'choice':
        return question.options[0]?.key;
      case 'multichoice':
        return [question.options[0]?.key];
      default:
        return 'Besvarat i e2e-flödet.';
    }
  };

  /*
   * Rundor, inte ett svep: ett svar kan göra en följdfråga synlig — svarar man "köa" på
   * vad som ska hända vid fel dyker frågan om vem som larmas upp. Det är hela poängen med
   * villkoren, och en intervju som svarar på allt måste därför läsa om läget efter varje
   * omgång tills inget nytt dykt upp.
   */
  let spec = (await opened.json()) as Spec;
  for (let round = 0; round < 5; round += 1) {
    const unanswered = spec.questions.filter((q) => q.visible && !q.answered);
    if (unanswered.length === 0) break;

    const answers = await page.request.put(`${base}/answers`, {
      headers,
      data: {
        answers: unanswered.map((question) => ({
          questionKey: question.key,
          value: value(question),
        })),
      },
    });
    if (!answers.ok()) throw new Error(`svara: ${answers.status()} ${await answers.text()}`);

    const reread = await page.request.get(base, { headers });
    if (!reread.ok()) throw new Error(`läs kravspec: ${reread.status()} ${await reread.text()}`);
    spec = (await reread.json()) as Spec;
  }

  for (const criterion of spec.criteria.filter((row) => row.kind === 'criterion')) {
    const approved = await page.request.post(`${base}/criteria/${criterion.id}/approval`, {
      headers,
    });
    if (!approved.ok()) throw new Error(`godkänn: ${approved.status()} ${await approved.text()}`);
  }

  const published = await page.request.post(`${base}/publication`, { headers });
  if (!published.ok()) throw new Error(`publicera: ${published.status()} ${await published.text()}`);
}

/**
 * Intervjun genom gränssnittet: välj typ, besvara frågorna, godkänn kriterierna,
 * publicera.
 *
 * Inget här känner till en enskild fråga. Fälten fylls efter `data-kind` — samma sju
 * former webben renderar — och svaren sparas i rundor, eftersom ett svar kan öppna en
 * följdfråga. Det är precis vad en kund gör, och därför tål steget att katalogen växer.
 */
export async function runInterview(page: Page, typeName: string): Promise<void> {
  await page.getByTestId('go-spec').click();

  await page.getByTestId('gig-type').filter({ hasText: typeName }).locator('input').check();
  await page.getByTestId('open-spec').click();
  await expect(page.getByTestId('completeness')).toBeVisible();

  for (let round = 0; round < 5; round += 1) {
    const filled = await fillVisibleQuestions(page);
    if (filled.length === 0) break;

    await page.getByTestId('save-answers').click();

    /*
     * Väntan hänger på tillståndet, inte på ett svar från nätet: en klick som råkar
     * landa medan React ritar om skickar ingenting alls, och då väntar man för evigt på
     * ett anrop som aldrig gjordes. Att frågan blivit besvarad syns i DOM:en, och
     * assertionen provar om tills den gör det.
     */
    await expect(question(page, filled[0]!)).toHaveAttribute('data-answered', 'true');
  }

  // Kunden godkänner varje rad aktivt — det är det som håller kravspecen hos kunden.
  for (const id of await page.getByTestId('approve').evaluateAll((buttons) =>
    buttons.map((button) => button.closest('[data-testid="criterion"]')?.getAttribute('data-id') ?? ''),
  )) {
    const row = page.locator(`[data-testid="criterion"][data-id="${id}"]`);
    await row.getByTestId('approve').click();
    await expect(row).toHaveAttribute('data-approved', 'true');
  }

  await expect(page.getByTestId('publish-spec')).toBeEnabled();
  await page.getByTestId('publish-spec').click();
  await expect(page.getByTestId('spec-head')).toContainText('published');
}

const question = (page: Page, key: string) =>
  page.locator(`[data-testid="question"][data-key="${key}"]`);

/** Fyller de synliga frågor som ännu är tomma, och returnerar vilka som rördes. */
async function fillVisibleQuestions(page: Page): Promise<string[]> {
  const touched: string[] = [];

  for (const field of await page.getByTestId('question').all()) {
    const kind = await field.getAttribute('data-kind');
    const key = await field.getAttribute('data-key');
    if (!key) continue;
    const control = field.getByTestId(`answer-${key}`);

    if (kind === 'multichoice') {
      const boxes = control.locator('input[type="checkbox"]');
      if ((await boxes.locator(':checked').count()) > 0) continue;
      await boxes.first().check();
      touched.push(key);
      continue;
    }

    if ((await control.inputValue()) !== '') continue;

    switch (kind) {
      case 'bool':
      case 'choice':
        await control.selectOption({ index: 1 });
        break;
      case 'integer':
        await control.fill((await control.getAttribute('min')) ?? '1');
        break;
      case 'date':
        await control.fill('2026-09-01');
        break;
      default:
        await control.fill(`Besvarat i e2e-flödet: ${key}.`);
    }
    touched.push(key);
  }

  return touched;
}
