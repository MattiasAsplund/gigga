import type { SQL } from 'bun';

export interface Attachment {
  id: string;
  bidId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Nyckeln i objektlagringen. Innehållet ligger inte i databasen. */
  storageKey: string;
  uploadedAt: Date;
}

interface AttachmentRow {
  id: string;
  bid_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  uploaded_at: Date;
}

const META_COLUMNS =
  'id, bid_id, filename, content_type, size_bytes, storage_key, uploaded_at';

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  bidId: row.bid_id,
  filename: row.filename,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  storageKey: row.storage_key,
  uploadedAt: row.uploaded_at,
});

/**
 * Returnerar null om filnamnet redan är upptaget i anbudet.
 *
 * Raden skrivs efter att objektet lagts upp; anroparen städar bort objektet om det här
 * ger null. Ordningen är medveten: ett objekt utan rad är skräp, en rad utan objekt är
 * ett trasigt dokument.
 */
export async function insertAttachment(
  sql: SQL,
  input: {
    id: string;
    bidId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    storageKey: string;
  },
): Promise<Attachment | null> {
  const rows = (await sql`
    INSERT INTO bid_attachments (id, bid_id, filename, content_type, size_bytes, storage_key)
    VALUES (${input.id}, ${input.bidId}, ${input.filename}, ${input.contentType},
            ${input.sizeBytes}, ${input.storageKey})
    ON CONFLICT (bid_id, filename) DO NOTHING
    RETURNING ${sql.unsafe(META_COLUMNS)}
  `) as AttachmentRow[];

  const row = rows[0];
  return row ? toAttachment(row) : null;
}

export async function countAttachments(sql: SQL, bidId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM bid_attachments WHERE bid_id = ${bidId}
  `) as { n: number }[];

  return rows[0]?.n ?? 0;
}

export async function listAttachments(sql: SQL, bidId: string): Promise<Attachment[]> {
  const rows = (await sql`
    SELECT ${sql.unsafe(META_COLUMNS)}
    FROM bid_attachments
    WHERE bid_id = ${bidId}
    ORDER BY uploaded_at DESC, id DESC
  `) as AttachmentRow[];

  return rows.map(toAttachment);
}

export async function findAttachment(
  sql: SQL,
  input: { bidId: string; attachmentId: string },
): Promise<Attachment | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(META_COLUMNS)}
    FROM bid_attachments
    WHERE id = ${input.attachmentId} AND bid_id = ${input.bidId}
  `) as AttachmentRow[];

  const row = rows[0];
  return row ? toAttachment(row) : null;
}

/** Dokumenten i arkivordning. Innehållet hämtas ur objektlagringen av anroparen. */
export async function listAttachmentsForArchive(
  sql: SQL,
  bidId: string,
): Promise<Attachment[]> {
  const rows = (await sql`
    SELECT ${sql.unsafe(META_COLUMNS)}
    FROM bid_attachments
    WHERE bid_id = ${bidId}
    ORDER BY filename
  `) as AttachmentRow[];

  return rows.map(toAttachment);
}

/** Returnerar null om namnet är upptaget, false om dokumentet inte finns. */
export async function renameAttachment(
  sql: SQL,
  input: { bidId: string; attachmentId: string; filename: string },
): Promise<Attachment | null> {
  const rows = (await sql`
    UPDATE bid_attachments
    SET filename = ${input.filename}
    WHERE id = ${input.attachmentId} AND bid_id = ${input.bidId}
      AND NOT EXISTS (
        SELECT 1 FROM bid_attachments other
        WHERE other.bid_id = ${input.bidId}
          AND other.filename = ${input.filename}
          AND other.id <> ${input.attachmentId}
      )
    RETURNING ${sql.unsafe(META_COLUMNS)}
  `) as AttachmentRow[];

  const row = rows[0];
  return row ? toAttachment(row) : null;
}

/** Returnerar nyckeln som ska städas bort ur lagringen, eller null om raden inte fanns. */
export async function deleteAttachment(
  sql: SQL,
  input: { bidId: string; attachmentId: string },
): Promise<string | null> {
  const rows = (await sql`
    DELETE FROM bid_attachments
    WHERE id = ${input.attachmentId} AND bid_id = ${input.bidId}
    RETURNING storage_key
  `) as { storage_key: string }[];

  return rows[0]?.storage_key ?? null;
}
