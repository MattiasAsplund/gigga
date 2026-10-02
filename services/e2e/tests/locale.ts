import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Webbens texter, på det språk sviten körs på.
 *
 * Sviten går mot ett gränssnitt som byter språk, så en lydelse som "Signerat" går inte
 * att skriva in i ett test: på engelska står det "Signed". Testerna slår i stället upp
 * nyckeln — samma nyckel som webben använder — i samma språkfil som webben läser, och
 * jämför med det som faktiskt renderas.
 *
 * Språket kommer från AppHosten som TEST_LOCALE (kommandot "Starta på valt språk" på
 * webbresursen) — samma variabel webben startats med, så webben har ingen språkväljare
 * att ställa om — och filen läses här, när modulen laddas. Konfigurationen importerar
 * modulen, så det sker innan ett enda test startat: ett okänt språk eller en fil som
 * saknas stoppar körningen med ett besked i stället för att låta varje test falla på
 * en text som inte matchar.
 *
 * LOCALES_DIR är mappen filerna ligger i. I containern monteras webbens
 * services/web/src/locales dit av AppHosten; körs sviten för hand på värden hittas
 * mappen i stället relativt den här filen, uppåt i arbetsytan.
 *
 * Nycklarna och platshållarna ({namn}) följer webbens i18n.ts. Skillnaden är att en
 * nyckel som saknas är ett fel här: i webben är en synlig nyckel på skärmen bättre än
 * ett tomt fält, men ett test som letar efter en nyckel i stället för en lydelse hade
 * bara misslyckats med ett sämre besked.
 */
export const LOCALES = ["sv-SE", "en-GB", "nb-NO", "da-DK", "fi-FI"] as const;
export type Locale = (typeof LOCALES)[number];

const requested = process.env.TEST_LOCALE ?? "sv-SE";
if (!(LOCALES as readonly string[]).includes(requested)) {
	throw new Error(
		`TEST_LOCALE=${requested} är inget av webbens språk: ${LOCALES.join(", ")}`,
	);
}
export const locale = requested as Locale;

const dir =
	process.env.LOCALES_DIR ?? resolve(__dirname, "..", "..", "web", "src", "locales");
export const localeFile = resolve(dir, `${locale}.json`);

let texts: Record<string, string>;
try {
	texts = JSON.parse(readFileSync(localeFile, "utf8")) as Record<string, string>;
} catch (cause) {
	throw new Error(
		`Språkfilen för ${locale} gick inte att läsa: ${localeFile}. ` +
			"Monteras webbens locales-mapp in (LOCALES_DIR)?",
		{ cause },
	);
}

type Params = Record<string, string | number>;

/** Lydelsen för `key` på körningens språk, med `{namn}` fyllt ur `params`. */
export function _(key: string, params?: Params): string {
	const template = texts[key];
	if (template === undefined) {
		throw new Error(`i18n: nyckeln "${key}" saknas i ${locale}.json`);
	}
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}
