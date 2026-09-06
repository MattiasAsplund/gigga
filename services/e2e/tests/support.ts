import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
	createUserWithoutOrganization,
	inviteToOrganization,
} from "./keycloak.ts";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

/**
 * Adressen som *node-sidan* av sviten når webben på.
 *
 * Inte samma som `baseURL`. Webbläsaren surfar på localhost och löser upp namnet till
 * tunneln (se playwright.config.ts), men `page.request` går genom node — där gäller
 * ingen host-resolver-regel, och `localhost` pekar på containern själv:
 * *"connect ECONNREFUSED ::1:5173"*. Genvägarna nedan måste därför skriva ut adressen.
 */
const WEB = process.env.BASE_URL ?? "http://localhost:5173";

/** Unik per körning: databasen lever kvar så länge Aspire kör. */
export const RUN = Date.now().toString(36);

export const PASSWORD = "ett-langt-losenord";
/** Lösenordet efter en återställning. Minst tolv tecken, som API:et kräver. */
export const NEW_PASSWORD = "ett-annat-langt-losenord";

export interface Person {
	email: string;
	displayName: string;
	/** Organisationens alias i realmet. Parten i affären är företaget, inte personen. */
	organization: string;
	/**
	 * Följer med kontot i stället för att ligga som en konstant i inloggningen. Efter en
	 * återställning är det ett annat, och signIn ska använda rätt utan att varje anropare
	 * håller reda på vilket.
	 */
	password: string;
}

export const person = (name: string, organization = "nordvind"): Person => ({
	email: `${name}-${RUN}@example.se`,
	displayName: name,
	organization,
	password: PASSWORD,
});

interface MailpitMessage {
	ID: string;
	To: { Address: string }[];
	Subject: string;
}

export interface Brev {
	ID: string;
	Text: string;
	HTML: string;
}

/**
 * Väntar in ett mail till adressen och returnerar det.
 *
 * `path` är inte valfri lyx när den anges. En inbjuden person får **två** brev — först
 * inbjudan, sedan bekräftelsen — och "det senaste" är därför tvetydigt. Utan kravet på
 * vad brevet ska innehålla returnerades inbjudan direkt, och väntan på bekräftelsen som
 * var på väg blev aldrig av: felet såg ut som ett brev som aldrig kom.
 */
export async function latestMail(
	address: string,
	path?: string,
): Promise<Brev> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const list = (await (
			await fetch(`${MAILPIT}/api/v1/messages?limit=200`)
		).json()) as {
			messages: MailpitMessage[];
		};

		for (const candidate of list.messages) {
			if (candidate.To[0]?.Address.toLowerCase() !== address.toLowerCase())
				continue;

			const brev = (await (
				await fetch(`${MAILPIT}/api/v1/message/${candidate.ID}`)
			).json()) as Omit<Brev, "ID">;

			if (!path || avkoda(brev.Text).includes(path))
				return { ID: candidate.ID, ...brev };
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(
		`Inget mail till ${address}${path ? ` med ${path}` : ""} inom rimlig tid`,
	);
}

/**
 * Keycloak skriver `&#61;` och `&amp;` även i textdelen, medan href i html-delen är
 * oescapad. Utan avkodningen jämförs två stavningar av samma adress och matchar aldrig.
 */
