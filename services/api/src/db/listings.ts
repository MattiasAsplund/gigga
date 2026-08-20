import type { SQL } from 'bun';
import {
  toRequest,
  type CompensationPref,
  type RequestRow,
  type UppdragsRequest,
} from './requests.ts';
import { toBid, type Bid, type BidRow, type BidStatus } from './bids.ts';
import type { Cursor } from '../domain/pagination.ts';

export interface PageQuery {
  limit: number;
  cursor: Cursor | null;
}

export interface BidWithSeller extends Bid {
  sellerDisplayName: string;
  contract: ContractSummary | null;
}

export interface RequestWithBids extends UppdragsRequest {
  bids: BidWithSeller[];
}

export interface ContractSummary {
  id: string;
  status: 'pending_signatures' | 'active' | 'void';
  buyerSignedAt: Date | null;
  sellerSignedAt: Date | null;
}

export interface BidWithContext extends Bid {
  requestTitle: string;
  contract: ContractSummary | null;
}

/** Kolumnerna från LEFT JOIN contracts — null hela vägen när inget avtal finns. */
interface ContractColumns {
  contract_id: string | null;
  contract_status: ContractSummary['status'] | null;
  buyer_signed_at: Date | null;
  seller_signed_at: Date | null;
}

const CONTRACT_JOIN_COLUMNS =
  'c.id AS contract_id, c.status AS contract_status, c.buyer_signed_at, c.seller_signed_at';

function toContractSummary(row: ContractColumns): ContractSummary | null {
  return row.contract_id && row.contract_status
    ? {
        id: row.contract_id,
        status: row.contract_status,
        buyerSignedAt: row.buyer_signed_at,
        sellerSignedAt: row.seller_signed_at,
      }
    : null;
}

/**
 * Köparens egna förfrågningar, nyaste först, med tillhörande anbud.
 *
 * Två frågor, inte en per förfrågan: sidan hämtas först, sedan alla dess anbud i ett svep.
 * En rad mer än `limit` hämtas för att avgöra om det finns en nästa sida.
 */
export async function listBuyerRequests(
  sql: SQL,
  buyerId: string,
  page: PageQuery,
): Promise<RequestWithBids[]> {
  const cursorAt = page.cursor?.createdAt ?? null;
  const cursorId = page.cursor?.id ?? null;

  const requestRows = (await sql`
    SELECT id, buyer_id, title, description, compensation_pref,
           budget_minor, currency, deadline_at, status, created_at
    FROM requests
    WHERE buyer_id = ${buyerId}
      AND (${cursorAt}::timestamptz IS NULL
           OR (created_at, id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY created_at DESC, id DESC
    LIMIT ${page.limit + 1}
  `) as RequestRow[];

  const requests = requestRows.map(toRequest);
  if (requests.length === 0) return [];

  const bidRows = (await sql`
    SELECT b.id, b.request_id, b.seller_id, b.plan, b.compensation_type,
           b.fixed_amount_minor, b.hourly_rate_minor, b.estimated_hours, b.currency,
           b.status, b.spec_version_id, b.created_at,
           u.display_name,
           ${sql.unsafe(CONTRACT_JOIN_COLUMNS)}
    FROM bids b
    JOIN users u ON u.id = b.seller_id
    LEFT JOIN contracts c ON c.bid_id = b.id
    -- sql(array) expanderar till en parametriserad IN-lista. En rå JS-array binds av
    -- Bun.SQL som komma-sträng och ger "malformed array literal".
    -- Listan är aldrig tom här: vi returnerade redan om sidan saknade förfrågningar.
    WHERE b.request_id IN ${sql(requests.map((r) => r.id))}
    ORDER BY b.created_at DESC, b.id DESC
  `) as (BidRow & { display_name: string } & ContractColumns)[];

  const byRequest = new Map<string, BidWithSeller[]>();
  for (const row of bidRows) {
    const list = byRequest.get(row.request_id) ?? [];
    list.push({
      ...toBid(row),
      sellerDisplayName: row.display_name,
      contract: toContractSummary(row),
    });
    byRequest.set(row.request_id, list);
  }

  return requests.map((request) => ({
    ...request,
    // Alltid en lista, aldrig utelämnad: en förfrågan utan anbud har noll anbud (L3.3).
    bids: byRequest.get(request.id) ?? [],
  }));
}

