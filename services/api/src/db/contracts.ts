import type { SQL } from 'bun';
import type { Compensation } from '../domain/bid-rules.ts';
import type { ContractStatus, SignatureState, SignerRole } from '../domain/contract-rules.ts';
import { toBid, type Bid, type BidRow } from './bids.ts';
import type { RequestStatus } from './requests.ts';

/**
 * Avtalets frysta villkor. En ögonblicksbild av anbudet när avtalet skapades — ändras
 * anbudet därefter rör det inte avtalet (S7.7).
 */
export interface ContractTerms {
  bidId: string;
  requestId: string;
  buyerId: string;
  sellerId: string;
  buyerOrganizationId: string;
  sellerOrganizationId: string;
  requestTitle: string;
  plan: string;
  compensation: Compensation;
  estimatedTotalMinor: number;
  frozenAt: string;
}

export interface Contract extends SignatureState {
  id: string;
  requestId: string;
  bidId: string;
  terms: ContractTerms;
  /** Personen som signerade för köparen. Parten är företaget — det här är pennan. */
  buyerSignedBy: string | null;
  sellerSignedBy: string | null;
  /** Dokumentet i objektlagringen. Null tills det kompilerats. */
  documentKey: string | null;
  documentFilename: string | null;
  documentGeneratedAt: Date | null;
  createdAt: Date;
}

interface ContractRow {
  id: string;
  request_id: string;
  bid_id: string;
  /** Se parseTerms: en jsonb-*kolumn* kommer tillbaka som sträng från Bun.SQL. */
  terms: ContractTerms | string;
  buyer_signed_at: Date | null;
  seller_signed_at: Date | null;
  buyer_signed_by: string | null;
  seller_signed_by: string | null;
  document_key: string | null;
  document_filename: string | null;
  document_generated_at: Date | null;
  status: ContractStatus;
  created_at: Date;
}

/**
 * Bun.SQL ger en jsonb-**kolumn** som sträng, medan ett jsonb-**uttryck**
 * (`'{"a":1}'::jsonb`) kommer tillbaka som objekt. Vi parsar därför explicit istället för
 * att lita på formen — annars går felet vidare till serialiseringen och blir en 500:a
 * med det gäckande beskedet `"bidId" is required!`.
 */
function parseTerms(value: ContractTerms | string): ContractTerms {
  return typeof value === 'string' ? (JSON.parse(value) as ContractTerms) : value;
}

const CONTRACT_COLUMNS =
  'id, request_id, bid_id, terms, buyer_signed_at, seller_signed_at, ' +
  'buyer_signed_by, seller_signed_by, ' +
  'document_key, document_filename, document_generated_at, status, created_at';

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    requestId: row.request_id,
    bidId: row.bid_id,
    terms: parseTerms(row.terms),
    buyerSignedAt: row.buyer_signed_at,
    sellerSignedAt: row.seller_signed_at,
    buyerSignedBy: row.buyer_signed_by,
    sellerSignedBy: row.seller_signed_by,
    documentKey: row.document_key,
    documentFilename: row.document_filename,
    documentGeneratedAt: row.document_generated_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface SigningContext {
  bid: Bid;
  request: {
    id: string;
    buyerId: string;
    buyerOrganizationId: string;
    title: string;
    status: RequestStatus;
  };
}

/**
 * Hämtar anbudet med sin förfrågan och **låser förfrågningsraden** (`FOR UPDATE OF r`).
 *
 * Låset är seriliseringspunkten för hela signeringsflödet: en förfrågan kan bara ha ett
 * avtal, så två samtidiga signaturer måste köa här. Utan låset kan båda se "inget avtal
 * finns" och försöka skapa var sitt (S7.8).
 */
export async function lockBidForSigning(
  sql: SQL,
  bidId: string,
): Promise<SigningContext | null> {
  const rows = (await sql`
    SELECT b.id, b.request_id, b.seller_id, b.seller_organization_id, b.plan,
           b.compensation_type,
           b.fixed_amount_minor, b.hourly_rate_minor, b.estimated_hours, b.currency,
           b.status, b.spec_version_id, b.created_at,
           r.buyer_id AS r_buyer_id, r.buyer_organization_id AS r_buyer_org_id,
           r.title AS r_title, r.status AS r_status
    FROM bids b
    JOIN requests r ON r.id = b.request_id
    WHERE b.id = ${bidId}
    FOR UPDATE OF r
  `) as (BidRow & {
    r_buyer_id: string;
    r_buyer_org_id: string;
    r_title: string;
    r_status: RequestStatus;
  })[];

  const row = rows[0];
  if (!row) return null;

  return {
    bid: toBid(row),
    request: {
      id: row.request_id,
      buyerId: row.r_buyer_id,
      buyerOrganizationId: row.r_buyer_org_id,
      title: row.r_title,
      status: row.r_status,
    },
  };
}

