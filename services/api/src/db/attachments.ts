import type { SQL } from 'bun';

export interface Attachment {
  id: string;
  bidId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
}

export interface AttachmentWithContent extends Attachment {
  content: Uint8Array;
}

interface AttachmentRow {
  id: string;
  bid_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: Date;
}

const META_COLUMNS = 'id, bid_id, filename, content_type, size_bytes, uploaded_at';

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  bidId: row.bid_id,
  filename: row.filename,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  uploadedAt: row.uploaded_at,
});

/** Returnerar null om filnamnet redan är upptaget i anbudet. */
export async function insertAttachment(
  sql: SQL,
  input: {
    bidId: string;
    filename: string;
    contentType: string;
    content: Uint8Array;
  },
): Promise<Attachment | null> {
  const rows = (await sql`
    INSERT INTO bid_attachments (bid_id, filename, content_type, size_bytes, content)
    VALUES (${input.bidId}, ${input.filename}, ${input.contentType},
            ${input.content.byteLength}, ${Buffer.from(input.content)})
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

/** Hämtar innehållet för hela anbudet — underlaget till ZIP-arkivet. */
export async function loadAttachmentContents(
  sql: SQL,
  bidId: string,
): Promise<AttachmentWithContent[]> {
  const rows = (await sql`
    SELECT ${sql.unsafe(META_COLUMNS)}, content
    FROM bid_attachments
    WHERE bid_id = ${bidId}
    ORDER BY filename
  `) as (AttachmentRow & { content: Uint8Array | Buffer })[];

  return rows.map((row) => ({
    ...toAttachment(row),
    content: new Uint8Array(row.content),
  }));
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

export async function deleteAttachment(
  sql: SQL,
  input: { bidId: string; attachmentId: string },
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM bid_attachments
    WHERE id = ${input.attachmentId} AND bid_id = ${input.bidId}
    RETURNING id
  `) as { id: string }[];

  return rows.length > 0;
}
