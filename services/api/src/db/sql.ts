import { SQL } from 'bun';

/**
 * Bun.SQL-instansen. En per process — den poolar internt.
 *
 * OBS: bigint- och numeric-kolumner kommer tillbaka som `string`. Konvertera alltid
 * explicit i mapparna i den här katalogen, aldrig i en route.
 */
export function createSql(databaseUrl: string): SQL {
  return new SQL(databaseUrl);
}

export type Sql = SQL;
