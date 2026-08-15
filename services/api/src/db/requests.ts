import type { SQL } from 'bun';
import { fromMinorColumn, money, toMinorColumn, type Money } from '../domain/money.ts';

export type CompensationPref = 'fixed' | 'hourly' | 'any';
export type RequestStatus = 'open' | 'awarded' | 'cancelled';

export interface UppdragsRequest {
  id: string;
  buyerId: string;
  title: string;
  description: string;
  compensationPref: CompensationPref;
  budget: Money | null;
  deadlineAt: Date | null;
  status: RequestStatus;
  createdAt: Date;
}

export interface RequestRow {
  id: string;
  buyer_id: string;
  title: string;
  description: string;
  compensation_pref: CompensationPref;
  budget_minor: string | null;
  currency: string;
  deadline_at: Date | null;
  status: RequestStatus;
  created_at: Date;
}

/** Enda stället där en requests-rad blir ett domänobjekt. Beloppet konverteras här (D.4). */
export function toRequest(row: RequestRow): UppdragsRequest {
  return {
    id: row.id,
    buyerId: row.buyer_id,
    title: row.title,
    description: row.description,
    compensationPref: row.compensation_pref,
    budget: money(fromMinorColumn(row.budget_minor), row.currency),
    deadlineAt: row.deadline_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

export const REQUEST_COLUMNS =
  'id, buyer_id, title, description, compensation_pref, budget_minor, currency, deadline_at, status, created_at';

export async function insertRequest(
  sql: SQL,
  input: {
    buyerId: string;
    title: string;
    description: string;
    compensationPref: CompensationPref;
    budget: Money | null;
    deadlineAt: Date | null;
  },
): Promise<UppdragsRequest> {
  const rows = (await sql`
    INSERT INTO requests (buyer_id, title, description, compensation_pref,
                          budget_minor, currency, deadline_at)
    VALUES (${input.buyerId}, ${input.title}, ${input.description}, ${input.compensationPref},
            ${input.budget ? toMinorColumn(input.budget.amountMinor) : null},
            ${input.budget?.currency ?? 'SEK'},
            ${input.deadlineAt})
    RETURNING ${sql.unsafe(REQUEST_COLUMNS)}
  `) as RequestRow[];

  const row = rows[0];
  if (!row) throw new Error('INSERT returnerade ingen rad');
  return toRequest(row);
}

export async function findRequestById(
  sql: SQL,
  id: string,
): Promise<UppdragsRequest | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(REQUEST_COLUMNS)} FROM requests WHERE id = ${id}
  `) as RequestRow[];

  const row = rows[0];
  return row ? toRequest(row) : null;
}
