import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';
import { actor, type Actor } from '../helpers/actors.ts';
import { publishSpecFor } from '../helpers/spec.ts';

let ctx: TestApp;
let buyer: Actor;
let seller: Actor;
let stranger: Actor;

beforeAll(async () => {
  ctx = await buildTestApp();
  buyer = await actor(ctx.app, 'kopare');
  seller = await actor(ctx.app, 'saljare');
  stranger = await actor(ctx.app, 'utomstaende');
});

afterAll(async () => {
  await ctx.close();
});

const signUrl = (bidId: string) => `/api/v1/bids/${bidId}/contract/signatures`;
const documentUrl = (contractId: string) => `/api/v1/contracts/${contractId}/document`;

const bid = {
  plan: 'Kartläggning, bygge, överlämning.',
  compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
};

/** Förfrågan med publicerad kravspec och ett anbud från `seller`. */
async function setup(title = 'Nattlig export till lagret'): Promise<{ bidId: string }> {
  const created = await buyer.post('/api/v1/requests', {
    title,
    description: 'Distansuppdrag.',
    compensationPref: 'any',
  });
  if (created.statusCode !== 201) throw new Error(`skapa förfrågan: ${created.body}`);

  const requestId = created.json<{ id: string }>().id;
  await publishSpecFor(ctx.sql, requestId);

  const placed = await seller.post(`/api/v1/requests/${requestId}/bids`, bid);
  if (placed.statusCode !== 201) throw new Error(`lämna anbud: ${placed.body}`);

  return { bidId: placed.json<{ id: string }>().id };
}

/** Båda signaturerna. Returnerar avtalets id. */
async function signBoth(bidId: string): Promise<string> {
  const first = await buyer.post(signUrl(bidId));
  if (first.statusCode !== 200) throw new Error(`köparens signatur: ${first.body}`);
  const second = await seller.post(signUrl(bidId));
  if (second.statusCode !== 200) throw new Error(`säljarens signatur: ${second.body}`);
  return second.json<{ contractId: string }>().contractId;
}

test('K.9 andra signaturen lägger dokumentet i lagringen', async () => {
  const { bidId } = await setup();
  const before = ctx.mail.sent.length;

  const contractId = await signBoth(bidId);

  const stored = ctx.objects.objects.get(`contracts/${contractId}`);
  expect(stored).toBeDefined();
  expect(stored!.contentType).toBe('application/pdf');
  expect(new TextDecoder().decode(stored!.content)).toContain('%PDF');

  const rows = (await ctx.sql`
    SELECT document_key, document_filename, document_generated_at,
           buyer_signed_by, seller_signed_by
    FROM contracts WHERE id = ${contractId}
  `) as {
    document_key: string | null;
    document_filename: string | null;
    document_generated_at: Date | null;
    buyer_signed_by: string | null;
    seller_signed_by: string | null;
  }[];

  const row = rows[0]!;
  expect(row.document_key).toBe(`contracts/${contractId}`);
  expect(row.document_filename).toContain('Nattlig export till lagret');
  expect(row.document_generated_at).not.toBeNull();
  // Vem som höll i pennan, inte bara vilket företag som är part.
  expect(row.buyer_signed_by).toBe(buyer.id);
  expect(row.seller_signed_by).toBe(seller.id);

  expect(ctx.mail.sent.length).toBe(before + 2);
});

test('K.10 båda parterna får ett brev med länken till dokumentet', async () => {
  const { bidId } = await setup('Avtal att posta om');
  const before = ctx.mail.sent.length;

  const contractId = await signBoth(bidId);

  const sent = ctx.mail.sent.slice(before);
  expect(sent.map((mail) => mail.to).sort()).toEqual([buyer.email, seller.email].sort());
  for (const mail of sent) {
    expect(mail.text).toContain(`http://gigga.test/contracts/${contractId}/document`);
    expect(mail.subject).toContain('Avtal att posta om');
  }
});

test('K.11 köparen laddar ner avtalet som PDF med talande filnamn', async () => {
  const { bidId } = await setup('Nattlig export till lagret');
  const contractId = await signBoth(bidId);

  const res = await buyer.get(documentUrl(contractId));

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  const disposition = String(res.headers['content-disposition']);
  expect(disposition).toStartWith('attachment;');
  expect(disposition).toContain('Nattlig export till lagret');
  expect(disposition).toContain(new Date().toISOString().slice(0, 10));
  expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
});

test('K.12 säljaren får samma byten — dokumentet kompileras inte om', async () => {
  const { bidId } = await setup();
  const contractId = await signBoth(bidId);
  const compiledAfterSigning = ctx.typst.compiled.length;

  const first = await buyer.get(documentUrl(contractId));
  const second = await seller.get(documentUrl(contractId));

  expect(second.statusCode).toBe(200);
  expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
  expect(ctx.typst.compiled.length).toBe(compiledAfterSigning);
});

test('K.13 utomstående kommer inte åt dokumentet', async () => {
  const { bidId } = await setup();
  const contractId = await signBoth(bidId);

  const res = await stranger.get(documentUrl(contractId));

  expect(res.statusCode).toBe(403);
  expect(res.json<{ type: string }>().type).toContain('not-a-party');
});

test('K.14 okänt avtal ger 404 och utan token 401', async () => {
  const missing = await buyer.get(documentUrl('8f5d1a2b-0000-4000-8000-000000000000'));
  expect(missing.statusCode).toBe(404);

  const { bidId } = await setup();
  const contractId = await signBoth(bidId);
  const anonymous = await ctx.app.inject({ method: 'GET', url: documentUrl(contractId) });
  expect(anonymous.statusCode).toBe(401);
});

test('K.15 ett halvsignerat avtal har inget dokument ännu ⇒ 409', async () => {
  const { bidId } = await setup();
  const signed = await buyer.post(signUrl(bidId));
  const contractId = signed.json<{ contractId: string }>().contractId;

  const res = await buyer.get(documentUrl(contractId));

  expect(res.statusCode).toBe(409);
  expect(res.json<{ type: string }>().type).toContain('contract-not-active');
});

test('K.16 motorn nere vid signeringen hindrar inte avtalet — dokumentet skrivs vid nedladdningen', async () => {
  const { bidId } = await setup();
  const before = ctx.mail.sent.length;
  ctx.typst.failWith(new Error('typst svarar inte'));

  const contractId = await signBoth(bidId);

  // Breven går ut ändå: länken är vägen till dokumentet, och den sätter det vid behov.
  // Ett uteblivet brev hade lämnat båda parter ovetande om att avtalet gäller.
  expect(ctx.mail.sent.length).toBe(before + 2);

  // Avtalet är aktivt trots att dokumentet inte gick att skriva.
  const rows = (await ctx.sql`
    SELECT status, document_key FROM contracts WHERE id = ${contractId}
  `) as { status: string; document_key: string | null }[];
  expect(rows[0]!.status).toBe('active');
  expect(rows[0]!.document_key).toBeNull();

  ctx.typst.failWith(null);
  const res = await buyer.get(documentUrl(contractId));

  expect(res.statusCode).toBe(200);
  expect(ctx.objects.objects.has(`contracts/${contractId}`)).toBe(true);
});

test('K.17 dokumentet bär kravspecens kriterier på engelska, inte katalogens nycklar', async () => {
  const { bidId } = await setup();
  const contractId = await signBoth(bidId);

  const source = ctx.typst.compiled.at(-1)!;

  expect(source).toContain('The code can be started from a clean state');
  expect(source).not.toContain('clause.base.clean-start.statement');
});
