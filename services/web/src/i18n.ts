import { useSyncExternalStore } from "react";
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

const STORAGE_KEY = "gigga.locale";

function storedLocale(): Locale {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (value && (LOCALES as readonly string[]).includes(value))
			return value as Locale;
	} catch {
		// Lagringen kan vara avstängd; standardspråket duger då.
	}
	return "sv-SE";
}

/*
 * Språket är ett litet externt tillstånd, inte React-state: `_()` anropas från vilken
 * komponent som helst utan hook, och byte ska slå igenom överallt på en gång. Den som
 * prenumererar (App) ritas om vid byte, och med den hela trädet — alla `_()`-anrop körs
 * då på nytt mot den nya tabellen.
 */
let current: Locale = storedLocale();
const listeners = new Set<() => void>();

function applyLang(): void {
	document.documentElement.lang = current;
}
applyLang();

export function getLocale(): Locale {
	return current;
}

export function setLocale(locale: Locale): void {
	if (locale === current) return;
	current = locale;
	applyLang();
	try {
		localStorage.setItem(STORAGE_KEY, locale);
	} catch {
		// Valet gäller ändå för den här sidvisningen.
	}
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Aktuellt språk, med omritning när det byts. Räcker att anropa högst upp i trädet. */
export function useLocale(): Locale {
	return useSyncExternalStore(subscribe, getLocale, getLocale);
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
		console.warn(`i18n: nyckeln "${key}" saknas i ${current}.json`);
		return key;
	}
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}
