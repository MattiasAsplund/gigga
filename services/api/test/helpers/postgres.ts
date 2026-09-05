import { $, SQL } from 'bun';
import { migrate } from '../../src/db/migrate.ts';
import { syncGigCatalog } from '../../src/db/gig-catalog.ts';

/**
 * Testdatabas: en Postgres-container som återanvänds mellan körningar, och en färsk
 * databas per testfil.
 *
 * Vi styr podman direkt istället för att gå via Testcontainers — biblioteket bygger på
 * Docker-API + Ryuk-städaren, som är besvärlig rootless. Se planen §7.1.
 *
 * Containern har ett fast namn och lämnas kvar när körningen är slut. Det är skillnaden
 * mellan 3 s och 0,3 s per varv i prompt-dialogen, och den kostar inget i isolering:
 * malldatabasen byggs om vid varje körning och varje testfil får en egen kopia.
 *
 *   podman rm -f fastgig-test-pg   # riv den för hand vid behov
 *   TEST_DATABASE_URL=...          # kör mot en redan uppe Aspire-Postgres, rör inte podman
 */

// Fullkvalificerat — registries.conf saknar unqualified-search-registries (planen §2.1).
const IMAGE = 'docker.io/library/postgres:17-alpine';
const CONTAINER = 'fastgig-test-pg';
const TEMPLATE_DB = 'fastgig_template';
const READY_TIMEOUT_MS = 60_000;

interface Cluster {
  /** Anslutning till `postgres`-databasen, används för CREATE DATABASE. */
  adminUrl: string;
}

let clusterPromise: Promise<Cluster> | null = null;
let databaseCounter = 0;

function urlFor(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function isRunning(): Promise<boolean> {
  const res = await $`podman inspect -f {{.State.Running}} ${CONTAINER}`.nothrow().quiet();
  return res.exitCode === 0 && res.stdout.toString().trim() === 'true';
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await $`podman exec ${CONTAINER} pg_isready -U test -q`.nothrow().quiet();
    if (probe.exitCode === 0) return;
    await Bun.sleep(200);
  }
  const logs = await $`podman logs ${CONTAINER}`.nothrow().text();
  throw new Error(`Postgres blev inte redo inom ${READY_TIMEOUT_MS} ms.\n${logs}`);
}

async function hostPort(): Promise<string> {
  // "127.0.0.1:49153" → 49153
  const mapping = (await $`podman port ${CONTAINER} 5432/tcp`.text()).trim();
  const port = mapping.split('\n')[0]?.split(':').pop();
  if (!port) throw new Error(`Kunde inte läsa ut porten ur: ${mapping}`);
  return port;
}

async function startContainer(): Promise<void> {
  // Argumenten som array: en flerradig Bun.$-literal bryter kommandot vid radbytet.
  const runArgs = [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-e',
    'POSTGRES_USER=test',
    '-e',
    'POSTGRES_PASSWORD=test',
    '-e',
    'POSTGRES_DB=postgres',
    '-p',
    '127.0.0.1::5432',
    IMAGE,
  ];

  const created = await $`podman ${runArgs}`.nothrow().quiet();
  if (created.exitCode !== 0) {
    // Vanligaste orsaken: en stoppad container med samma namn ligger kvar.
    await $`podman rm -f ${CONTAINER}`.nothrow().quiet();
    await $`podman ${runArgs}`;
  }
}

/** Städar bort databaser som tidigare körningar lämnat kvar i den återanvända containern. */
async function dropStaleDatabases(admin: SQL): Promise<void> {
  const stale = (await admin`
    SELECT datname FROM pg_database WHERE datname LIKE 'test\\_%'
  `) as { datname: string }[];

  for (const { datname } of stale) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  }
}

/**
 * Startar (eller återanvänder) klustret en gång per testkörning och migrerar
 * malldatabasen. Malldatabasen betalar migrationskostnaden en gång; testfilerna
 * kopierar den.
 */
async function getCluster(): Promise<Cluster> {
  clusterPromise ??= (async () => {
    const external = Bun.env.TEST_DATABASE_URL;
    let adminUrl: string;

    if (external) {
      adminUrl = external;
    } else {
      if (!(await isRunning())) {
        await startContainer();
        await waitForReady();
      }
      adminUrl = `postgres://test:test@127.0.0.1:${await hostPort()}/postgres`;
    }

    const admin = new SQL(adminUrl);
    try {
      await dropStaleDatabases(admin);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
    } finally {
      await admin.end();
    }

    const template = new SQL(urlFor(adminUrl, TEMPLATE_DB));
    try {
      await migrate(template);
      // Katalogen hör till schemat i praktiken: varje testfil ärver den ur malldatabasen
      // och slipper betala synken själv.
      await syncGigCatalog(template);
    } finally {
      // Måste stängas: CREATE DATABASE ... TEMPLATE vägrar om någon är ansluten.
      await template.end();
    }

    return { adminUrl };
  })();

  return clusterPromise;
}

export interface TestDatabase {
  url: string;
  sql: SQL;
  /** Stänger anslutningen. Databasen städas bort vid nästa körning. */
  close(): Promise<void>;
}

/**
 * Ger den anropande testfilen en egen databas, kopierad från malldatabasen.
 * Ingen delad state mellan filer, ingen truncate-dans mellan testfall.
 */
export async function freshDatabase(): Promise<TestDatabase> {
  const cluster = await getCluster();
  const name = `test_${process.pid}_${++databaseCounter}`;

  const admin = new SQL(cluster.adminUrl);
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const url = urlFor(cluster.adminUrl, name);
  const sql = new SQL(url);
  return { url, sql, close: () => sql.end() };
}

/** En URL till en databas som garanterat inte går att nå — för 503-vägen i /health. */
export function unreachableDatabaseUrl(): string {
  return 'postgres://test:test@127.0.0.1:1/nowhere';
}
