import { AwsClient } from 'aws4fetch';

/**
 * Objektlagring för anbudsdokument.
 *
 * Filerna låg tidigare som `bytea` i Postgres. Det fungerade så länge databasen var
 * icke-persistent och allt dog tillsammans, men en driftsatt tjänst vill inte skicka
 * tio megabyte genom sin anslutningspool. Databasen bär nu bara nyckeln.
 */
export interface ObjectStore {
  put(key: string, content: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Skapar utrymmet om det inte finns. Anropas vid uppstart. */
  ensureReady(): Promise<void>;
}

export interface MemoryObjectStore extends ObjectStore {
  /** Allt som ligger lagrat. Testernas motsvarighet till att titta i bucketen. */
  readonly objects: Map<string, { content: Uint8Array; contentType: string }>;
}

/** För tester: lika snabb som en Map, för det är vad den är. */
export function createMemoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, { content: Uint8Array; contentType: string }>();

  return {
    objects,
    async put(key, content, contentType) {
      objects.set(key, { content: new Uint8Array(content), contentType });
    },
    async get(key) {
      return objects.get(key)?.content ?? null;
    },
    async delete(key) {
      objects.delete(key);
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
