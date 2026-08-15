import { SQL } from 'bun';
import { buildServer, type App } from '../../src/server.ts';
import { freshDatabase, type TestDatabase } from './postgres.ts';

export interface TestApp {
  app: App;
  sql: SQL;
  /** Direktåtkomst till databasen för assertions som ska förbi API:et. */
  db: TestDatabase;
  close(): Promise<void>;
}

const TEST_JWT_SECRET = 'test-secret-som-ar-minst-fyrtioatta-tecken-langt-abc';

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
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const db = await freshDatabase();

  const app = await buildServer({
    config: {
      PORT: 0,
      HOST: '127.0.0.1',
      DATABASE_URL: db.url,
      JWT_SECRET: TEST_JWT_SECRET,
      LOG_LEVEL: 'silent',
    },
    sql: db.sql,
  });

  await options.extraRoutes?.(app);
  await app.ready();

  return {
    app,
    sql: db.sql,
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
export async function buildTestAppWithBrokenDatabase(url: string): Promise<TestApp> {
  const sql = new SQL(url);
  const app = await buildServer({
    config: {
      PORT: 0,
      HOST: '127.0.0.1',
      DATABASE_URL: url,
      JWT_SECRET: TEST_JWT_SECRET,
      LOG_LEVEL: 'silent',
    },
    sql,
  });
  await app.ready();

  return {
    app,
    sql,
    db: { url, sql, close: () => sql.end() },
    close: async () => {
      await app.close();
      await sql.end().catch(() => {});
    },
  };
}
