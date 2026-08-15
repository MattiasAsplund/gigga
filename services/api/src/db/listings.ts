import type { SQL } from 'bun';
import { toRequest, type RequestRow, type UppdragsRequest } from './requests.ts';
import { toBid, type Bid, type BidRow, type BidStatus } from './bids.ts';
import type { Cursor } from '../domain/pagination.ts';

export interface PageQuery {
  limit: number;
  cursor: Cursor | null;
}

export interface BidWithSeller extends Bid {
  sellerDisplayName: string;
}

export interface RequestWithBids extends UppdragsRequest {
  bids: BidWithSeller[];
}

export interface ContractSummary {
  id: string;
  status: 'pending_signatures' | 'active' | 'void';
  buyerSigned: boolean;
  sellerSigned: boolean;
}

export interface BidWithContext extends Bid {
  requestTitle: string;
  contract: ContractSummary | null;
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
           b.status, b.created_at,
           u.display_name
    FROM bids b
    JOIN users u ON u.id = b.seller_id
    -- sql(array) expanderar till en parametriserad IN-lista. En rå JS-array binds av
    -- Bun.SQL som komma-sträng och ger "malformed array literal".
    -- Listan är aldrig tom här: vi returnerade redan om sidan saknade förfrågningar.
    WHERE b.request_id IN ${sql(requests.map((r) => r.id))}
    ORDER BY b.created_at DESC, b.id DESC
  `) as (BidRow & { display_name: string })[];

  const byRequest = new Map<string, BidWithSeller[]>();
  for (const row of bidRows) {
    const list = byRequest.get(row.request_id) ?? [];
    list.push({ ...toBid(row), sellerDisplayName: row.display_name });
    byRequest.set(row.request_id, list);
  }

  return requests.map((request) => ({
    ...request,
    // Alltid en lista, aldrig utelämnad: en förfrågan utan anbud har noll anbud (L3.3).
    bids: byRequest.get(request.id) ?? [],
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
           b.status, b.created_at,
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
    contract:
      row.contract_id && row.contract_status
        ? {
            id: row.contract_id,
            status: row.contract_status,
            buyerSigned: row.buyer_signed_at !== null,
            sellerSigned: row.seller_signed_at !== null,
          }
        : null,
  }));
}
