import { readFile } from 'node:fs/promises';
// Inte från '@playwright/test' rakt av: den här `test` bär `page`-fixturen som fotar
// varje navigering till bildspelet i slides/. Se tests/slides.ts.
import { test, expect } from './slides.ts';
import {
  attach,
  NEW_PASSWORD,
  person,
  publishSpec,
  acceptInvitation,
  inviteAndOnboard,
  unaffiliatedAccount,
  attemptSignIn,
  ensureSignedOut,
  submit,
  runInterview,
  resetFromMailbox,
  signIn,
  signOut,
} from './support.ts';

/**
 * README:ns nio steg, körda genom gränssnittet.
 *
 * En sammanhängande kedja i en fil och en ordning: varje steg bygger på föregående, och
 * ett isolerat "signera avtal"-test utan en förfrågan att signera bevisar ingenting.
 * Delstegen är egna `test.step` så det syns var det brister när något brister.
 */
test.describe.configure({ mode: 'serial' });

// Kim och Lo är kollegor på Nordvind, Robin säljare på Sydlig. Att Lo delar företag med
// Kim är inte kosmetik: det är vad som gör att hen ser förfrågan utan att få läsrätt
// tilldelad, och vad som hindrar hen från att lämna anbud på den.
const kim = person('kim', 'nordvind');
const lo = person('lo', 'nordvind');
const robin = person('robin', 'sydlig');
const mio = person('mio', 'granskaren');

let requestId = '';
let bidId = '';

