import { join } from 'node:path';

/**
 * Katalogens engelska lydelser — hämtade ur webbens locale-fil.
 *
 * API:et översätter ingenting i sina svar. Frågor, hjälptexter och kriterierader lagras
 * och skickas som **nycklar**, och webben slår upp dem på läsarens språk. Avtalsdokumentet
 * är undantaget, och bara för att det inte har någon läsare att fråga: det skrivs när den
 * andra signaturen faller, av tjänsten och inte av en webbläsare, och är alltid på engelska.
 *
 * **Ingen andra ordbok.** Texterna står redan i `services/web/src/locales/en-GB.json`, och
 * en kopia här hade glidit isär från den vid första nya frågan. Filen läses därifrån i
 * stället. Beroendet går åt samma håll som katalogen själv — nycklarna definieras i
 * `catalog/`, lydelserna i webbens locales — och är ett filberoende inom samma repo, inte
 * ett anrop mellan tjänsterna.
 */
const TEXTS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'web',
  'src',
  'locales',
  'en-GB.json',
);

let texts: Record<string, string> | null = null;

async function load(): Promise<Record<string, string>> {
  if (texts) return texts;

  try {
    texts = (await Bun.file(TEXTS_PATH).json()) as Record<string, string>;
  } catch {
    // Körs API:et utan webben bredvid sig blir dokumentet nycklar i klartext. Fult,
    // men läsbart — och bättre än ett avtal som vägrar bli till för en saknad fil.
    texts = {};
  }

  return texts;
}

/**
 * En översättare för katalogens nycklar.
 *
 * En nyckel som saknas returneras som den är — samma val som webbens `_()` gör.
 */
export async function englishTexts(): Promise<(key: string) => string> {
  const table = await load();
  return (key: string) => table[key] ?? key;
}
