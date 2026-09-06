import { SQL } from "bun";
import { buildServer, type App } from "../../src/server.ts";
import {
	createMemoryMailer,
	type MemoryMailer,
} from "../../src/mail/mailer.ts";
import {
	createMemoryObjectStore,
	type MemoryObjectStore,
} from "../../src/storage/object-store.ts";
import { freshDatabase, type TestDatabase } from "./postgres.ts";
import { createLocalKeys } from "../../src/auth/keys.ts";
import { testKeys, TEST_AUDIENCE, TEST_ISSUER } from "./keys.ts";

export interface TestApp {
	app: App;
	sql: SQL;
	/** Utgående post. Testernas motsvarighet till mailpits inkorg. */
	mail: MemoryMailer;
	/** Lagrade objekt. Testernas motsvarighet till att titta i MinIO-bucketen. */
	objects: MemoryObjectStore;
	/** Direktåtkomst till databasen för assertions som ska förbi API:et. */
	db: TestDatabase;
	close(): Promise<void>;
}

export interface BuildTestAppOptions {
	/**
	 * Registreras före app.ready(). Används för att pröva sådant som inte har en egen
	 * publik route — t.ex. requireAuth — utan att API-ytan växer utanför §6 i planen.
	 */
	extraRoutes?: (app: App) => Promise<void>;
}

/**
 * Bygger appen mot en egen databas. Testerna anropar app.inject() — ingen port öppnas.
 * Anropas en gång per testfil i beforeAll.
 */
export async function buildTestApp(
	options: BuildTestAppOptions = {},
): Promise<TestApp> {
	const db = await freshDatabase();
	const mail = createMemoryMailer();
	const objects = createMemoryObjectStore();

	const app = await buildServer({
		config: {
			PORT: 0,
			HOST: "127.0.0.1",
			DATABASE_URL: db.url,
			LOG_LEVEL: "silent",
			SMTP_HOST: "127.0.0.1",
			SMTP_PORT: 1025,
			MAIL_FROM: "gigga <no-reply@test>",
			PUBLIC_BASE_URL: "http://gigga.test",
			OIDC_REALM: "gigga",
			OIDC_ISSUER: TEST_ISSUER,
			// Aldrig hämtad: testerna skickar in nyckeluppsättningen nedan.
			OIDC_JWKS_URI: "http://gigga.test/aldrig-hamtad",
			OIDC_AUDIENCE: TEST_AUDIENCE,
			S3_ENDPOINT: "http://minne",
			S3_BUCKET: "test",
			S3_ACCESS_KEY_ID: "test",
			S3_SECRET_ACCESS_KEY: "test",
			S3_REGION: "us-east-1",
			ORPHAN_SWEEP_INTERVAL_MINUTES: 0,
			STORAGE_ALERT_EMAIL: "",
		},
		sql: db.sql,
		mailer: mail,
		objects,
		keys: createLocalKeys((await testKeys()).jwks),
	});

	await options.extraRoutes?.(app);
	await app.ready();

	return {
		app,
		sql: db.sql,
		mail,
		objects,
		db,
		close: async () => {
			await app.close();
			await db.close();
		},
	};
}

/**
 * Som buildTestApp, men mot en databas som inte går att nå — för att testa nedsidan
 * (t.ex. att /health svarar 503 istället för att krascha).
 */
export async function buildTestAppWithBrokenDatabase(
	url: string,
): Promise<TestApp> {
	const sql = new SQL(url);
	const mail = createMemoryMailer();
	const objects = createMemoryObjectStore();
	const app = await buildServer({
		config: {
			PORT: 0,
			HOST: "127.0.0.1",
			DATABASE_URL: url,
			LOG_LEVEL: "silent",
			SMTP_HOST: "127.0.0.1",
			SMTP_PORT: 1025,
			MAIL_FROM: "gigga <no-reply@test>",
			PUBLIC_BASE_URL: "http://gigga.test",
			OIDC_REALM: "gigga",
			OIDC_ISSUER: TEST_ISSUER,
			// Aldrig hämtad: testerna skickar in nyckeluppsättningen nedan.
			OIDC_JWKS_URI: "http://gigga.test/aldrig-hamtad",
			OIDC_AUDIENCE: TEST_AUDIENCE,
			S3_ENDPOINT: "http://minne",
			S3_BUCKET: "test",
			S3_ACCESS_KEY_ID: "test",
			S3_SECRET_ACCESS_KEY: "test",
			S3_REGION: "us-east-1",
			ORPHAN_SWEEP_INTERVAL_MINUTES: 0,
			STORAGE_ALERT_EMAIL: "",
		},
		sql,
		mailer: mail,
		objects,
		keys: createLocalKeys((await testKeys()).jwks),
	});
	await app.ready();

	return {
		app,
		sql,
		mail,
		objects,
		db: { url, sql, close: () => sql.end() },
		close: async () => {
			await app.close();
			await sql.end().catch(() => {});
		},
	};
}
