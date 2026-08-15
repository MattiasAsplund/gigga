import { decodeCursor, type Cursor } from '../domain/pagination.ts';
import { validationFailed } from '../plugins/errors.ts';

/**
 * Översätter en markör från query-strängen till domänform.
 *
 * Ligger i route-lagret, inte i `domain/pagination.ts`: översättningen till 422 är en
 * HTTP-angelägenhet och domänen ska inte känna till felsvar.
 */
export function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;

  try {
    return decodeCursor(raw);
  } catch {
    throw validationFailed(
      [{ path: 'cursor', message: 'markören går inte att tolka' }],
      'Använd `nextCursor` från föregående svar.',
    );
  }
}
