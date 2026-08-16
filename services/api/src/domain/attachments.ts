/**
 * Regler för anbudsdokument. Ren logik, ingen databas — filnamnssanering och
 * innehållskontroll är precis den sortens saker som ska gå att pröva utan I/O.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_BID = 20;
export const MAX_FILENAME_LENGTH = 200;

export type AttachmentKind = 'markdown' | 'pdf';

export const CONTENT_TYPES: Record<AttachmentKind, string> = {
  markdown: 'text/markdown',
  pdf: 'application/pdf',
};

const EXTENSIONS: Record<AttachmentKind, string[]> = {
  markdown: ['.md', '.markdown'],
  pdf: ['.pdf'],
};

export class AttachmentError extends Error {
  constructor(
    readonly reason:
      /** Ändelsen känns inte igen, eller innehållet är inte vad den utlovar. */
      | 'unsupported-type'
      | 'content-mismatch'
      /** Namnet går inte att använda — ett fält i begäran, inte ett medietypsfel. */
      | 'invalid-filename'
      | 'extension-changed',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * Rensar bort allt som gör ett filnamn farligt när arkivet packas upp någon annanstans:
 * sökvägar, `..`, kontrolltecken. Behåller åäö — arkivet ska vara läsbart.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    // eslint-disable-next-line no-control-regex
    // Kontrolltecken: osynliga i ett filnamn, otrevliga i ett arkiv.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();

  if (base.length === 0 || base.length > MAX_FILENAME_LENGTH) {
    throw new AttachmentError(
      'invalid-filename',
      `Filnamnet måste vara 1–${MAX_FILENAME_LENGTH} tecken efter sanering.`,
    );
  }
  return base;
}

/** Vilken sorts dokument filändelsen utlovar. */
export function kindFromFilename(filename: string): AttachmentKind {
  const lower = filename.toLowerCase();

  for (const [kind, extensions] of Object.entries(EXTENSIONS) as [
    AttachmentKind,
    string[],
  ][]) {
    if (extensions.some((extension) => lower.endsWith(extension))) return kind;
  }

  throw new AttachmentError(
    'unsupported-type',
    'Endast Markdown (.md, .markdown) och PDF (.pdf) tas emot.',
  );
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

/**
 * Kontrollerar att innehållet är vad ändelsen påstår.
 *
 * Filändelsen är ett påstående från klienten; den här kontrollen är vad som gör att en
 * körbar fil inte kan smugglas in som `anbud.pdf`.
 */
export function assertContentMatchesKind(kind: AttachmentKind, content: Uint8Array): void {
  if (kind === 'pdf') {
    const matches =
      content.length >= PDF_MAGIC.length &&
      PDF_MAGIC.every((byte, index) => content[index] === byte);

    if (!matches) {
      throw new AttachmentError('content-mismatch', 'Filen börjar inte med %PDF-.');
    }
    return;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new AttachmentError('content-mismatch', 'Markdown måste vara giltig UTF-8.');
  }
}

/** Filändelsen får inte bytas vid namnbyte — innehållet ändras ju inte. */
export function assertSameKind(current: string, next: string): void {
  if (kindFromFilename(current) !== kindFromFilename(next)) {
    throw new AttachmentError(
      'extension-changed',
      'Filändelsen måste behållas — innehållet är detsamma.',
    );
  }
}
