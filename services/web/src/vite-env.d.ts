/// <reference types="vite/client" />

// Sätts av vite.config.ts ur processens TEST_LOCALE — se `define` där och src/i18n.ts.
interface ImportMetaEnv {
	readonly TEST_LOCALE: string;
}
