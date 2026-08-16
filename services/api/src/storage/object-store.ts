import { AwsClient } from 'aws4fetch';

/**
 * Objektlagring för anbudsdokument.
 *
 * Filerna låg tidigare som `bytea` i Postgres. Det fungerade så länge databasen var
 * icke-persistent och allt dog tillsammans, men en driftsatt tjänst vill inte skicka
 * tio megabyte genom sin anslutningspool. Databasen bär nu bara nyckeln.
 */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ObjectStore {
  put(key: string, content: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /**
   * Objekten under ett prefix, en sida i taget. Sidvis och inte allt på en gång:
   * en bucket kan innehålla mer än vad som ryms i minnet.
   */
  listPages(prefix: string, pageSize?: number): AsyncIterable<StoredObject[]>;
  /** Skapar utrymmet om det inte finns. Anropas vid uppstart. */
  ensureReady(): Promise<void>;
}

export interface MemoryObjectEntry {
  content: Uint8Array;
  contentType: string;
  lastModified: Date;
}

export interface MemoryObjectStore extends ObjectStore {
  /** Allt som ligger lagrat. Testernas motsvarighet till att titta i bucketen. */
  readonly objects: Map<string, MemoryObjectEntry>;
}

/** För tester: lika snabb som en Map, för det är vad den är. */
export function createMemoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, MemoryObjectEntry>();

  return {
    objects,
    async put(key, content, contentType) {
      objects.set(key, {
        content: new Uint8Array(content),
        contentType,
        lastModified: new Date(),
      });
    },
    async get(key) {
      return objects.get(key)?.content ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async *listPages(prefix, pageSize = 1000) {
      const matching = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({
          key,
          size: entry.content.byteLength,
          lastModified: entry.lastModified,
        }));

      for (let i = 0; i < matching.length; i += pageSize) {
        yield matching.slice(i, i + pageSize);
      }
    },
    async ensureReady() {},
  };
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * S3-kompatibel lagring — MinIO i utvecklingsmiljön.
 *
 * Objekten går via `Bun.S3Client`, som är inbyggd. Bucketen skapas däremot med en
 * signerad förfrågan via `aws4fetch`: Bun.S3Client hanterar objekt, inte buckets, och
 * MinIO startar tom vid varje `aspire run`.
 */
export function createS3ObjectStore(config: S3Config): ObjectStore {
  const client = new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
  });

  return {
    async put(key, content, contentType) {
      await client.file(key).write(content, { type: contentType });
    },

    async get(key) {
      const file = client.file(key);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },

    async delete(key) {
      // Redan borta är ett godkänt utfall: raderingen ska gå att göra om.
      await client.file(key).delete().catch(() => {});
    },

    async *listPages(prefix, pageSize = 1000) {
      let continuationToken: string | undefined;

      do {
        const page = await client.list({ prefix, maxKeys: pageSize, continuationToken });

        yield (page.contents ?? []).map((object) => ({
          key: object.key,
          size: object.size ?? 0,
          // Saknad tidsstämpel behandlas som nyss ändrad: fristen ska hellre skona
          // ett objekt för länge än radera något som fortfarande används.
          lastModified: object.lastModified ? new Date(object.lastModified) : new Date(),
        }));

        continuationToken = page.isTruncated
          ? (page.nextContinuationToken ?? undefined)
          : undefined;
      } while (continuationToken);
    },

    async ensureReady() {
      const aws = new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: 's3',
        region: config.region,
      });

      const url = new URL(config.bucket, config.endpoint.replace(/\/*$/, '/'));
      const res = await aws.fetch(url.toString(), { method: 'PUT' });

      // 409 = bucketen finns redan, vilket är precis vad vi ville uppnå.
      if (!res.ok && res.status !== 409) {
        throw new Error(
          `Kunde inte skapa bucketen ${config.bucket}: ${res.status} ${await res.text()}`,
        );
      }
    },
  };
}

/** Nyckeln bär inte filnamnet — därför rör ett namnbyte aldrig lagringen. */
export const attachmentKey = (bidId: string, attachmentId: string): string =>
  `bids/${bidId}/${attachmentId}`;
