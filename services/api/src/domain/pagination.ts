/**
 * Sidbrytning på (created_at, id) i fallande ordning.
 *
 * Offset skulle tappa eller upprepa rader när nya poster tillkommer mitt i bläddringen.
 * Markören pekar på den sista raden i föregående sida, och nästa sida är allt som är
 * strikt äldre — id:t bryter likheten när två rader delar tidsstämpel.
 */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** Kastar vid trasig markör — routen översätter det till 422 med pekare på `cursor`. */
export function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw new Error('Markören saknar avgränsare.');

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime())) throw new Error('Markörens tidsstämpel är ogiltig.');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Markörens id är ogiltigt.');

  return { createdAt, id };
}

/**
 * Vi hämtar en rad mer än vad som ryms på sidan. Finns den extra raden vet vi att det
 * finns mer att hämta, utan en separat count-fråga.
 */
export function paginate<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