/** Anbuden på en enskild förfrågan, med säljarens namn. Samma form som i API 3. */
export async function listBidsForRequest(
  sql: SQL,
  requestId: string,
): Promise<BidWithSeller[]> {
  const rows = (await sql`
    SELECT b.id, b.request_id, b.seller_id, b.plan, b.compensation_type,
           b.fixed_amount_minor, b.hourly_rate_minor, b.estimated_hours, b.currency,
           b.status, b.spec_version_id, b.created_at,
           u.display_name,
           ${sql.unsafe(CONTRACT_JOIN_COLUMNS)}
    FROM bids b
    JOIN users u ON u.id = b.seller_id
    LEFT JOIN contracts c ON c.bid_id = b.id
    WHERE b.request_id = ${requestId}
    ORDER BY b.created_at DESC, b.id DESC
  `) as (BidRow & { display_name: string } & ContractColumns)[];

  return rows.map((row) => ({
    ...toBid(row),
    sellerDisplayName: row.display_name,
    contract: toContractSummary(row),
  }));
}

export interface CatalogRequest extends UppdragsRequest {
  buyerDisplayName: string;
  bidCount: number;
  hasMyBid: boolean;
  /** Utan publicerad kravspec finns ingen omfattning att prissätta — och inget att bjuda på. */
  hasPublishedSpec: boolean;
}

/**
 * Katalogen: förfrågningar som faktiskt går att lämna anbud på — `open` och med deadline
 * kvar. En tilldelad eller utgången förfrågan är brus för den som letar uppdrag.
 *
 * Anbudens innehåll lämnas aldrig ut här, bara antalet. Vem som bjudit vad är en sak
 * mellan köparen och respektive säljare.
 */
export async function listOpenRequests(
  sql: SQL,
  viewerId: string,
  page: PageQuery,
  compensationPref: CompensationPref | null,
): Promise<CatalogRequest[]> {
  const cursorAt = page.cursor?.createdAt ?? null;
  const cursorId = page.cursor?.id ?? null;

  const rows = (await sql`
    SELECT r.id, r.buyer_id, r.title, r.description, r.compensation_pref,
           r.budget_minor, r.currency, r.deadline_at, r.status, r.created_at,
           u.display_name,
           (SELECT count(*) FROM bids b
             WHERE b.request_id = r.id AND b.status <> 'withdrawn')::int AS bid_count,
           EXISTS (SELECT 1 FROM bids b
                    WHERE b.request_id = r.id
                      AND b.seller_id = ${viewerId}
                      AND b.status <> 'withdrawn') AS has_my_bid,
           EXISTS (SELECT 1 FROM request_spec_versions v
                    WHERE v.request_id = r.id AND v.status = 'published')
             AS has_published_spec
    FROM requests r
    JOIN users u ON u.id = r.buyer_id
    WHERE r.status = 'open'
      AND (r.deadline_at IS NULL OR r.deadline_at > now())
      AND (${compensationPref}::compensation_pref IS NULL
           OR r.compensation_pref = ${compensationPref}::compensation_pref)
      AND (${cursorAt}::timestamptz IS NULL
           OR (r.created_at, r.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${page.limit + 1}
  `) as (RequestRow & {
    display_name: string;
    bid_count: number;
    has_my_bid: boolean;
    has_published_spec: boolean;
  })[];

  return rows.map((row) => ({
    ...toRequest(row),
    buyerDisplayName: row.display_name,
    bidCount: row.bid_count,
    hasMyBid: row.has_my_bid,
    hasPublishedSpec: row.has_published_spec,
  }));
}

/** Säljarens egna anbud, nyaste först, med förfrågans titel och avtalets signaturläge. */
export async function listSellerBids(
  sql: SQL,
  sellerId: string,
  page: PageQuery,
  status: BidStatus | null,
): Promise<BidWithContext[]> {
  const cursorAt = page.cursor?.createdAt ?? null;
  const cursorId = page.cursor?.id ?? null;

  const rows = (await sql`
    SELECT b.id, b.request_id, b.seller_id, b.plan, b.compensation_type,
           b.fixed_amount_minor, b.hourly_rate_minor, b.estimated_hours, b.currency,
           b.status, b.spec_version_id, b.created_at,
           r.title AS request_title,
           c.id AS contract_id, c.status AS contract_status,
           c.buyer_signed_at, c.seller_signed_at
    FROM bids b
    JOIN requests r ON r.id = b.request_id
    LEFT JOIN contracts c ON c.bid_id = b.id
    WHERE b.seller_id = ${sellerId}
      AND (${status}::bid_status IS NULL OR b.status = ${status}::bid_status)
      AND (${cursorAt}::timestamptz IS NULL
           OR (b.created_at, b.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ${page.limit + 1}
  `) as (BidRow & {
    request_title: string;
    contract_id: string | null;
    contract_status: ContractSummary['status'] | null;
    buyer_signed_at: Date | null;
    seller_signed_at: Date | null;
  })[];

  return rows.map((row) => ({
    ...toBid(row),
    requestTitle: row.request_title,
    contract: toContractSummary(row),
  }));
}
