import type { Compensation } from './bid-rules.ts';

/**
 * Avtalet som dokument: en ren funktion från frysta villkor till typst-källa.
 *
 * **Ingen databas och ingen klocka här.** Allt dokumentet visar skickas in, och två
 * anrop med samma indata ger samma källa tecken för tecken — det är vad som gör att en
 * omkompilering aldrig kan ge ett annat avtal än det som skickades ut.
 *
 * **Dokumentet är på engelska.** Parterna kan läsa gränssnittet på fem språk, men
 * avtalet har ett språk tills det finns ett svar på vilket språk som gäller vid tvist.
 * Katalogens nycklar översätts av anroparen (`catalog/texts/en-GB.json`) innan de når hit.
 */
export interface DocumentParty {
  organizationName: string;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
}

export interface DocumentQuestion {
  prompt: string;
  answer: string;
}

export interface DocumentCriterion {
  statement: string;
  verification: string | null;
}

export interface ContractDocument {
  contractId: string;
  title: string;
  plan: string;
  compensation: Compensation;
  estimatedTotalMinor: number;
  /** När avtalet blev bindande — den sista av de två signaturerna. */
  agreedAt: Date;
  /** Uppdragstypernas namn, på engelska. */
  gigTypes: string[];
  questions: DocumentQuestion[];
  criteria: DocumentCriterion[];
  buyer: DocumentParty;
  seller: DocumentParty;
}

/** `4500000, 'SEK'` → `45,000.00 SEK`. Minorenheten är alltid hundradelar här. */
export function formatMoney(amountMinor: number, currency: string): string {
  const amount = new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
  return `${amount} ${currency}`;
}

const isoDate = (at: Date): string => at.toISOString().slice(0, 10);

/** `2026-09-11 09:30 UTC`. UTC rakt igenom: en tidszon till vore en tolkning. */
const stamp = (at: Date): string => `${isoDate(at)} ${at.toISOString().slice(11, 16)} UTC`;

/**
 * Fritext → typst-strängliteral.
 *
 * Allt användaren skrivit går in i dokumentet **som en sträng**, aldrig som källkod.
 * Utan det vore en plan som innehåller `#set page(...)` ett sätt att skriva om avtalet.
 * Typst känner bara `\\`, `\"`, `\n`, `\t` och `\u{…}` — övriga styrtecken tas bort
 * hellre än att escapas till något typst inte läser tillbaka.
 */
