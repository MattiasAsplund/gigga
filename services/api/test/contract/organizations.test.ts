import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, colleagueOf, type Actor } from '../helpers/actors.ts';
import { publishSpecFor } from '../helpers/spec.ts';

/**
 * FTG — organisationen som part.
 *
 * Det som prövas här är skillnaden mot förut: behörighet avgörs av vilket företag man
 * hör till, inte av vem som råkade trycka på knappen. Varje fall har en kollega i sig —
 * utan den vore det inget som skiljer från den gamla modellen.
 */
let t: TestApp;
let kim: Actor;
let kollega: Actor;
let robin: Actor;

beforeAll(async () => {
  t = await buildTestApp();
  kim = await actor(t.app, 'kim');
  kollega = await colleagueOf(t.app, kim, 'lo');
  robin = await actor(t.app, 'robin');
});

afterAll(async () => {
  await t.close();
});

const inFuture = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

async function requestFrom(who: Actor): Promise<string> {
  const res = await who.post('/api/v1/requests', {
    title: 'Uppdrag för organisationens räkning',
    description: 'Distansuppdrag med tydlig avgränsning.',
    compensationPref: 'any',
    deadlineAt: inFuture(30),
  });
  if (res.statusCode !== 201) throw new Error(`Kunde inte skapa förfrågan: ${res.body}`);
  const id = res.json<{ id: string }>().id;
  await publishSpecFor(t.sql, id);
  return id;
}

const anbud = {
  plan: 'Jag börjar med en kartläggning, levererar i tre steg och testar löpande.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

// ---------------------------------------------------------------- FTG.1

test('FTG.1 kollegor delar organisation, motparter gör det inte', async () => {
  expect(kollega.organizationId).toBe(kim.organizationId);
  expect(robin.organizationId).not.toBe(kim.organizationId);
  // Men de är fortfarande skilda personer, med var sin rad.
  expect(kollega.id).not.toBe(kim.id);
});

// ---------------------------------------------------------------- FTG.2

test('FTG.2 kollegan ser organisationens förfrågningar bland "mina"', async () => {
  const requestId = await requestFrom(kim);

  const mina = await kollega.get('/api/v1/me/requests');
  expect(mina.statusCode).toBe(200);
  const ids = mina.json<{ items: { id: string }[] }>().items.map((r) => r.id);
  expect(ids).toContain(requestId);

  // Och motparten ser den inte som sin.
  const andras = await robin.get('/api/v1/me/requests');
  expect(andras.json<{ items: { id: string }[] }>().items.map((r) => r.id)).not.toContain(requestId);
});

// ---------------------------------------------------------------- FTG.3

test('FTG.3 kollegan kan inte lämna anbud på den egna organisationens förfrågan', async () => {
  const requestId = await requestFrom(kim);

  const res = await kollega.post(`/api/v1/requests/${requestId}/bids`, anbud);

  // Samma spärr som för köparen själv: man bjuder inte på sig själv.
  expect(res.statusCode).toBe(403);
  expect(res.json<{ type: string }>().type).toContain('own-request');
});

// ---------------------------------------------------------------- FTG.4

test('FTG.4 ett aktivt anbud per organisation, inte per person', async () => {
  const requestId = await requestFrom(kim);
  const robinsKollega = await colleagueOf(t.app, robin, 'robins-kollega');

  const first = await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);
  expect(first.statusCode).toBe(201);

  // Kollegan lämnar ett till för samma företag — ett företag talar med en röst.
  const second = await robinsKollega.post(`/api/v1/requests/${requestId}/bids`, anbud);
  expect(second.statusCode).toBe(409);
});

// ---------------------------------------------------------------- FTG.5

test('FTG.5 kollegan får ändra organisationens anbud', async () => {
  const requestId = await requestFrom(kim);
  const robinsKollega = await colleagueOf(t.app, robin, 'robins-andra-kollega');

  const created = await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);
  expect(created.statusCode).toBe(201);
  const bidId = created.json<{ id: string }>().id;

  const changed = await robinsKollega.patch(`/api/v1/bids/${bidId}`, {
    plan: 'Omskriven av en kollega som tog över ärendet.',
  });
  expect(changed.statusCode).toBe(200);
});

// ---------------------------------------------------------------- FTG.6

test('FTG.6 läsrätt till en kollega avvisas — medlemskapet räcker redan', async () => {
  const requestId = await requestFrom(kim);

  const res = await kim.post(`/api/v1/requests/${requestId}/permissions`, {
    email: kollega.email,
  });

  expect(res.statusCode).toBe(422);
  expect(res.json<{ detail: string }>().detail).toContain('medlemskap');
});

// ---------------------------------------------------------------- FTG.7

test('FTG.7 läsrätt över företagsgränsen fungerar fortfarande', async () => {
  const requestId = await requestFrom(kim);

  const granted = await kim.post(`/api/v1/requests/${requestId}/permissions`, {
    email: robin.email,
  });
  expect(granted.statusCode).toBe(201);
});

// ---------------------------------------------------------------- FTG.8

test('FTG.8 kollegan ser alla anbud på organisationens förfrågan, motparten bara sitt eget', async () => {
  const requestId = await requestFrom(kim);
  await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);

  const somKollega = await kollega.get(`/api/v1/requests/${requestId}`);
  expect(somKollega.statusCode).toBe(200);
  expect(somKollega.json<{ bids: unknown[] }>().bids).toHaveLength(1);

  // En utomstående säljare utan eget anbud ser inga.
  const utomstaende = await actor(t.app, 'utomstaende');
  const somUtomstaende = await utomstaende.get(`/api/v1/requests/${requestId}`);
  expect(somUtomstaende.json<{ bids: unknown[] }>().bids).toHaveLength(0);
});

// ---------------------------------------------------------------- FTG.9

test('FTG.9 kollegan på köparsidan kan signera avtalet', async () => {
  const requestId = await requestFrom(kim);
  const created = await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);
  const bidId = created.json<{ id: string }>().id;

  // Kim skapade förfrågan; kollegan tecknar. Parten är företaget.
  const signed = await kollega.post(`/api/v1/bids/${bidId}/contract/signatures`);
  expect(signed.statusCode).toBe(200);
  expect(signed.json<{ status: string }>().status).toBe('pending_signatures');
});

// ---------------------------------------------------------------- FTG.10

test('FTG.10 en utomstående organisation är inte part och får inte signera', async () => {
  const requestId = await requestFrom(kim);
  const created = await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);
  const bidId = created.json<{ id: string }>().id;
  await kim.post(`/api/v1/bids/${bidId}/contract/signatures`);

  const utomstaende = await actor(t.app, 'tredje-part');
  const res = await utomstaende.post(`/api/v1/bids/${bidId}/contract/signatures`);

  expect(res.statusCode).toBe(403);
});

// ---------------------------------------------------------------- FTG.11

test('FTG.11 katalogen räknar organisationens anbud som "mitt"', async () => {
  const requestId = await requestFrom(kim);
  const robinsKollega = await colleagueOf(t.app, robin, 'katalog-kollega');
  await robin.post(`/api/v1/requests/${requestId}/bids`, anbud);

  const katalog = await robinsKollega.get('/api/v1/requests');
  const rad = katalog
    .json<{ items: { id: string; hasMyBid: boolean; canBid: boolean }[] }>()
    .items.find((r) => r.id === requestId);

  expect(rad?.hasMyBid).toBe(true);
  expect(rad?.canBid).toBe(false);
});
