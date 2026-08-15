import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { freshDatabase, type TestDatabase } from '../helpers/postgres.ts';
import { loadMigrations, migrate } from '../../src/db/migrate.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'migrations');
const BROKEN = join(import.meta.dir, '..', 'fixtures', 'broken-migrations');

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.close();
});

test('migrationerna läses i filnamnsordning', async () => {
  const migrations = await loadMigrations(FIXTURES);

  expect(migrations.map((m) => m.name)).toEqual(['001_first.sql', '002_second.sql']);
});

test('en katalog utan migrationer är inte ett fel', async () => {
  expect(await loadMigrations(join(import.meta.dir, 'finns-inte'))).toEqual([]);
});

test('migrate applicerar i ordning och är idempotent', async () => {
  const first = await migrate(db.sql, FIXTURES);
  expect(first).toEqual(['001_first.sql', '002_second.sql']);

  // 002 lägger till kolumnen — den finns bara om ordningen hölls.
  const [row] = (await db.sql`SELECT id, note, extra FROM fixture_first`) as {
    id: number;
    note: string;
    extra: string | null;
  }[];
  expect(row).toEqual({ id: 1, note: 'ett', extra: null });

  // Andra körningen ska inte göra om något.
  const second = await migrate(db.sql, FIXTURES);
  expect(second).toEqual([]);

  const [count] = (await db.sql`SELECT count(*)::int AS n FROM fixture_first`) as {
    n: number;
  }[];
  expect(count!.n).toBe(1);
});

test('en migration som fallerar halvvägs rullas tillbaka helt', async () => {
  const scratch = await freshDatabase();
  try {
    await expect(migrate(scratch.sql, BROKEN)).rejects.toThrow();

    // Första satsen i filen skapade en tabell — transaktionen ska ha ångrat den.
    const [table] = (await scratch.sql`
      SELECT to_regclass('public.broken_halfway') IS NOT NULL AS finns
    `) as { finns: boolean }[];
    expect(table!.finns).toBe(false);

    // Och inget får ha bokförts som applicerat.
    const applied = (await scratch.sql`SELECT name FROM schema_migrations`) as {
      name: string;
    }[];
    expect(applied).toEqual([]);
  } finally {
    await scratch.close();
  }
});
