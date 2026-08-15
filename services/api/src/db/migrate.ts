import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';

export const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

export interface Migration {
  /** Filnamnet, t.ex. `001_users.sql`. Sorteringen är filnamnsordning. */
  name: string;
  sql: string;
}

/**
 * Läser migrationerna i filnamnsordning. Numrera med nollor (001_, 002_) — ordningen
 * är lexikografisk, inte numerisk.
 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const names = entries.filter((n) => n.endsWith('.sql')).sort();

  return Promise.all(
    names.map(async (name) => ({ name, sql: await Bun.file(join(dir, name)).text() })),
  );
}

/**
 * Applicerar de migrationer som inte redan körts och returnerar namnen på dem.
 *
 * Idempotent: körs vid varje boot mot en databas som normalt är tom (§2.1 i planen).
 * Varje migration körs i en egen transaktion tillsammans med sin bokföringsrad, så en
 * halvkörd migration aldrig kan bokföras som klar.
 */
export async function migrate(sql: SQL, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  const migrations = await loadMigrations(dir);
  if (migrations.length === 0) return [];

  const rows = (await sql`SELECT name FROM schema_migrations`) as { name: string }[];
  const applied = new Set(rows.map((r) => r.name));

  const justApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    });

    justApplied.push(migration.name);
  }

  return justApplied;
}
