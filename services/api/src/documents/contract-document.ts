import type { SQL } from 'bun';
import { englishTexts } from '../catalog/texts.ts';
import { findTemplatesByKeys } from '../db/gig-catalog.ts';
import { findIdentityById } from '../db/identities.ts';
import { findBidById } from '../db/bids.ts';
import {
  getSpec,
  loadSpecInterview,
  type RequestSpec,
} from '../db/request-specs.ts';
import { saveDocumentRef, type Contract } from '../db/contracts.ts';
import {
  contractFilename,
  contractTypst,
  formatAnswer,
  type ContractDocument,
  type DocumentParty,
  type DocumentQuestion,
} from '../domain/contract-document.ts';
import type { ObjectStore } from '../storage/object-store.ts';
import type { TypstCompiler } from '../typst/compiler.ts';

/** Ett avtal, ett dokument. Nyckeln bär inte filnamnet — namnet får ändras, objektet inte. */
export const contractDocumentKey = (contractId: string): string => `contracts/${contractId}`;

export interface DocumentDeps {
  sql: SQL;
  objects: ObjectStore;
  typst: TypstCompiler;
}

async function partyOf(
  sql: SQL,
  signedBy: string | null,
  fallbackUserId: string,
  signedAt: Date,
): Promise<DocumentParty> {
  // `buyer_signed_by` saknas bara för avtal skrivna före 019. Då är den som skapade
  // förfrågan respektive lade anbudet det närmaste sanningen som finns.
  const identity = await findIdentityById(sql, signedBy ?? fallbackUserId);

  return {
    organizationName: identity?.organizationName ?? 'Unknown organisation',
    signerName: identity?.displayName ?? 'Unknown signatory',
    signerEmail: identity?.email ?? '',
    signedAt,
  };
}

/** Intervjuns frågor och svar, i intervjuns ordning och utan de obesvarade. */
async function questionsOf(
  sql: SQL,
  spec: RequestSpec | null,
  translate: (key: string) => string,
): Promise<DocumentQuestion[]> {
  if (!spec) return [];

  const interview = await loadSpecInterview(sql, spec.version.id);
  const answers = new Map(spec.answers.map((answer) => [answer.questionKey, answer.value]));

  return interview
    .filter((question) => answers.has(question.key))
    .map((question) => ({
      prompt: translate(question.prompt),
      answer: formatAnswer(question, answers.get(question.key), translate),
    }));
}

/**
 * Avtalets innehåll, hämtat ur databasen och översatt till engelska.
 *
 * Villkoren kommer ur `terms` och inte ur anbudet: anbudet får ändras efteråt, avtalet
 * inte. Kravspecen hämtas via **anbudets** versionsid och inte via förfrågans senaste —
 * det är den lydelse säljaren bjöd mot som avtalet handlar om.
 */
export async function collectContractDocument(
  sql: SQL,
  contract: Contract,
): Promise<ContractDocument> {
  const translate = await englishTexts();
  const { terms } = contract;

  const bid = await findBidById(sql, contract.bidId);
  const spec = bid?.specVersionId ? await getSpec(sql, bid.specVersionId) : null;

  const templates = spec ? await findTemplatesByKeys(sql, spec.typeKeys) : [];

  const [buyer, seller] = await Promise.all([
    partyOf(sql, contract.buyerSignedBy, terms.buyerId, contract.buyerSignedAt ?? contract.createdAt),
    partyOf(
      sql,
      contract.sellerSignedBy,
      terms.sellerId,
      contract.sellerSignedAt ?? contract.createdAt,
    ),
  ]);

  const signatures = [contract.buyerSignedAt, contract.sellerSignedAt].filter(
    (at): at is Date => at !== null,
  );

  return {
    contractId: contract.id,
    title: terms.requestTitle,
    plan: terms.plan,
    compensation: terms.compensation,
    estimatedTotalMinor: terms.estimatedTotalMinor,
    // Avtalet är slutet när den *sista* signaturen faller, inte den första.
    agreedAt: new Date(Math.max(...signatures.map((at) => at.getTime()), contract.createdAt.getTime())),
    gigTypes: templates.map((template) => translate(template.name)),
    questions: await questionsOf(sql, spec, translate),
    criteria: (spec?.criteria ?? []).map((criterion) => ({
      statement: translate(criterion.statement),
      verification: criterion.verification === null ? null : translate(criterion.verification),
    })),
    buyer,
    seller,
  };
}

export interface StoredContractDocument {
  key: string;
  filename: string;
  content: Uint8Array;
}

/**
 * Kompilerar avtalet och lägger det i lagringen.
 *
 * Ordningen är inte godtycklig: objektet först, raden sedan. Faller tjänsten mellan de
 * två blir följden ett objekt utan rad — skräp som sopjobbet inte rör och nästa
 * nedladdning skriver över — i stället för en rad som pekar på ingenting.
 */
export async function generateContractDocument(
  deps: DocumentDeps,
  contract: Contract,
): Promise<StoredContractDocument> {
  const document = await collectContractDocument(deps.sql, contract);
  const source = contractTypst(document);
  const content = await deps.typst.compile({ source, filename: `contract-${contract.id}.typ` });

  const key = contractDocumentKey(contract.id);
  const filename = contractFilename(document);

  await deps.objects.put(key, content, 'application/pdf');
  await saveDocumentRef(deps.sql, contract.id, { key, filename, generatedAt: new Date() });

  return { key, filename, content };
}

/**
 * Dokumentet som det ligger, eller ett nyskrivet om det saknas.
 *
 * Normalvägen är att det redan finns: det skrevs när den andra signaturen föll. Vägen
 * hit går bara när motorn var nere då, eller när lagringen tappat objektet — och då är
 * en omkompilering rätt svar, för källan är en ren funktion av frysta villkor.
 */
export async function ensureContractDocument(
  deps: DocumentDeps,
  contract: Contract,
): Promise<StoredContractDocument> {
  if (contract.documentKey && contract.documentFilename) {
    const content = await deps.objects.get(contract.documentKey);
    if (content) {
      return { key: contract.documentKey, filename: contract.documentFilename, content };
    }
  }

  return generateContractDocument(deps, contract);
}
