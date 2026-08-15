import { test, expect } from 'bun:test';
import {
  estimatedTotalMinor,
  fromCompensationColumns,
  toCompensationColumns,
  type Compensation,
} from '../../src/domain/bid-rules.ts';

const fixed: Compensation = { type: 'fixed', amountMinor: 4500000, currency: 'SEK' };
const hourly: Compensation = {
  type: 'hourly',
  rateMinor: 95000,
  estimatedHours: 7.5,
  currency: 'SEK',
};

// ---------------------------------------------------------------- D.1

test('D.1 fastpris ger belopp i fixed-kolumnen och tomma timkolumner', () => {
  expect(toCompensationColumns(fixed)).toEqual({
    compensationType: 'fixed',
    fixedAmountMinor: 4500000,
    hourlyRateMinor: null,
    estimatedHours: null,
    currency: 'SEK',
  });
});

test('D.1 timpris ger rate och timmar, och tom fixed-kolumn', () => {
  expect(toCompensationColumns(hourly)).toEqual({
    compensationType: 'hourly',
    fixedAmountMinor: null,
    hourlyRateMinor: 95000,
    estimatedHours: 7.5,
    currency: 'SEK',
  });
});

test('D.1 ogiltiga belopp avvisas', () => {
  expect(() => toCompensationColumns({ ...fixed, amountMinor: 0 })).toThrow();
  expect(() => toCompensationColumns({ ...fixed, amountMinor: -1 })).toThrow();
  expect(() => toCompensationColumns({ ...hourly, rateMinor: 0 })).toThrow();
  expect(() => toCompensationColumns({ ...hourly, estimatedHours: 0 })).toThrow();
  expect(() => toCompensationColumns({ ...hourly, estimatedHours: -2 })).toThrow();
});

test('D.1 kolumner tillbaka till domänform, med numeric som number', () => {
  expect(
    fromCompensationColumns({
      compensation_type: 'hourly',
      fixed_amount_minor: null,
      hourly_rate_minor: '95000',
      estimated_hours: '7.50',
      currency: 'SEK',
    }),
  ).toEqual(hourly);

  expect(
    fromCompensationColumns({
      compensation_type: 'fixed',
      fixed_amount_minor: '4500000',
      hourly_rate_minor: null,
      estimated_hours: null,
      currency: 'SEK',
    }),
  ).toEqual(fixed);
});

test('D.1 en rad som bryter mot formen kastar istället för att tolkas', () => {
  expect(() =>
    fromCompensationColumns({
      compensation_type: 'fixed',
      fixed_amount_minor: null, // fastpris utan belopp
      hourly_rate_minor: null,
      estimated_hours: null,
      currency: 'SEK',
    }),
  ).toThrow();

  expect(() =>
    fromCompensationColumns({
      compensation_type: 'hourly',
      fixed_amount_minor: null,
      hourly_rate_minor: '95000',
      estimated_hours: null, // timpris utan timmar
      currency: 'SEK',
    }),
  ).toThrow();
});

// ---------------------------------------------------------------- D.2

test('D.2 fastpris är sitt eget totalbelopp', () => {
  expect(estimatedTotalMinor(fixed)).toBe(4500000);
});

test('D.2 timpris multipliceras och avrundas i minorenhet', () => {
  expect(estimatedTotalMinor(hourly)).toBe(712500); // 950,00 kr × 7,5 h
  expect(estimatedTotalMinor({ ...hourly, rateMinor: 33333, estimatedHours: 3 })).toBe(99999);
});

test('D.2 avrundning sker uppåt vid exakt halva ören', () => {
  expect(estimatedTotalMinor({ ...hourly, rateMinor: 333, estimatedHours: 1.5 })).toBe(500);
});

test('D.2 flyttalsdrift ger inte ett krokigt totalbelopp', () => {
  // 10 × 0,3 blir 3.0000000000000004 i flyttal.
  expect(estimatedTotalMinor({ ...hourly, rateMinor: 10, estimatedHours: 0.3 })).toBe(3);
  expect(Number.isSafeInteger(estimatedTotalMinor(hourly))).toBe(true);
});
