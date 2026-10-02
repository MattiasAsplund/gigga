import sv from "./locales/sv-SE.json";
import en from "./locales/en-GB.json";
import nb from "./locales/nb-NO.json";
import da from "./locales/da-DK.json";
import fi from "./locales/fi-FI.json";

type Params = Record<string, string | number>;

export const LOCALES = ["sv-SE", "en-GB", "nb-NO", "da-DK", "fi-FI"] as const;
export type Locale = (typeof LOCALES)[number];

const tables: Record<Locale, Record<string, string>> = {
	"sv-SE": sv,
	"en-GB": en,
	"nb-NO": nb,
	"da-DK": da,
	"fi-FI": fi,
};

/** `app.login`, `question.integration.systems.prompt` — men inte en mening med blanksteg. */
const KEY_SHAPE = /^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+)+$/;

/*
 * Språket bestäms när webben startar, inte av besökaren: AppHosten sätter TEST_LOCALE
 * på webben (kommandot "Starta på valt språk" i dashboarden), och vite.config.ts bakar in
 * värdet som import.meta.env.TEST_LOCALE. Ett byte är alltså en omstart av webben, och
 * inget en komponent kan prenumerera på — därför en konstant och inget tillstånd.
 *
 * Ett värde som inte är ett av webbens språk faller tillbaka på svenska, med en varning:
 * hellre en sida på fel språk än en tom.
 */
function configuredLocale(): Locale {
	const value = import.meta.env.TEST_LOCALE;
	if ((LOCALES as readonly string[]).includes(value)) return value as Locale;
	if (value) {
		console.warn(
			`i18n: TEST_LOCALE=${value} är inget av webbens språk (${LOCALES.join(", ")}); svenska används`,
		);
	}
	return "sv-SE";
}

const current: Locale = configuredLocale();
document.documentElement.lang = current;

export function getLocale(): Locale {
	return current;
}

/**
 * Alla texter i gränssnittet går genom den här funktionen och slås upp i
 * locales/<språk>.json. Nyckeln är stabil och beskriver var texten står och vad den gör
 * (`bidDetail.signButton`), värdet är lydelsen på det valda språket.
 *
 * Platshållare skrivs `{namn}` i värdet och fylls ur `params`. En nyckel som saknas i
 * filen returneras som den är och varnas för i konsolen — hellre en synlig nyckel på
 * skärmen än ett tomt fält.
 */
export function _(key: string, params?: Params): string {
	const template = tables[current][key];
	if (template === undefined) {
		// Text ur API:et går också hit: katalogens frågor och kriterier kommer som nycklar,
		// men ett kriterium kunden skrivit själv är fri text och ska visas som den är.
		// Varningen gäller därför bara det som ser ut som en nyckel.
		if (KEY_SHAPE.test(key)) {
			console.warn(`i18n: nyckeln "${key}" saknas i ${current}.json`);
		}
		return key;
	}
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}
