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
  sellerId: string;
  plan: string;
  compensation: Compensation;
  status: BidStatus;
  createdAt: Date;
}

export interface BidRow extends CompensationRow {
  id: string;
  request_id: string;
  seller_id: string;
  plan: string;
  status: BidStatus;
  created_at: Date;
}

export const BID_COLUMNS =
  'id, request_id, seller_id, plan, compensation_type, fixed_amount_minor, ' +
  'hourly_rate_minor, estimated_hours, currency, status, created_at';

export function toBid(row: BidRow): Bid {
  return {
    id: row.id,
    requestId: row.request_id,
    sellerId: row.seller_id,
    plan: row.plan,
    compensation: fromCompensationColumns(row),
    status: row.status,
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
  input: { requestId: string; sellerId: string; plan: string; compensation: Compensation },
): Promise<Bid | null> {
  const columns = toCompensationColumns(input.compensation);

  const rows = (await sql`
    INSERT INTO bids (request_id, seller_id, plan, compensation_type,
                      fixed_amount_minor, hourly_rate_minor, estimated_hours, currency)
    VALUES (${input.requestId}, ${input.sellerId}, ${input.plan}, ${columns.compensationType},
            ${columns.fixedAmountMinor}, ${columns.hourlyRateMinor},
            ${columns.estimatedHours}, ${columns.currency})
    ON CONFLICT (request_id, seller_id) WHERE status <> 'withdrawn' DO NOTHING
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
