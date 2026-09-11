import { test, expect } from 'bun:test';
import {
  contractFilename,
  contractTypst,
  formatAnswer,
  formatMoney,
  type ContractDocument,
} from '../../src/domain/contract-document.ts';

const signedAt = new Date('2026-09-11T09:30:00.000Z');

function doc(overrides: Partial<ContractDocument> = {}): ContractDocument {
  return {
    contractId: '7f1c6b52-1d3a-4f1e-9c2f-8a0b5d2e4c31',
    title: 'Nightly export to the warehouse',
    plan: 'Survey, build, handover.',
    compensation: { type: 'fixed', amountMinor: 4500000, currency: 'SEK' },
    estimatedTotalMinor: 4500000,
    agreedAt: signedAt,
    gigTypes: ['Automation or scheduled job'],
    questions: [
      { prompt: 'What is handed over?', answer: 'A repository and a runbook.' },
      { prompt: 'Is a rerun allowed?', answer: 'Yes' },
    ],
    criteria: [
      {
        statement: 'The job runs on schedule without manual steps.',
        verification: 'Observed over three consecutive nights.',
      },
      { statement: 'Failures raise an alert.', verification: null },
    ],
    buyer: {
      organizationName: 'Nordvind Bygg',
      signerName: 'Kim Buyer',
      signerEmail: 'kim@nordvind.test',
      signedAt: new Date('2026-09-10T14:00:00.000Z'),
    },
    seller: {
      organizationName: 'Sydlig Teknik',
      signerName: 'Robin Seller',
      signerEmail: 'robin@sydlig.test',
      signedAt,
    },
    ...overrides,
  };
}

test('K.1 typst-källan bär parterna, uppdraget, priset och båda signaturerna', () => {
  const source = contractTypst(doc());

  expect(source).toContain('Nightly export to the warehouse');
  expect(source).toContain('Nordvind Bygg');
  expect(source).toContain('Sydlig Teknik');
  expect(source).toContain('Kim Buyer');
  expect(source).toContain('Robin Seller');
  expect(source).toContain('45,000.00 SEK');
  // Signaturblocken bär namn, företag och tidsstämpel.
  expect(source).toContain('2026-09-10 14:00 UTC');
  expect(source).toContain('2026-09-11 09:30 UTC');
  // Dokumentet är på engelska oavsett vem som läser det.
  expect(source).toContain('Buyer');
  expect(source).toContain('Supplier');
});

test('K.2 intervjuns frågor och svar samt acceptanskriterierna följer med', () => {
  const source = contractTypst(doc());

  expect(source).toContain('What is handed over?');
  expect(source).toContain('A repository and a runbook.');
  expect(source).toContain('The job runs on schedule without manual steps.');
  expect(source).toContain('Observed over three consecutive nights.');
  expect(source).toContain('Failures raise an alert.');
});

test('K.3 citattecken och bakstreck i fritext bryter inte ut ur källan', () => {
  const source = contractTypst(
    doc({
      plan: 'Kör "allt" i C:\\jobb #set page(paper: "a3")',
      title: 'A #heading[hack] attempt',
    }),
  );

  // Fritexten ligger som strängliteraler: inget av den blir typst-kod.
  expect(source).toContain('\\"allt\\"');
  expect(source).toContain('C:\\\\jobb');
  expect(source).not.toMatch(/^#set page\(paper: "a3"\)/m);
});

test('K.4 filnamnet bär uppdragstitel, datum och parterna', () => {
  expect(contractFilename(doc())).toBe(
    'Nightly export to the warehouse - 2026-09-11 - Nordvind Bygg and Sydlig Teknik.pdf',
  );
});

test('K.5 filnamnet tål snedstreck, radbrytningar och en lång titel', () => {
  const name = contractFilename(
    doc({ title: `Migration: /etc/passwd\n\tand\\back — ${'x'.repeat(200)}` }),
  );

  expect(name).not.toContain('/');
  expect(name).not.toContain('\\');
  expect(name).not.toContain('\n');
  expect(name.length).toBeLessThanOrEqual(160);
  expect(name.endsWith('.pdf')).toBe(true);
  expect(name).toContain('Nordvind Bygg and Sydlig Teknik');
});

test('K.6 löpande ersättning visar timpris, timmar och uppskattad summa', () => {
  const source = contractTypst(
    doc({
      compensation: { type: 'hourly', rateMinor: 95000, estimatedHours: 7.5, currency: 'SEK' },
      estimatedTotalMinor: 712500,
    }),
  );

  expect(source).toContain('950.00 SEK');
  expect(source).toContain('7.5');
  expect(source).toContain('7,125.00 SEK');
});

test('K.7 belopp formateras i minorenhet med två decimaler', () => {
  expect(formatMoney(4500000, 'SEK')).toBe('45,000.00 SEK');
  expect(formatMoney(0, 'SEK')).toBe('0.00 SEK');
  expect(formatMoney(1, 'EUR')).toBe('0.01 EUR');
});

test('K.8 svaren blir läsbara meningar, inte alternativnycklar', () => {
  const en = (key: string) => (key === 'option.realtime' ? 'In real time' : key);
  const choice = { kind: 'choice', options: [{ key: 'realtime', label: 'option.realtime' }] };

  expect(formatAnswer(choice, 'realtime', en)).toBe('In real time');
  expect(formatAnswer({ kind: 'bool', options: [] }, true, en)).toBe('Yes');
  expect(formatAnswer({ kind: 'bool', options: [] }, false, en)).toBe('No');
  expect(formatAnswer({ kind: 'text', options: [] }, 'A runbook', en)).toBe('A runbook');
  expect(formatAnswer({ kind: 'integer', options: [] }, 3, en)).toBe('3');
  expect(
    formatAnswer(
      { kind: 'multichoice', options: [{ key: 'realtime', label: 'option.realtime' }] },
      ['realtime', 'nightly'],
      en,
    ),
  ).toBe('In real time, nightly');
  expect(formatAnswer(choice, null, en)).toBe('Not answered');
});