const avkoda = (text: string): string =>
	text
		.replace(/&amp;/g, "&")
		.replace(/&#(\d+);/g, (_, code: string) =>
			String.fromCharCode(Number(code)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
			String.fromCharCode(parseInt(code, 16)),
		);

/**
 * Vägen från brevlådan tillbaka till gigga, gången genom mailpits gränssnitt i stället
 * för dess API: det är så en användare gör, och bildspelet får med både listan och
 * brevet på köpet.
 *
 * Länken klickas som den står, men klicket fångas och skickas vidare till den här
 * fliken på en adress webbläsaren faktiskt når. Varför båda delarna behövs står vid
 * greppet längre ner.
 */
async function clickMailLink(
	page: Page,
	who: Person,
	path: string,
): Promise<void> {
	// Adressen webbläsaren når gigga på, hämtad ur sidan den redan står på.
	const gigga = new URL(page.url()).origin;

	// Att brevet kommit fram vet API:et först. Mailpits lista fyller på sig själv över
	// websocket, men att veta att mailet finns innan brevlådan öppnas är enklare att lita
	// på än att vänta in en rad som ska dyka upp.
	const brevet = await latestMail(who.email, path);

	await page.goto(MAILPIT);
	// Just det brevet, inte det översta: inbjudan och bekräftelsen ligger båda i lådan.
	const brev = page.locator(`a[href="/view/${brevet.ID}"]`);
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
		? page.frameLocator("#preview-html").locator(val)
		: page.locator(`.tab-content ${val}`);

	// Adressen brevet bär. Att den står i sidan är kvittot på att det är det här brevet
	// som visas, och inte det förra som ännu inte hunnit bytas ut.
	const iBrevet = new RegExp(`https?://\\S*${path}\\S*`).exec(
		avkoda(brevet.Text),
	)?.[0];
	if (!iBrevet)
		throw new Error(
			`Ingen ${path}-länk i brevet till ${who.email}:\n${brevet.Text}`,
		);
	await expect(länk).toHaveAttribute("href", iBrevet);

	// Klicket fångas där det sker i stället för att länken skrivs om i förväg: mailpit
	// sätter target="_blank" på länkarna i förhandsgranskningen, och sätter tillbaka det
	// ett par hundra millisekunder efter att den laddat. Ett omskrivet attribut hinner
	// alltså skrivas över, och klicket öppnar gigga i en flik som testet inte håller i.
	//
	// Adressen byts på vägen. Brevet bär den adress API:et känner till, och API:et är en
	// process på värdmaskinen — medan webbläsaren sitter i en container och når webben
	// under ett annat namn. Bara värddelen byts; token kommer ur brevet som det står där.
	const mål = new URL(iBrevet);
	await länk.evaluate(
		(element, href) => {
			element.addEventListener(
				"click",
				(event) => {
					event.preventDefault();
					window.top!.location.href = href;
				},
				{ capture: true },
			);
		},
		gigga + mål.pathname + mål.search,
	);
	await länk.click();
}

/**
 * Bekräftelselänken ur mailet, klickad i brevlådan.
 *
 * Länken pekar in i Keycloak numera — `/login-actions/action-token` — och inte på en
 * egen /verify-sida. Brevet skickas av Keycloak, men landar i samma mailpit som förut,
 * så vägen genom brevlådan är oförändrad.
 */
export async function verifyFromMailbox(
	page: Page,
	who: Person,
): Promise<void> {
	await clickMailLink(page, who, "/login-actions/");
}

/**
 * Återställningslänken ur mailet, klickad i brevlådan, och det nya lösenordet satt på
 * sidan den leder till. Lösenordet skrivs in på personen: nästa signIn ska använda det
 * utan att veta att en återställning hänt.
 */
export async function resetFromMailbox(
	page: Page,
	who: Person,
	password: string,
): Promise<void> {
	await clickMailLink(page, who, "/login-actions/");

	// Keycloaks egna fält, inte våra data-testid:n — sidan är dess, inte giggas.
	await page.locator("#password-new").fill(password);
	await page.locator("#password-confirm").fill(password);
	await submit(page).click();
	who.password = password;
}

/**
 * Steg 1–2: skapa konto, bekräfta adressen och bli medlem i sitt företag.
 *
 * Formulären är Keycloaks, inte giggas — därför dess fältnamn och inte våra
 * data-testid:n. gigga har inga inloggnings- eller registreringssidor kvar att fylla i.
 *
 * Medlemskapet är inte en genväg förbi något: självregistrering ger inget, och ett konto
 * utan organisation får `403 organization-missing` på varje anrop. I skarp drift är det
 * en inbjudan som gör kopplingen; här gör admin-API:et det direkt, för att kedjan ska
 * handla om affären och inte om onboarding.
 */
/**
 * Lämnar webbläsaren utloggad, vad den än var innan.
 *
 * Väntan först är inte överflödig: `count()`/`isVisible()` frågar direkt och svarar nej
 * medan React fortfarande läser in sessionen ur sessionStorage. Utloggningen hoppades då
 * över, nästa person möttes av föregåendes katalog, och felet visade sig som en
 * inloggningsknapp som aldrig dök upp. `or()` väntar in vilketdera som kommer först.
 *
 * `logout` finns även på beskedet för ett konto utan organisation — också ett läge man
 * ska kunna ta sig ur.
 */
export async function ensureSignedOut(page: Page): Promise<void> {
	const nyckel = page.getByTestId("login").or(page.getByTestId("logout"));

	/*
	 * Flera försök, för att navigeringen kan bli stulen.
	 *
	 * Onboardingen slutar i Keycloaks kontogränssnitt, som loggar in sig själv över OIDC
	 * och fortsätter navigera i egen takt — den skalar bort sin `code` ur adressfältet en
	 * stund efter att sidan visats. Sker det mitt i vår `goto('/')` vinner den, och sviten
	 * står kvar hos Keycloak och letar efter giggas knappar. Ett nytt försök räcker.
	 */
	for (let försök = 1; ; försök++) {
		try {
			// Även själva goto kan avbrytas: "interrupted by another navigation".
			await page.goto("/");
			await expect(nyckel).toBeVisible({ timeout: 5_000 });
			break;
		} catch (cause) {
			if (försök === 5) throw cause;
			await page.waitForTimeout(1_000);
		}
	}

	if (await page.getByTestId("logout").isVisible()) await signOut(page);
	await page.context().clearCookies();
}

export async function acceptInvitation(page: Page, who: Person): Promise<void> {
	await ensureSignedOut(page);
	await inviteToOrganization(
		page,
		who.email,
		who.organization,
		who.displayName,
	);

	// Inbjudan i brevlådan leder till ett registreringsformulär — trots att realmet har
	// `registrationAllowed: false`. Token i länken är det som öppnar dörren, och bara för
	// den adressen. Namn och adress är redan ifyllda; lösenordet är det som saknas.
	await clickMailLink(page, who, "/protocol/openid-connect/registrations");

	// Formuläret är tomt, inte förifyllt — inbjudan bär adressen i sin token, men sidan
	// ber om allt. Fylls bara lösenorden svarar Keycloak "Please specify this field" på
	// resten, och kontot skapas aldrig.
	await page.locator("#firstName").fill(who.displayName);
	await page.locator("#lastName").fill("Testsson");
	await page.locator("#email").fill(who.email);
	await page.locator("#password").fill(who.password);
	await page.locator("#password-confirm").fill(who.password);
	await submit(page).click();

	/*
	 * Att formuläret försvann är kvittot på att det skickades.
	 *
	 * Utan kontrollen blir ett klick som inte tog tyst: helsidesbilden som bildspelet tar
	 * före varje klick lämnar sidan med skruvade layoutmått, koordinaterna hamnar bredvid
	 * knappen, och Playwright rapporterar ändå att klicket gick igenom. Felet dök upp först
	 * flera steg senare, som ett brev som aldrig kom.
	 */
	await expect(page.locator("#kc-register-form")).toHaveCount(0);
}

/**
 * Steg 1–2: inbjudan, konto och bekräftad adress.
 *
 * Ingen registrerar sig själv. Den som ska in i Nordvind bjuds in av någon som redan är
 * där — det är svaret på vem som godkänner. Medlemskapet finns när lösenordet satts, och
 * adressen bekräftas därefter med Keycloaks eget brev.
 *
 * Kedjan slutar i Keycloaks kontogränssnitt och inte i gigga: inbjudningslänken går till
 * klienten `account`, som Keycloak väljer själv. Vägen in i gigga är en vanlig inloggning
 * efteråt — och den ska landa i katalogen, vilket `signIn` kräver.
 */
export async function inviteAndOnboard(page: Page, who: Person): Promise<void> {
	await acceptInvitation(page, who);
	await verifyFromMailbox(page, who);

	/*
	 * Bekräftelsen landar i Keycloaks kontogränssnitt — inbjudningslänken går till klienten
	 * `account`, som Keycloak väljer själv. Den sidan loggar in sig själv över OIDC, och
	 * den navigeringen måste få bli klar: annars kapplöper den med vår egen `goto('/')`
	 * och vinner, och sviten står kvar på kontogränssnittet och letar efter giggas knappar.
	 */
	await page
		.waitForURL(/\/auth\/realms\/gigga\/account/, { timeout: 15_000 })
		.catch(() => {});

	/*
	 * En första inloggning i gigga, och sedan ut igen.
	 *
	 * Inte kosmetika: gigga känner bara till den som varit här. Speglingen (`users`) skapas
	 * av `requireAuth` vid första anropet, och innan dess finns personen bara i Keycloak.
	 * Att dela en förfrågan med någon som aldrig loggat in ger `404 user-not-found` — vilket
	 * är rimligt, men det gör inloggningen till en del av att vara påhittbar.
	 *
	 * `signIn` kräver dessutom att man landar i katalogen, så onboardingen kontrolleras
	 * hela vägen: inbjuden, bekräftad, medlem, och insläppt.
	 */
	await signIn(page, who);
	await ensureSignedOut(page);
}

/** Ett bekräftat konto som ingen kopplat till ett företag. Se keycloak.ts. */
export async function unaffiliatedAccount(
	page: Page,
	who: Person,
): Promise<void> {
	await ensureSignedOut(page);
	await createUserWithoutOrganization(
		page,
		who.email,
		who.password,
		who.displayName,
	);
}

/** Bifogar ett dokument till anbudet som sidan redan står på. */
export async function attach(
	page: Page,
	name: string,
	mimeType: string,
	content: string,
): Promise<void> {
	await page
		.getByTestId("file")
		.setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
	await page.getByTestId("upload").click();
}

/**
 * Steg 3: logga in genom Keycloak och landa i katalogen.
 *
 * Vägen går över landningssidan: den är den enda öppna sidan, och knappen där är det
 * enda sättet in. gigga har ingen egen inloggningssida längre.
 */
export const submit = (page: Page) =>
	page.locator('input[type="submit"], button[type="submit"]').first();

/**
 * Går igenom Keycloaks inloggning utan att kräva att den lyckas.
 *
 * Inloggningen är **identitetsförd** sedan organisationerna slogs på: adressen först, och
 * lösenordet på nästa sida. Det är Keycloak som ordnar det så — med organisationer måste
 * det gå att avgöra vilket företag adressen hör till innan lösenordet efterfrågas, för
 * att kunna skicka vidare till företagets egen inloggning. Därför två steg, och därför
 * ett lösenordsfält som kanske inte finns än.
 */
export async function attemptSignIn(page: Page, who: Person): Promise<void> {
	await page.goto("/");
	await page.getByTestId("login").click();

	await page.locator("#username").fill(who.email);
	await submit(page).click();

	// `fill` väntar in fältet av sig själv. Ett `isVisible()` här hade svarat nej medan
	// lösenordssidan fortfarande laddade, lösenordet hade hoppats över, och felet dykt upp
	// som en inloggning som bara inte blev av.
	await page.locator("#password").fill(who.password);
	await submit(page).click();
}

/** Steg 3: logga in genom Keycloak och landa i katalogen. */
export async function signIn(page: Page, who: Person): Promise<void> {
	await ensureSignedOut(page);
	await attemptSignIn(page, who);
	await expect(page.getByTestId("current-user")).toHaveText(who.email);
}

/** Utloggningen går genom Keycloak och tillbaka — sessionen avslutas där, inte här. */
export async function signOut(page: Page): Promise<void> {
	await page.getByTestId("logout").click();
	await expect(page.getByTestId("login")).toBeVisible();
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
	gigTypes: string[] = ["integration"],
): Promise<void> {
	// oidc-client-ts lägger sessionen under oidc.user:<authority>:<client_id>. Nyckeln
	// letas upp istället för att skrivas ut: authority bär den adress webbläsaren råkar
	// använda, och den är en annan i containern än på värden.
	const token = await page.evaluate(() => {
		const key = Object.keys(sessionStorage).find((candidate) =>
			candidate.startsWith("oidc.user:"),
		);
		return key
			? (JSON.parse(sessionStorage.getItem(key)!) as { access_token: string })
					.access_token
			: null;
	});
	if (!token)
		throw new Error("Ingen inloggad användare att publicera kravspecen som.");

	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const base = `${WEB}/api/v1/requests/${requestId}/spec`;

	const opened = await page.request.post(base, { headers, data: { gigTypes } });
	if (!opened.ok())
		throw new Error(
			`öppna kravspec: ${opened.status()} ${await opened.text()}`,
		);

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

	const value = (question: Spec["questions"][number]): unknown => {
		switch (question.kind) {
			case "bool":
				return true;
			case "integer":
				return typeof question.config.minimum === "number"
					? question.config.minimum
					: 1;
			case "date":
				return "2026-09-01";
			case "choice":
				return question.options[0]?.key;
			case "multichoice":
				return [question.options[0]?.key];
			default:
				return "Besvarat i e2e-flödet.";
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
		if (!answers.ok())
			throw new Error(`svara: ${answers.status()} ${await answers.text()}`);

		const reread = await page.request.get(base, { headers });
		if (!reread.ok())
			throw new Error(
				`läs kravspec: ${reread.status()} ${await reread.text()}`,
			);
		spec = (await reread.json()) as Spec;
	}

	for (const criterion of spec.criteria.filter(
		(row) => row.kind === "criterion",
	)) {
		const approved = await page.request.post(
			`${base}/criteria/${criterion.id}/approval`,
			{
				headers,
			},
		);
		if (!approved.ok())
			throw new Error(`godkänn: ${approved.status()} ${await approved.text()}`);
	}

	const published = await page.request.post(`${base}/publication`, { headers });
	if (!published.ok())
		throw new Error(
			`publicera: ${published.status()} ${await published.text()}`,
		);
}

/**
 * Intervjun genom gränssnittet: välj typ, besvara frågorna, godkänn kriterierna,
 * publicera.
 *
 * Inget här känner till en enskild fråga. Fälten fylls efter `data-kind` — samma sju
 * former webben renderar — och svaren sparas i rundor, eftersom ett svar kan öppna en
 * följdfråga. Det är precis vad en kund gör, och därför tål steget att katalogen växer.
 */
export async function runInterview(
	page: Page,
	typeName: string,
): Promise<void> {
	await page.getByTestId("go-spec").click();

	await page
		.getByTestId("gig-type")
		.filter({ hasText: typeName })
		.locator("input")
		.check();
	await page.getByTestId("open-spec").click();
	await expect(page.getByTestId("completeness")).toBeVisible();

	for (let round = 0; round < 5; round += 1) {
		const filled = await fillVisibleQuestions(page);
		if (filled.length === 0) break;

		await page.getByTestId("save-answers").click();

		/*
		 * Väntan hänger på tillståndet, inte på ett svar från nätet: en klick som råkar
		 * landa medan React ritar om skickar ingenting alls, och då väntar man för evigt på
		 * ett anrop som aldrig gjordes. Att frågan blivit besvarad syns i DOM:en, och
		 * assertionen provar om tills den gör det.
		 */
		await expect(question(page, filled[0]!)).toHaveAttribute(
			"data-answered",
			"true",
		);
	}

	// Kunden godkänner varje rad aktivt — det är det som håller kravspecen hos kunden.
	for (const id of await page
		.getByTestId("approve")
		.evaluateAll((buttons) =>
			buttons.map(
				(button) =>
					button
						.closest('[data-testid="criterion"]')
						?.getAttribute("data-id") ?? "",
			),
		)) {
		const row = page.locator(`[data-testid="criterion"][data-id="${id}"]`);
		await row.getByTestId("approve").click();
		await expect(row).toHaveAttribute("data-approved", "true");
	}

	await expect(page.getByTestId("publish-spec")).toBeEnabled();
	await page.getByTestId("publish-spec").click();
	await expect(page.getByTestId("spec-head")).toContainText("published");
}

const question = (page: Page, key: string) =>
	page.locator(`[data-testid="question"][data-key="${key}"]`);

/** Fyller de synliga frågor som ännu är tomma, och returnerar vilka som rördes. */
async function fillVisibleQuestions(page: Page): Promise<string[]> {
	const touched: string[] = [];

	for (const field of await page.getByTestId("question").all()) {
		const kind = await field.getAttribute("data-kind");
		const key = await field.getAttribute("data-key");
		if (!key) continue;
		const control = field.getByTestId(`answer-${key}`);

		if (kind === "multichoice") {
			const boxes = control.locator('input[type="checkbox"]');
			if ((await boxes.locator(":checked").count()) > 0) continue;
			await boxes.first().check();
			touched.push(key);
			continue;
		}

		if ((await control.inputValue()) !== "") continue;

		switch (kind) {
			case "bool":
			case "choice":
				await control.selectOption({ index: 1 });
				break;
			case "integer":
				await control.fill((await control.getAttribute("min")) ?? "1");
				break;
			case "date":
				await control.fill("2026-09-01");
				break;
			default:
				await control.fill(`Besvarat i e2e-flödet: ${key}.`);
		}
		touched.push(key);
	}

	return touched;
}