test('hela flödet från förfrågan till signerat avtal', async ({ page }) => {
  // Kedjan är lång i sig, och intervjun lägger på ett trettiotal fält som fylls ett i
  // taget genom gränssnittet. test.slow() (90 s) räcker inte till för båda.
  //
  // Onboardingen kostar numera mest: fyra personer som var och en bjuds in, tar emot,
  // bekräftar sin adress och loggar in en första gång — fyra fulla OIDC-rundor och två
  // brev per person.
  test.setTimeout(360_000);

  await test.step('1–2. Kontona bjuds in, tar emot och bekräftar sina adresser', async () => {
    // Ingen registrerar sig själv — realmet har `registrationAllowed: false`. Den som
    // ska in i ett företag bjuds in av någon som redan är där, och medlemskapet finns
    // därmed innan adressen ens bekräftats.
    for (const who of [kim, robin, lo, mio]) {
      await inviteAndOnboard(page, who);
    }
  });

  await test.step('3. Obekräftad adress släpps inte in, bekräftad gör det', async () => {
    // Kontrollen är värd sitt steg: hela verifieringen vore teater utan den. Kontot
    // skapas men brevet lämnas oöppnat, och Keycloak stannar på sin egen sida med ett
    // besked i stället för att släppa vidare till gigga.
    const obekräftad = person('obekraftad');
    await acceptInvitation(page, obekräftad);
    await expect(page.getByText(/verify|bekräfta/i).first()).toBeVisible();

    // Och ett nytt försök att logga in leder tillbaka till samma krav, inte in.
    await ensureSignedOut(page);
    await attemptSignIn(page, obekräftad);
    await expect(page.getByTestId('current-user')).toHaveCount(0);

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

  await test.step('4a. Kim fastställer kravspecen — utan den går inget anbud att lämna', async () => {
    // Hela intervjun genom gränssnittet: typval, frågor, kriterier, publicering.
    await runInterview(page, 'Integration mellan två system');

    // Och tillbaka på förfrågan syns den publicerade lydelsen.
    await page.goto(`/requests/${requestId}`);
    await expect(page.getByTestId('spec-panel')).toContainText('Acceptanskriterier');
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

  await test.step('7c. Kim har glömt sitt lösenord och sätter ett nytt', async () => {
    await signOut(page);

    // Keycloaks egen glömt-lösenord-sida. Länken sitter vid lösenordsfältet, inte på
    // första sidan: inloggningen är identitetsförd, så adressen anges först.
    await ensureSignedOut(page);
    await page.goto('/');
    await page.getByTestId('login').click();
    await page.locator('#username').fill(kim.email);
    await submit(page).click();

    await page.getByRole('link', { name: /glömt|forgot/i }).click();
    // Adressen är redan ifylld på återställningssidan — det räcker att skicka.
    await submit(page).click();

    // Koden ligger i mailet, så vägen går genom brevlådan — samma väg som bekräftelsen.
    await resetFromMailbox(page, kim, NEW_PASSWORD);
  });

  await test.step('8. Kim läser anbudet och hämtar dokumenten som ZIP', async () => {
    // Ingen utloggning här: återställningen stängde sessionen, och steget före lämnade
    // Kim utloggad. Inloggningen sker med det nya lösenordet, som personen bär själv.
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

  await test.step('8b. Lo är kollega och ser anbuden utan att ha fått något tilldelat', async () => {
    // Det här är hela skillnaden mot förut: ingen delar ut något, och ändå ser Lo både
    // förfrågan och anbuden. Parten är Nordvind, och Lo arbetar där.
    await signOut(page);
    await signIn(page, lo);
    await page.goto(`/requests/${requestId}`);
    await expect(page.getByTestId('request-title')).toHaveText('Bygg en Fortnox-integration');
    await expect(page.getByTestId('bid')).toHaveCount(1);

    // Och kollegan får inte bjuda på det egna företagets förfrågan.
    await expect(page.getByTestId('bid-form')).toHaveCount(0);
  });

  await test.step('8c. Kim ger Mio på ett annat företag läsrätt, och tar tillbaka den', async () => {
    await signOut(page);
    await signIn(page, kim);
    await page.goto(`/requests/${requestId}`);
    await page.getByTestId('grant-email').fill(mio.email);
    await page.getByTestId('grant-submit').click();
    await expect(page.getByTestId('permission')).toContainText(mio.email);

    await signOut(page);
    await signIn(page, mio);
    await page.goto(`/requests/${requestId}`);
    await expect(page.getByTestId('request-title')).toHaveText('Bygg en Fortnox-integration');
    await expect(page.getByTestId('bid')).toHaveCount(1);

    await signOut(page);
    await signIn(page, kim);
    await page.goto(`/requests/${requestId}`);
    await page.getByTestId('revoke').click();
    await expect(page.getByTestId('permission')).toHaveCount(0);

    await signOut(page);
    await signIn(page, mio);
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

  // Samma sak här: anbud förutsätter publicerad kravspec (F6.9).
  await publishSpec(page, ändringsRequestId, ['data-migration']);

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

test('ett bekräftat konto utan organisation får veta varför, inte skickas till inloggningen', async ({
  page,
}) => {
  /*
   * Ett konto som finns och är bekräftat, men som ingen kopplat till ett företag —
   * en indragen inbjudan, eller ett konto upplagt för hand. API:et svarar
   * `403 organization-missing`.
   *
   * Det får inte tolkas som "utloggad". Gör man det skickas användaren till Keycloak,
   * som loggar in direkt igen och studsar tillbaka — och beskedet om vad som faktiskt
   * saknas kommer aldrig fram.
   */
  const hemlös = person('hemlos');

  // Går inte att åstadkomma genom gränssnittet numera — läget uppstår ändå i drift.
  await unaffiliatedAccount(page, hemlös);
  await attemptSignIn(page, hemlös);

  const besked = page.getByTestId('blocked');
  await expect(besked).toBeVisible();
  await expect(besked).toContainText(/organisation/i);
  // Och kvar i gigga, inte på Keycloaks inloggningssida.
  await expect(page.getByTestId('login')).toHaveCount(0);
});

test('en bekräftelselänk som inte gäller ger besked, inte ett rått felsvar', async ({
  page,
}) => {
  /*
   * Länken pekar in i Keycloak sedan bekräftelsen flyttade dit, så det är Keycloaks
   * besked som ska prövas — inte en egen /verify-sida, som inte finns längre.
   *
   * Poängen står kvar: en förbrukad eller påhittad länk ska mötas av en läsbar sida,
   * inte av ett rått fel. Keycloak svarar med sin egen felsida och en väg vidare.
   */
  await page.goto('/auth/realms/fastgig/login-actions/action-token?key=inte-en-riktig-nyckel');

  // Keycloak svarar 400, men med en sida: en rubrik och ett besked om vad man gör nu.
  await expect(page.locator('#kc-error-message')).toContainText(
    /error|fel|sorry|ledsen|login again|logga in/i,
  );
  await expect(page.locator('h1')).toBeVisible();
});
