import { test, expect } from 'bun:test';
import { fromMinorColumn, toMinorColumn } from '../../src/domain/money.ts';

// D.4
test('D.4 bigint från Bun.SQL kommer som string och mappas till number', () => {
  expect(fromMinorColumn('4500000')).toBe(4500000);
  expect(typeof fromMinorColumn('4500000')).toBe('number');
});

// D.4
test('D.4 null och undefined förblir null', () => {
  expect(fromMinorColumn(null)).toBeNull();
  expect(fromMinorColumn(undefined)).toBeNull();
});

// D.4
test('D.4 ett belopp utanför säkra heltal kastar istället för att tyst tappa precision', () => {
  const tooBig = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);

  expect(() => fromMinorColumn(tooBig)).toThrow(/säkert heltal/);
});

// D.4
test('D.4 skräp i kolumnen kastar', () => {
  expect(() => fromMinorColumn('inte-ett-tal')).toThrow();
});

// D.4
test('D.4 toMinorColumn kräver ett positivt heltal', () => {
  expect(toMinorColumn(1)).toBe(1);
  expect(() => toMinorColumn(0)).toThrow();
  expect(() => toMinorColumn(-1)).toThrow();
  expect(() => toMinorColumn(1.5)).toThrow();
});
