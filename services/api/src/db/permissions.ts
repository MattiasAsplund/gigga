import type { SQL } from 'bun';

export type PermissionLevel = 'read';

export interface RequestPermission {
  requestId: string;
  userId: string;
  email: string;
  displayName: string;
  level: PermissionLevel;
  grantedAt: Date;
}

interface PermissionRow {
  request_id: string;
  user_id: string;
  email: string;
  display_name: string;
  level: PermissionLevel;
  granted_at: Date;
}

const toPermission = (row: PermissionRow): RequestPermission => ({
  requestId: row.request_id,
  userId: row.user_id,
  email: row.email,
  displayName: row.display_name,
  level: row.level,
  grantedAt: row.granted_at,
});

const SELECT_PERMISSION = `
  SELECT p.request_id, p.user_id, u.email, u.display_name, p.level, p.granted_at
  FROM request_permissions p
  JOIN users u ON u.id = p.user_id
`;

/**
 * Ger läsrätt. `created` skiljer första tilldelningen från en upprepning, så routen kan
 * svara 201 respektive 200 — men tilldelningen är idempotent och `granted_at` rörs inte.
 */
export async function grantReadPermission(
  sql: SQL,
  input: { requestId: string; userId: string; grantedBy: string },
): Promise<{ permission: RequestPermission; created: boolean }> {
  const inserted = (await sql`
    INSERT INTO request_permissions (request_id, user_id, granted_by)
    VALUES (${input.requestId}, ${input.userId}, ${input.grantedBy})
    ON CONFLICT (request_id, user_id) DO NOTHING
    RETURNING request_id
  `) as { request_id: string }[];

  const rows = (await sql`
    ${sql.unsafe(SELECT_PERMISSION)}
    WHERE p.request_id = ${input.requestId} AND p.user_id = ${input.userId}
  `) as PermissionRow[];

  const row = rows[0];
  if (!row) throw new Error('Rättigheten kunde inte läsas tillbaka efter tilldelning');

  return { permission: toPermission(row), created: inserted.length > 0 };
}

export async function listRequestPermissions(
  sql: SQL,
  requestId: string,
): Promise<RequestPermission[]> {
  const rows = (await sql`
    ${sql.unsafe(SELECT_PERMISSION)}
    WHERE p.request_id = ${requestId}
    ORDER BY p.granted_at DESC
  `) as PermissionRow[];

  return rows.map(toPermission);
}

/** Returnerar false om det inte fanns någon rättighet att ta tillbaka. */
export async function revokeReadPermission(
  sql: SQL,
  input: { requestId: string; userId: string },
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM request_permissions
    WHERE request_id = ${input.requestId} AND user_id = ${input.userId}
    RETURNING user_id
  `) as { user_id: string }[];

  return rows.length > 0;
}

export async function hasReadPermission(
  sql: SQL,
  input: { requestId: string; userId: string },
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS finns FROM request_permissions
    WHERE request_id = ${input.requestId} AND user_id = ${input.userId}
  `) as { finns: number }[];

  return rows.length > 0;
}