export function typstString(value: string): string {
  const escaped = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Fritext som flera stycken. En tom rad i indata blir ett styckebyte i dokumentet. */
function paragraphs(value: string, fallback = '—'): string {
  const blocks = value
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter((block) => block !== '');

  if (blocks.length === 0) return `#par(${typstString(fallback)})`;
  return blocks.map((block) => `#par(${typstString(block)})`).join('\n');
}

function compensationRows(doc: ContractDocument): string[][] {
  const { compensation } = doc;
  if (compensation.type === 'fixed') {
    return [
      ['Form', 'Fixed price'],
      ['Price', formatMoney(compensation.amountMinor, compensation.currency)],
    ];
  }

  return [
    ['Form', 'Hourly'],
    ['Rate', `${formatMoney(compensation.rateMinor, compensation.currency)} per hour`],
    ['Estimated hours', String(compensation.estimatedHours)],
    [
      'Estimated total',
      `${formatMoney(doc.estimatedTotalMinor, compensation.currency)} (estimate, not a cap)`,
    ],
  ];
}

const fieldCall = (name: string, value: string): string =>
  `#field(${typstString(name)}, ${typstString(value)})`;

/**
 * Signaturblocket.
 *
 * Namnet skrivs som en signatur och under det står vad som faktiskt binder: vem som
 * tecknade, för vilket företag och när. Det är en **framställning** av signaturen, inte
 * ett kryptografiskt bevis — tills elektronisk signering finns på plats är det
 * tidsstämpeln och identiteten i giggas logg som bär beviset, och det säger dokumentet
 * rakt ut i stället för att låtsas.
 */
function party(role: string, side: DocumentParty): string {
  return `party(${typstString(role)}, ${typstString(side.organizationName)}, ${typstString(
    side.signerName,
  )}, ${typstString(side.signerEmail)})`;
}

function signature(role: string, party: DocumentParty): string {
  return `signature(
  ${typstString(role)},
  ${typstString(party.signerName)},
  ${typstString(party.organizationName)},
  ${typstString(party.signerEmail)},
  ${typstString(stamp(party.signedAt))},
)`;
}

export function contractTypst(doc: ContractDocument): string {
  const questions =
    doc.questions.length === 0
      ? '#par("The requirement interview carries no answers for this assignment.")'
      : doc.questions
          .map(
            (question) =>
              `#qa(${typstString(question.prompt)}, ${typstString(question.answer)})`,
          )
          .join('\n');

  const criteria =
    doc.criteria.length === 0
      ? '#par("No acceptance criteria were recorded.")'
      : `#enum(\n${doc.criteria
          .map(
            (criterion) =>
              `  criterion(${typstString(criterion.statement)}, ${
                criterion.verification === null
                  ? 'none'
                  : typstString(criterion.verification)
              }),`,
          )
          .join('\n')}\n)`;

  const compensation = compensationRows(doc)
    .map(([name, value]) => fieldCall(name!, value!))
    .join('\n');

  return `// Generated by gigga. Contract ${doc.contractId}.
#set document(title: ${typstString(doc.title)}, author: "gigga")
#set page(
  paper: "a4",
  margin: (x: 2.4cm, y: 2.2cm),
  footer: context align(center, text(size: 8pt, fill: luma(40%))[
    Contract ${doc.contractId} · page #counter(page).display() of #counter(page).final().first()
  ]),
)
#set text(size: 10.5pt, lang: "en")
#set par(justify: true, leading: 0.62em, spacing: 0.9em)
#show heading: set text(size: 11pt)
#show heading: set block(above: 1.6em, below: 0.8em)

#let caption(body) = text(size: 8pt, weight: "bold", fill: luma(35%), tracking: 0.08em)[#upper(body)]
#let field(name, value) = grid(
  columns: (3.6cm, 1fr),
  row-gutter: 0.45em,
  caption(name), [#value],
)
#let qa(prompt, answer) = block(
  width: 100%,
  breakable: false,
  inset: (left: 0pt, y: 0.35em),
)[
  #text(weight: "semibold")[#prompt]
  #v(-0.45em)
  #par(answer)
]
#let criterion(statement, verification) = [
  #statement
  #if verification != none [
    #v(-0.5em)
    #text(size: 9pt, fill: luma(35%))[Verified by: #verification]
  ]
]
#let masthead(title, agreed) = align(center)[
  #caption("Assignment contract")
  #v(0.4em)
  #text(size: 17pt, weight: "bold")[#title]
  #v(0.3em)
  #text(size: 9pt, fill: luma(35%))[Agreed #agreed · gigga]
]
#let party(role, company, name, email) = [
  #caption(role)
  #v(0.3em)
  #text(weight: "semibold")[#company] \\
  #name \\
  #text(size: 9pt)[#email]
]
#let signature(role, name, company, email, at) = block(
  width: 100%,
  breakable: false,
)[
  #caption(role)
  #v(0.2em)
  #text(size: 17pt, style: "italic")[#name]
  #v(0.1em)
  #line(length: 7.5cm, stroke: 0.4pt + luma(50%))
  #v(0.2em)
  #text(size: 9pt)[#name, #company \\ #email \\ Signed #at]
]

#masthead(${typstString(doc.title)}, ${typstString(stamp(doc.agreedAt))})

#v(1.2em)

#grid(
  columns: (1fr, 1fr),
  column-gutter: 1.2cm,
  ${party('Buyer', doc.buyer)},
  ${party('Supplier', doc.seller)},
)

= 1. The assignment

${fieldCall('Assignment', doc.title)}
${fieldCall('Type', doc.gigTypes.length === 0 ? 'Not categorised' : doc.gigTypes.join(', '))}
${fieldCall('Agreed', stamp(doc.agreedAt))}

#v(0.6em)
#caption("The supplier's plan")
#v(0.3em)
${paragraphs(doc.plan, 'No plan was recorded with the bid.')}

= 2. Compensation

${compensation}

= 3. Requirements

The buyer answered the following about the assignment before bids were invited. The
answers are part of what the supplier committed to.

${questions}

= 4. Acceptance criteria

The assignment is complete when the following hold. Each criterion is written to be
answerable with yes or no.

${criteria}

= 5. The agreement

#par("This contract is formed by the two signatures below and rests on the terms as they stood when the buyer signed. A bid changed afterwards does not change this contract.")
#par("The signatures are rendered from the record kept by gigga: who signed, for which company, and when. Electronic signing is not yet in place, so the proof is that record and not a cryptographic seal on this file.")

#v(1.6em)

#grid(
  columns: (1fr, 1fr),
  column-gutter: 1.2cm,
  ${signature('Buyer', doc.buyer)},
  ${signature('Supplier', doc.seller)},
)
`;
}

/** Tecken som aldrig får stå i ett filnamn, oavsett filsystem eller webbläsare. */
const UNSAFE_IN_FILENAME = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;

const MAX_TITLE_CHARS = 70;

function tidy(value: string, max = MAX_TITLE_CHARS): string {
  const cleaned = value.replace(UNSAFE_IN_FILENAME, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/**
 * Namnet nedladdningen får: uppdrag, datum och parterna.
 *
 * Den som sparar tio avtal ska kunna hitta ett av dem i en filkatalog utan att öppna
 * något. Därför titeln först, och `and` i stället för `&` — tecknet är inte otillåtet
 * men gör filnamnet bökigt i ett skal.
 */
export function contractFilename(doc: ContractDocument): string {
  const parties = `${tidy(doc.buyer.organizationName, 40)} and ${tidy(
    doc.seller.organizationName,
    40,
  )}`;
  return `${tidy(doc.title)} - ${isoDate(doc.agreedAt)} - ${parties}.pdf`;
}

/**
 * Ett intervjusvar som en mening i dokumentet.
 *
 * Svaren ligger som JSON i den form frågans typ kräver: ett booleskt värde för `bool`,
 * en alternativnyckel för `choice`, en lista av nycklar för `multichoice`. Nycklarna är
 * inte läsbara — `realtime` säger ingenting i ett avtal — så alternativens etiketter
 * slås upp, och de är i sin tur katalognycklar som `translate` gör engelska av.
 */
export function formatAnswer(
  question: { kind: string; options: { key: string; label: string }[] },
  value: unknown,
  translate: (key: string) => string,
): string {
  const label = (key: string): string => {
    const option = question.options.find((candidate) => candidate.key === key);
    return option ? translate(option.label) : key;
  };

  if (value === null || value === undefined || value === '') return 'Not answered';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.length === 0 ? 'Not answered' : value.map((item) => label(String(item))).join(', ');
  }
  if (question.options.length > 0) return label(String(value));
  return String(value);
}
