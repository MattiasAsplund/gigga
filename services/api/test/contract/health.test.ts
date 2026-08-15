import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, buildTestAppWithBrokenDatabase, type TestApp } from '../helpers/app.ts';
import { unreachableDatabaseUrl } from '../helpers/postgres.ts';

interface HealthBody {
  status: string;
  database: string;
}

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.close();
});

// X.3
test('X.3 /health svarar 200 när databasen är nåbar', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/health' });

  expect(res.statusCode).toBe(200);
  expect(res.json<HealthBody>()).toEqual({ status: 'ok', database: 'up' });
});

// X.3
test('X.3 /health svarar 503 när databasen inte går att nå', async () => {
  const broken = await buildTestAppWithBrokenDatabase(unreachableDatabaseUrl());
  try {
    const res = await broken.app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json<HealthBody>()).toEqual({ status: 'degraded', database: 'down' });
  } finally {
    await broken.close();
  }
});
