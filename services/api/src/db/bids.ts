import type { SQL } from 'bun';
import {
  fromCompensationColumns,
  toCompensationColumns,
  type Compensation,
  type CompensationRow,
} from '../domain/bid-rules.ts';

export type BidStatus = 'submitted' | 'withdrawn' | 'accepted' | 'rejected';

export interface Bid {
  id: string;
  requestId: string;
  /** Vem som lämnade anbudet. Parten är organisationen. */
  sellerId: string;
  /** Företaget som är säljare — det behörighetskontrollerna jämför mot. */
  sellerOrganizationId: string;
  plan: string;
  compensation: Compensation;
  status: BidStatus;
  /** Den lydelse av kravspecen anbudet avser. Null när förfrågan saknar publicerad version. */
  specVersionId: string | null;
  createdAt: Date;
}

export interface BidRow extends CompensationRow {
  id: string;
  request_id: string;
  seller_id: string;
  seller_organization_id: string;
  plan: string;
  status: BidStatus;
  spec_version_id?: string | null;
  created_at: Date;
}

export const BID_COLUMNS =
  'id, request_id, seller_id, seller_organization_id, plan, compensation_type, fixed_amount_minor, ' +
  'hourly_rate_minor, estimated_hours, currency, status, spec_version_id, created_at';

export function toBid(row: BidRow): Bid {
  return {
    id: row.id,
    requestId: row.request_id,
    sellerId: row.seller_id,
    sellerOrganizationId: row.seller_organization_id,
    plan: row.plan,
    compensation: fromCompensationColumns(row),
    status: row.status,
    specVersionId: row.spec_version_id ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Skapar anbudet, eller returnerar null om säljaren redan har ett aktivt anbud på
 * förfrågan. Konflikten avgörs av det partiella unika indexet, inte av en
 * läs-innan-skriv som två samtidiga anrop kan slinka förbi.
 */
export async function insertBid(
  sql: SQL,
  input: {
    requestId: string;
    sellerId: string;
    sellerOrganizationId: string;
    plan: string;
    compensation: Compensation;
  },
): Promise<Bid | null> {
  const columns = toCompensationColumns(input.compensation);

  /*
   * spec_version_id sätts av frågan själv, inte av anroparen: anbudet ska avse den
   * lydelse som gällde när det lämnades, och den vet databasen bäst i samma ögonblick
   * som raden skrivs. Saknas publicerad kravspec blir det null.
   */
  const rows = (await sql`
    INSERT INTO bids (request_id, seller_id, seller_organization_id, plan, compensation_type,
                      fixed_amount_minor, hourly_rate_minor, estimated_hours, currency,
                      spec_version_id)
    VALUES (${input.requestId}, ${input.sellerId}, ${input.sellerOrganizationId},
            ${input.plan}, ${columns.compensationType},
            ${columns.fixedAmountMinor}, ${columns.hourlyRateMinor},
            ${columns.estimatedHours}, ${columns.currency},
            (SELECT v.id FROM request_spec_versions v
             WHERE v.request_id = ${input.requestId} AND v.status = 'published'))
    ON CONFLICT (request_id, seller_organization_id) WHERE status <> 'withdrawn' DO NOTHING
    RETURNING ${sql.unsafe(BID_COLUMNS)}
  `) as BidRow[];

  const row = rows[0];
  return row ? toBid(row) : null;
}

export async function findBidById(sql: SQL, id: string): Promise<Bid | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(BID_COLUMNS)} FROM bids WHERE id = ${id}
  `) as BidRow[];

  const row = rows[0];
  return row ? toBid(row) : null;
}

/**
 * Skriver om anbudets innehåll. Utelämnade fält lämnas orörda — COALESCE på planen,
 * och för ersättningen avgör en flagga i stället, eftersom dess kolumner är null i
 * den form som inte gäller (ett fastprisanbud har ingen timtaxa att falla tillbaka på).
 *
 * Statusen rörs inte: en ändring gör inte om anbudet till något annat.
 */
export async function updateBid(
  sql: SQL,
  input: { bidId: string; plan: string | null; compensation: Compensation | null },
): Promise<Bid | null> {
  const columns = input.compensation
    ? toCompensationColumns(input.compensation)
    : { compensationType: null, fixedAmountMinor: null, hourlyRateMinor: null, estimatedHours: null, currency: null };
  const changeCompensation = input.compensation !== null;

  const rows = (await sql`
    UPDATE bids SET
      plan                = COALESCE(${input.plan}, plan),
      compensation_type   = CASE WHEN ${changeCompensation}
                            THEN ${columns.compensationType}::compensation_type
                            ELSE compensation_type END,
      fixed_amount_minor  = CASE WHEN ${changeCompensation}
                            THEN ${columns.fixedAmountMinor} ELSE fixed_amount_minor END,
      hourly_rate_minor   = CASE WHEN ${changeCompensation}
                            THEN ${columns.hourlyRateMinor} ELSE hourly_rate_minor END,
      estimated_hours     = CASE WHEN ${changeCompensation}
                            THEN ${columns.estimatedHours} ELSE estimated_hours END,
      currency            = CASE WHEN ${changeCompensation}
                            THEN ${columns.currency} ELSE currency END
    WHERE id = ${input.bidId}
    RETURNING ${sql.unsafe(BID_COLUMNS)}
  `) as BidRow[];

  const row = rows[0];
  return row ? toBid(row) : null;
}

/**
 * Sätter anbudet till withdrawn. Idempotent genom att den redan tillbakadragna raden
 * skrivs om till samma värde — anroparen får tillbaka raden oavsett (Ä.12).
 */
export async function withdrawBid(sql: SQL, bidId: string): Promise<Bid | null> {
  const rows = (await sql`
    UPDATE bids SET status = 'withdrawn'
    WHERE id = ${bidId}
    RETURNING ${sql.unsafe(BID_COLUMNS)}
  `) as BidRow[];

  const row = rows[0];
  return row ? toBid(row) : null;
}
