import { test, expect } from 'bun:test';
import { createRateLimiter } from '../../src/domain/rate-limit.ts';

/**
 * Fast fönster, ingen klocka inuti: tiden kommer in som argument, så tester slipper
 * vänta och beteendet vid fönsterbyte går att slå fast exakt.
 */
const T0 = Date.parse('2026-08-17T12:00:00.000Z');

test('D.5 fönstret släpper igenom upp till gränsen och nekar därefter', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

  expect(limiter.hit('a', T0).allowed).toBe(true);
  expect(limiter.hit('a', T0).allowed).toBe(true);
  expect(limiter.hit('a', T0).allowed).toBe(true);

  const fourth = limiter.hit('a', T0);
  expect(fourth.allowed).toBe(false);
  expect(fourth.retryAfterSeconds).toBe(60);
});

test('D.5 nycklar räknas var för sig', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

  expect(limiter.hit('a', T0).allowed).toBe(true);
  expect(limiter.hit('a', T0).allowed).toBe(false);
  // En annan anropare påverkas inte av att den första slagit i taket.
  expect(limiter.hit('b', T0).allowed).toBe(true);
});

test('D.5 fönstret öppnar igen när det löpt ut', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

  expect(limiter.hit('a', T0).allowed).toBe(true);
  expect(limiter.hit('a', T0 + 59_999).allowed).toBe(false);
  expect(limiter.hit('a', T0 + 60_000).allowed).toBe(true);
});

test('D.5 retryAfterSeconds räknar ned mot fönstrets slut, aldrig till noll', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  limiter.hit('a', T0);

  expect(limiter.hit('a', T0 + 10_000).retryAfterSeconds).toBe(50);
  // Delsekunder rundas uppåt: 0 hade betytt "försök igen nu", vilket vore osant.
  expect(limiter.hit('a', T0 + 59_500).retryAfterSeconds).toBe(1);
});

test('D.5 utgångna nycklar städas bort i stället för att ligga kvar', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

  for (let i = 0; i < 100; i++) limiter.hit(`ip-${i}`, T0);
  expect(limiter.size()).toBe(100);

  // Ett anrop efter fönstret får kartan att göra sig av med det gamla — annars växer
  // den obegränsat av just den trafik gränsen finns för att stoppa.
  limiter.hit('sen', T0 + 60_001);
  expect(limiter.size()).toBe(1);
});