/** Finns det ett avtal på anbudet? Utan lås — anroparen ska bara neka, inte skriva. */
export async function findContractByBid(sql: SQL, bidId: string): Promise<Contract | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CONTRACT_COLUMNS)} FROM contracts WHERE bid_id = ${bidId}
  `) as ContractRow[];

  const row = rows[0];
  return row ? toContract(row) : null;
}

/** Avtalet som det står. Nedladdningen behöver raden, inte anbudet den kom ur. */
export async function findContractById(sql: SQL, id: string): Promise<Contract | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CONTRACT_COLUMNS)} FROM contracts WHERE id = ${id}
  `) as ContractRow[];

  const row = rows[0];
  return row ? toContract(row) : null;
}

/**
 * Pekar ut det kompilerade dokumentet.
 *
 * Skrivs efter att objektet ligger i lagringen, aldrig före: en rad som pekar på ett
 * objekt som inte finns är värre än en rad som saknar peka helt — den senare leder till
 * en omkompilering, den förra till en tom nedladdning.
 */
export async function saveDocumentRef(
  sql: SQL,
  contractId: string,
  document: { key: string; filename: string; generatedAt: Date },
): Promise<void> {
  await sql`
    UPDATE contracts
    SET document_key = ${document.key},
        document_filename = ${document.filename},
        document_generated_at = ${document.generatedAt}
    WHERE id = ${contractId}
  `;
}

/** Låser avtalsraden om den finns, så samtidiga signaturer serialiseras. */
export async function findContractByBidForUpdate(
  sql: SQL,
  bidId: string,
): Promise<Contract | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CONTRACT_COLUMNS)} FROM contracts WHERE bid_id = ${bidId} FOR UPDATE
  `) as ContractRow[];

  const row = rows[0];
  return row ? toContract(row) : null;
}

export async function insertContract(
  sql: SQL,
  input: {
    requestId: string;
    bidId: string;
    terms: ContractTerms;
    state: SignatureState;
    /** Köparens penna. Avtalet skapas av köparens signatur, så någon annan finns inte än. */
    signedBy: string;
  },
): Promise<Contract> {
  const rows = (await sql`
    INSERT INTO contracts (request_id, bid_id, terms, buyer_signed_at, seller_signed_at,
                           buyer_signed_by, status)
    VALUES (${input.requestId}, ${input.bidId}, ${JSON.stringify(input.terms)}::jsonb,
            ${input.state.buyerSignedAt}, ${input.state.sellerSignedAt},
            ${input.signedBy}, ${input.state.status})
    RETURNING ${sql.unsafe(CONTRACT_COLUMNS)}
  `) as ContractRow[];

  const row = rows[0];
  if (!row) throw new Error('INSERT returnerade ingen rad');
  return toContract(row);
}

export async function updateSignatures(
  sql: SQL,
  contractId: string,
  state: SignatureState,
  signer: { role: SignerRole; userId: string },
): Promise<Contract> {
  const rows = (await sql`
    UPDATE contracts
    SET buyer_signed_at = ${state.buyerSignedAt},
        seller_signed_at = ${state.sellerSignedAt},
        buyer_signed_by = CASE WHEN ${signer.role} = 'buyer' THEN ${signer.userId}::uuid
                               ELSE buyer_signed_by END,
        seller_signed_by = CASE WHEN ${signer.role} = 'seller' THEN ${signer.userId}::uuid
                                ELSE seller_signed_by END,
        status = ${state.status}
    WHERE id = ${contractId}
    RETURNING ${sql.unsafe(CONTRACT_COLUMNS)}
  `) as ContractRow[];

  const row = rows[0];
  if (!row) throw new Error('UPDATE träffade ingen rad');
  return toContract(row);
}

/**
 * Följdverkningarna av ett aktiverat avtal: förfrågan tilldelas, det vinnande anbudet
 * accepteras och övriga avslås. Körs i samma transaktion som signaturen.
 */
export async function settleAward(
  sql: SQL,
  input: { requestId: string; winningBidId: string },
): Promise<void> {
  await sql`UPDATE requests SET status = 'awarded' WHERE id = ${input.requestId}`;

  await sql`
    UPDATE bids
    SET status = CASE WHEN id = ${input.winningBidId} THEN 'accepted'::bid_status
                      ELSE 'rejected'::bid_status END
    WHERE request_id = ${input.requestId}
      AND status IN ('submitted', 'accepted')
  `;
}
