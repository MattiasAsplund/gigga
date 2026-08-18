import { readFile } from 'node:fs/promises';
// Inte från '@playwright/test' rakt av: den här `test` bär `page`-fixturen som fotar
// varje navigering till bildspelet i slides/. Se tests/slides.ts.
import { test, expect } from './slides.ts';
import { attach, PASSWORD, person, registerAndVerify, signIn, signOut } from './support.ts';

/**
 * README:ns nio steg, körda genom gränssnittet.
 *
 * En sammanhängande kedja i en fil och en ordning: varje steg bygger på föregående, och
 * ett isolerat "signera avtal"-test utan en förfrågan att signera bevisar ingenting.
 * Delstegen är egna `test.step` så det syns var det brister när något brister.
 */
test.describe.configure({ mode: 'serial' });

const kim = person('kim');
const robin = person('robin');
const lo = person('lo');

let requestId = '';
let bidId = '';

test('hela flödet från förfrågan till signerat avtal', async ({ page }) => {
  test.slow();

  await test.step('1–2. Konton skapas och adresserna bekräftas', async () => {
    for (const who of [kim, robin, lo]) {
      await registerAndVerify(page, who);
    }
  });

  await test.step('3. Obekräftat konto släpps inte in, bekräftat gör det', async () => {
    // Kontrollen är värd sitt steg: hela verifieringen vore teater utan den.
    const okänd = person('okand');
    await page.goto('/login');
    await page.getByTestId('email').fill(okänd.email);
    await page.getByTestId('password').fill(PASSWORD);
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('notice')).toBeVisible();

    await signIn(page, kim);
  });

  await test.step('4. Kim publicerar en förfrågan', async () => {
    await page.goto('/requests/new');
    await page.getByTestId('title').fill('Bygg en Fortnox-integration');
    await page
      .getByTestId('description')
      .fill('Synk av fakturor varje timme, allt på distans.');
    await page.getByTestId('compensationPref').selectOption('any');
    await page.getByTestId('budget').fill('50000');
    await page.getByTestId('deadlineAt').fill('2026-12-01');
    await page.getByTestId('submit').click();

    await expect(page.getByTestId('request-title')).toHaveText('Bygg en Fortnox-integration');
    requestId = new URL(page.url()).pathname.split('/').pop()!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  await test.step('4b. Kim kan inte bjuda på sin egen förfrågan', async () => {
    await page.goto('/requests');
    const own = page.getByTestId('catalog-item').filter({ hasText: 'Fortnox' });
    await expect(own.getByTestId('cannot-bid')).toContainText('egen förfrågan');
  });

  await test.step('5. Robin hittar uppdraget i katalogen', async () => {
    await signOut(page);
    await signIn(page, robin);

    await page.goto('/requests');
    const item = page.getByTestId('catalog-item').filter({ hasText: 'Fortnox' });
    await expect(item).toBeVisible();
    await expect(item.getByTestId('bid-count')).toContainText('0');
    await item.getByTestId('go-bid').click();
  });

  await test.step('6. Robin lämnar ett timanbud', async () => {
    await page.getByTestId('plan').fill('Kartläggning, bygge, överlämning.');
    await page.getByTestId('compensation-type').selectOption('hourly');
    await page.getByTestId('rate').fill('950');
    await page.getByTestId('hours').fill('40');
    await page.getByTestId('submit-bid').click();

    const bid = page.getByTestId('bid').first();
    await expect(bid).toBeVisible();
    // 950 kr × 40 tim = 38 000 kr, uträknat av API:et.
    await expect(bid.getByTestId('bid-total')).toContainText('38');
    bidId = (await bid.getAttribute('data-id'))!;
  });

  await test.step('7. Robin bifogar ett dokument, byter namn och laddar upp ett till', async () => {
    await page.goto(`/bids/${bidId}`);

    await page.getByTestId('file').setInputFiles({
      name: 'genomforandeplan.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Genomförandeplan\n\nSteg ett, steg två.'),
    });
    await page.getByTestId('upload').click();
    await expect(page.getByTestId('attachment')).toHaveCount(1);

    // Namnbytet ska inte röra innehållet — filen finns kvar under sitt nya namn.
    page.once('dialog', (dialog) => void dialog.accept('plan.md'));
    await page.getByTestId('rename').first().click();
    await expect(page.getByTestId('attachment').first()).toHaveAttribute(
      'data-filename',
      'plan.md',
    );

    await page.getByTestId('file').setInputFiles({
      name: 'offert.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nOffert'),
    });
    await page.getByTestId('upload').click();
    await expect(page.getByTestId('attachment')).toHaveCount(2);
  });

  await test.step('7b. Fel filtyp avvisas', async () => {
    await page.getByTestId('file').setInputFiles({
      name: 'trojan.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('MZ inte en pdf'),
    });
    await page.getByTestId('upload').click();
    await expect(page.getByTestId('notice')).toContainText('Filtypen');
    await expect(page.getByTestId('attachment')).toHaveCount(2);
  });

  await test.step('8. Kim läser anbudet och hämtar dokumenten som ZIP', async () => {
    await signOut(page);
    await signIn(page, kim);

    await page.goto('/me/requests');
    const own = page.getByTestId('request').filter({ hasText: 'Fortnox' });
    await expect(own.getByTestId('request-bid-count')).toContainText('1');

    // Klickvägen, inte page.goto med ett id testet råkar bära med sig: att köparen
    // *kan ta sig* till anbudet är hela poängen med steget.
    await expect(own.getByTestId('request-bid')).toHaveCount(1);
    await own.getByTestId('inspect-bid').first().click();
    await expect(page).toHaveURL(new RegExp(`/bids/${bidId}$`));

    // Köparen ska möta anbudets innehåll, inte bara dess id.
    await expect(page.getByTestId('bid-seller')).toContainText(robin.displayName);
    await expect(page.getByTestId('bid-plan')).toContainText('Kartläggning');
    await expect(page.getByTestId('bid-total')).toContainText('38');

    await expect(page.getByTestId('attachment')).toHaveCount(2);

    const download = page.waitForEvent('download');
    await page.getByTestId('download-archive').click();
    const zip = await download;
    expect(zip.suggestedFilename()).toContain('.zip');

    // Att filen *heter* .zip säger inget. Magin PK\x03\x04 i början visar att det är ett
    // riktigt arkiv som kom hela vägen ut. Innehållet i arkivet granskar B.9 i API-sviten.
    const bytes = await readFile((await zip.path())!);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  await test.step('8b. Kim ger Lo läsrätt, och tar tillbaka den', async () => {
    await page.goto(`/requests/${requestId}`);
    await page.getByTestId('grant-email').fill(lo.email);
    await page.getByTestId('grant-submit').click();
    await expect(page.getByTestId('permission')).toContainText(lo.email);

    await signOut(page);
    await signIn(page, lo);
    await page.goto(`/requests/${requestId}`);
    await expect(page.getByTestId('request-title')).toHaveText('Bygg en Fortnox-integration');
    await expect(page.getByTestId('bid')).toHaveCount(1);

    await signOut(page);
    await signIn(page, kim);
    await page.goto(`/requests/${requestId}`);
    await page.getByTestId('revoke').click();
    await expect(page.getByTestId('permission')).toHaveCount(0);

    await signOut(page);
    await signIn(page, lo);
    await page.goto(`/requests/${requestId}`);
    // Läsrätten är borta, men förfrågan går fortfarande att läsa — varje säljare måste
    // kunna öppna den för att kunna lämna anbud. Det är anbuden som stängs.
    await expect(page.getByTestId('request-title')).toHaveText('Bygg en Fortnox-integration');
    await expect(page.getByTestId('bid')).toHaveCount(0);
  });

  await test.step('9. Båda signerar och avtalet blir bindande', async () => {
    await signOut(page);
    await signIn(page, kim);
    await page.goto(`/bids/${bidId}`);
    await expect(page.getByTestId('no-contract')).toBeVisible();

    await page.getByTestId('sign').click();
    await expect(page.getByTestId('contract')).toHaveAttribute(
      'data-status',
      'pending_signatures',
    );
    await expect(page.getByTestId('signature-buyer')).toHaveAttribute('data-signed', 'true');
    await expect(page.getByTestId('signature-seller')).toHaveAttribute('data-signed', 'false');

    // Signaturen måste överleva att sidan laddas om. Avtalsläget låg tidigare bara i
    // sidans eget minne från signeringssvaret, så Kim möttes av "inget avtal än" igen.
    await page.reload();
    await expect(page.getByTestId('contract')).toHaveAttribute(
      'data-status',
      'pending_signatures',
    );
    await expect(page.getByTestId('signature-buyer')).toHaveAttribute('data-signed', 'true');
    await expect(page.getByTestId('no-contract')).toHaveCount(0);

    // Den som signerat erbjuds inte att signera igen.
    await expect(page.getByTestId('sign')).toHaveCount(0);
    await expect(page.getByTestId('already-signed')).toContainText('köpare');

    // Signaturen ska bära sin tidpunkt, inte bara en flagga: "Signerat" tillsammans med
    // "Ingen signatur än" i samma ruta är två påståenden som motsäger varandra.
    const köparensSignatur = page.getByTestId('signature-buyer');
    await expect(köparensSignatur).toContainText('Signerat');
    await expect(köparensSignatur).not.toContainText('Ingen signatur än');

    await signOut(page);
    await signIn(page, robin);
    await page.goto(`/bids/${bidId}`);
    // Säljaren har inte signerat än, så för hen står knappen kvar.
    await expect(page.getByTestId('sign')).toBeVisible();
    await page.getByTestId('sign').click();

    await expect(page.getByTestId('contract')).toHaveAttribute('data-status', 'active');
    await expect(page.getByTestId('signature-seller')).toHaveAttribute('data-signed', 'true');

    // Och när båda signerat är knappen borta för säljaren också, även efter omladdning.
    await page.reload();
    await expect(page.getByTestId('sign')).toHaveCount(0);
    await expect(page.getByTestId('already-signed')).toContainText('bindande');

    // Säljarens vy av avtalet: båda signaturerna med tidpunkt, ingen "Ingen signatur än".
    await expect(page.getByTestId('signature-seller')).toContainText('Signerat');
    await expect(page.getByTestId('contract')).not.toContainText('Ingen signatur än');
  });

  await test.step('9b. Förfrågan är tilldelad och anbudet antaget', async () => {
    await page.goto('/me/bids');
    const mine = page.getByTestId('my-bid').filter({ hasText: 'Fortnox' });
    await expect(mine.getByTestId('contract-state')).toContainText('active');
    await expect(mine.locator('[data-status="accepted"]')).toBeVisible();

    await signOut(page);
    await signIn(page, kim);
    await page.goto('/me/requests');
    await expect(
      page.getByTestId('request').filter({ hasText: 'Fortnox' }).locator('[data-status="awarded"]'),
    ).toBeVisible();
  });

  await test.step('9c. Ett tilldelat uppdrag ligger inte kvar i katalogen', async () => {
    await page.goto('/requests');
    await expect(page.getByTestId('catalog-item').filter({ hasText: 'Fortnox' })).toHaveCount(0);
  });
});

test('säljaren kan ändra och dra tillbaka sitt anbud', async ({ page }) => {
  test.slow();

  // Egen kedja med en egen förfrågan: huvudflödet slutar i ett signerat avtal, och ett
  // tillbakadraget anbud mitt i det vore inte samma berättelse. Konton behöver den
  // däremot inte egna — rollen sitter i förfrågan och inte i kontot, så kim är köpare
  // och robin säljare här också.
  await signIn(page, kim);
  await page.goto('/requests/new');
  await page.getByTestId('title').fill('Migrera en rapportdatabas');
  await page.getByTestId('description').fill('Allt på distans, i etapper.');
  await page.getByTestId('compensationPref').selectOption('any');
  await page.getByTestId('deadlineAt').fill('2026-12-01');
  await page.getByTestId('submit').click();

  // Vänta in navigeringen innan URL:en läses av — annars är id:t fortfarande "new".
  await expect(page.getByTestId('request-title')).toHaveText('Migrera en rapportdatabas');
  const ändringsRequestId = new URL(page.url()).pathname.split('/').pop()!;
  expect(ändringsRequestId).toMatch(/^[0-9a-f-]{36}$/);

  await signOut(page);
  await signIn(page, robin);
  await page.goto(`/requests/${ändringsRequestId}`);
  await page.getByTestId('plan').fill('Första utkastet till plan.');
  await page.getByTestId('compensation-type').selectOption('fixed');
  await page.getByTestId('amount').fill('45000');
  await page.getByTestId('submit-bid').click();
  const ändringsBidId = (await page.getByTestId('bid').first().getAttribute('data-id'))!;

  await test.step('Anbudet får ett dokument', async () => {
    await page.goto(`/bids/${ändringsBidId}`);
    await attach(page, 'etappplan.md', 'text/markdown', '# Etappplan\n\nTvå etapper.');
    await expect(page.getByTestId('attachment')).toHaveCount(1);
  });

  await test.step('Anbudet skrivs om från fast pris till timpris', async () => {
    await page.getByTestId('change-plan').fill('Omarbetad plan: två etapper.');
    await page.getByTestId('change-compensation-type').selectOption('hourly');
    await page.getByTestId('change-rate').fill('950');
    await page.getByTestId('change-hours').fill('40');
    await page.getByTestId('save-bid').click();

    // 950 kr × 40 tim = 38 000 kr, uträknat av API:et.
    await expect(page.getByTestId('bid-total')).toContainText('38');
    // En ändring rör anbudets innehåll, inte dess dokument.
    await expect(page.getByTestId('attachment')).toHaveCount(1);
  });

  await test.step('Anbudet dras tillbaka och går inte längre att ändra', async () => {
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('withdraw-bid').click();

    await expect(page.getByTestId('bid-locked')).toContainText('withdrawn');
    await expect(page.getByTestId('change-bid-form')).toHaveCount(0);
    // Anbudsraden lever kvar med ny status, så dokumenten följer med den.
    await expect(page.getByTestId('attachment')).toHaveCount(1);
  });

  await test.step('Efter tillbakadragandet går det att lämna ett nytt anbud, med egna dokument', async () => {
    await page.goto(`/requests/${ändringsRequestId}`);
    await page.getByTestId('plan').fill('Nytt försök med skarpare pris.');
    await page.getByTestId('compensation-type').selectOption('fixed');
    await page.getByTestId('amount').fill('39000');
    await page.getByTestId('submit-bid').click();

    // Vänta på att listan blivit två. Det tillbakadragna anbudet ligger redan där, så
    // "syns ett anbud" hade varit sant redan före omladdningen — och gett gammalt id.
    await expect(page.getByTestId('bid')).toHaveCount(2);
    const nyttBidId = (await page.getByTestId('bid').first().getAttribute('data-id'))!;
    expect(nyttBidId).not.toBe(ändringsBidId);

    // Det nya anbudet börjar tomt — dokumenten satt på det tillbakadragna.
    await page.goto(`/bids/${nyttBidId}`);
    await expect(page.getByTestId('attachment')).toHaveCount(0);

    await attach(page, 'offert.pdf', 'application/pdf', '%PDF-1.7\nSkarpare offert');
    await expect(page.getByTestId('attachment')).toHaveCount(1);
  });
});

test('en bekräftelselänk som inte gäller ger besked, inte ett rått JSON-svar', async ({
  page,
}) => {
  await page.goto('/verify?token=00000000-0000-4000-8000-000000000000');

  await expect(page.getByTestId('notice')).toContainText('gäller inte');
  await expect(page.getByTestId('verified')).toHaveCount(0);
});
