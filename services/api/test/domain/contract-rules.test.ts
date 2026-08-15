import { test, expect } from 'bun:test';
import { applySignature, type SignatureState } from '../../src/domain/contract-rules.ts';

const T1 = new Date('2026-03-01T10:00:00.000Z');
const T2 = new Date('2026-03-02T11:00:00.000Z');

const pending = (over: Partial<SignatureState> = {}): SignatureState => ({
  status: 'pending_signatures',
  buyerSignedAt: null,
  sellerSignedAt: null,
  ...over,
});

// D.3
test('D.3 köparens signatur på ett osignerat avtal sätter tidsstämpeln men aktiverar inte', () => {
  expect(applySignature(pending(), 'buyer', T1)).toEqual({
    status: 'pending_signatures',
    buyerSignedAt: T1,
    sellerSignedAt: null,
  });
});

// D.3
test('D.3 den andra signaturen aktiverar avtalet', () => {
  const afterBuyer = applySignature(pending(), 'buyer', T1);

  expect(applySignature(afterBuyer, 'seller', T2)).toEqual({
    status: 'active',
    buyerSignedAt: T1,
    sellerSignedAt: T2,
  });
});

// D.3
test('D.3 ordningen spelar ingen roll för slutläget', () => {
  const sellerFirst = applySignature(applySignature(pending(), 'seller', T1), 'buyer', T2);

  expect(sellerFirst).toEqual({
    status: 'active',
    buyerSignedAt: T2,
    sellerSignedAt: T1,
  });
});

// D.3
test('D.3 samma part igen ändrar ingenting — inte heller tidsstämpeln', () => {
  const afterBuyer = applySignature(pending(), 'buyer', T1);

  expect(applySignature(afterBuyer, 'buyer', T2)).toEqual(afterBuyer);
});

// D.3
test('D.3 en signatur på ett aktivt avtal ändrar ingenting', () => {
  const active = applySignature(applySignature(pending(), 'buyer', T1), 'seller', T1);

  expect(applySignature(active, 'buyer', T2)).toEqual(active);
  expect(applySignature(active, 'seller', T2)).toEqual(active);
});

// D.3
test('D.3 ett ogiltigförklarat avtal går inte att signera', () => {
  expect(() => applySignature(pending({ status: 'void' }), 'buyer', T1)).toThrow(/void/i);
});

// D.3
test('D.3 funktionen muterar inte sin indata', () => {
  const before = pending();
  applySignature(before, 'buyer', T1);

  expect(before).toEqual(pending());
});
