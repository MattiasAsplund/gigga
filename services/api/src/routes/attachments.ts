import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import JSZip from 'jszip';
import { ProblemSchema } from '../schemas/common.ts';
import {
  AttachmentListResponseSchema,
  AttachmentParamsSchema,
  AttachmentResponseSchema,
  BidIdParamsSchema,
  DeleteAttachmentResponseSchema,
  RenameAttachmentBodySchema,
} from '../schemas/attachment.ts';
import {
  AttachmentError,
  CONTENT_TYPES,
  MAX_FILES_PER_BID,
  MAX_FILE_BYTES,
  assertContentMatchesKind,
  assertSameKind,
  kindFromFilename,
  sanitizeFilename,
} from '../domain/attachments.ts';
import {
  countAttachments,
  deleteAttachment,
  findAttachment,
  insertAttachment,
  listAttachments,
  listAttachmentsForArchive,
  renameAttachment,
  type Attachment,
} from '../db/attachments.ts';
import { attachmentKey } from '../storage/object-store.ts';
import { randomUUID } from 'node:crypto';
import { findBidById } from '../db/bids.ts';
import { findRequestById } from '../db/requests.ts';
import { hasReadPermission } from '../db/permissions.ts';
import {
  attachmentNotFound,
  bidNotFound,
  fileTooLarge,
  filenameTaken,
  noAttachmentAccess,
  notBidOwner,
  tooManyFiles,
  unsupportedFileType,
  validationFailed,
} from '../plugins/errors.ts';

function attachmentToResponse(attachment: Attachment) {
  return {
    id: attachment.id,
    bidId: attachment.bidId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    available: attachment.contentMissingSince === null,
    uploadedAt: attachment.uploadedAt.toISOString(),
  };
}

/**
 * Domänfelen bär skälet; översättningen till HTTP hör hemma här.
 *
 * Medietypen och filnamnet är två olika saker: en fil som inte är vad ändelsen utlovar
 * är 415, medan ett namn som inte duger är ett vanligt valideringsfel på ett fält.
 */
function toHttpError(error: unknown): never {
  if (error instanceof AttachmentError) {
    if (error.reason === 'unsupported-type' || error.reason === 'content-mismatch') {
      throw unsupportedFileType(error.message);
    }
    throw validationFailed([{ path: 'filename', message: error.message }]);
  }
  throw error;
}

export const attachmentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Anbudet plus dess förfrågan. Allt här hänger på båda. */
  async function loadBid(bidId: string) {
    const bid = await findBidById(app.sql, bidId);
    if (!bid) throw bidNotFound();

    const request = await findRequestById(app.sql, bid.requestId);
    if (!request) throw bidNotFound();

    return { bid, request };
  }

  /** Skriv: bara säljaren som lämnat anbudet. */
  async function requireBidOwner(bidId: string, userId: string) {
    const context = await loadBid(bidId);
    if (context.bid.sellerId !== userId) throw notBidOwner();
    return context;
  }

  /** Läs: säljaren, förfrågans köpare, eller den som tilldelats läsrätt. */
  async function requireReader(bidId: string, userId: string) {
    const context = await loadBid(bidId);

    const allowed =
      context.bid.sellerId === userId ||
      context.request.buyerId === userId ||
      (await hasReadPermission(app.sql, {
        requestId: context.request.id,
        userId,
      }));

    if (!allowed) throw noAttachmentAccess();
    return context;
  }

  app.post(
    '/bids/:bidId/attachments',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'uploadAttachment',
        tags: ['attachments'],
        summary: 'Ladda upp ett anbudsdokument',
        description:
          'Multipart med fältet `file`. Endast Markdown och PDF, kontrollerat på ' +
          `innehåll och inte bara filändelse. Högst ${MAX_FILES_PER_BID} dokument per ` +
          'anbud. Går att göra när som helst — avtalets frysta villkor berörs inte.',
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        params: BidIdParamsSchema,
        response: {
          201: AttachmentResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          413: ProblemSchema,
          415: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireBidOwner(req.params.bidId, req.user.sub);

      const upload = await req.file();
      if (!upload) {
        throw validationFailed([{ path: 'file', message: 'ingen fil bifogad' }]);
      }

      const content = await upload.toBuffer();
      // @fastify/multipart trunkerar tyst vid gränsen och flaggar det här.
      if (upload.file.truncated) throw fileTooLarge(MAX_FILE_BYTES);
      if (content.byteLength === 0) {
        throw validationFailed([{ path: 'file', message: 'filen är tom' }]);
      }

      let filename: string;
      let contentType: string;
      try {
        filename = sanitizeFilename(upload.filename);
        const kind = kindFromFilename(filename);
        assertContentMatchesKind(kind, content);
        contentType = CONTENT_TYPES[kind];
      } catch (error) {
        toHttpError(error);
      }

      if ((await countAttachments(app.sql, req.params.bidId)) >= MAX_FILES_PER_BID) {
        throw tooManyFiles(MAX_FILES_PER_BID);
      }

      // Objektet först, raden sedan: ett objekt utan rad är skräp som går att städa,
      // en rad utan objekt är ett dokument som inte går att ladda ner.
      const id = randomUUID();
      const storageKey = attachmentKey(req.params.bidId, id);
      await app.objects.put(storageKey, content, contentType);

      const attachment = await insertAttachment(app.sql, {
        id,
        bidId: req.params.bidId,
        filename,
        contentType,
        sizeBytes: content.byteLength,
        storageKey,
      });

      if (!attachment) {
        await app.objects.delete(storageKey);
        throw filenameTaken();
      }

      return reply.code(201).send(attachmentToResponse(attachment));
    },
  );

  app.get(
    '/bids/:bidId/attachments',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listAttachments',
        tags: ['attachments'],
        summary: 'Lista anbudets dokument',
        description:
          'Metadata, inte innehåll. Öppen för säljaren, förfrågans köpare och den som ' +
          'tilldelats läsrätt på förfrågan.',
        security: [{ bearerAuth: [] }],
        params: BidIdParamsSchema,
        response: {
          200: AttachmentListResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireReader(req.params.bidId, req.user.sub);

      const items = await listAttachments(app.sql, req.params.bidId);
      return { items: items.map(attachmentToResponse) };
    },
  );

  app.get(
    '/bids/:bidId/attachments/archive',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'downloadAttachmentArchive',
        tags: ['attachments'],
        summary: 'Ladda ner samtliga dokument som ZIP',
        description:
          'Ett anbud utan dokument ger ett tomt arkiv, inte 404 — frågan "vad har ' +
          'säljaren bifogat?" har svaret "ingenting", vilket inte är ett fel.',
        security: [{ bearerAuth: [] }],
        params: BidIdParamsSchema,
        response: {
          // Innehållstypen deklareras bara för 200. `produces` hade gällt hela
          // operationen och dokumenterat även felsvaren som zip — de är problem+json.
          200: {
            description: 'ZIP-arkiv med anbudets dokument.',
            content: {
              'application/zip': { schema: { type: 'string', format: 'binary' } },
            },
          },
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireReader(req.params.bidId, req.user.sub);

      const files = await listAttachmentsForArchive(app.sql, req.params.bidId);

      // JSZip och inte fflate: fflate sätter inte UTF-8-flaggan (bit 11) i ZIP-huvudet,
      // så `unzip` tolkar filnamnen som CP437 och "förslag.md" blir "f├╢rslag.md".
      // Att läsa tillbaka arkivet med samma bibliotek döljer felet helt.
      const zip = new JSZip();
      for (const file of files) {
        const content = await app.objects.get(file.storageKey);
        // Saknat objekt hoppas över hellre än att fälla hela nedladdningen: resten av
        // dokumenten är fortfarande vad mottagaren bad om. Sopjobbet markerar raden,
        // och `available: false` i dokumentlistan förklarar varför filen saknas.
        if (!content) {
          req.log.error({ storageKey: file.storageKey }, 'dokument saknas i lagringen');
          continue;
        }
        zip.file(file.filename, content);
      }

      const archive = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header(
          'content-disposition',
          `attachment; filename="anbud-${req.params.bidId}.zip"`,
        )
        .send(Buffer.from(archive) as unknown as string);
    },
  );

  app.patch(
    '/bids/:bidId/attachments/:attachmentId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'renameAttachment',
        tags: ['attachments'],
        summary: 'Byt filnamn på ett dokument',
        description: 'Filändelsen måste behållas — innehållet ändras inte av ett namnbyte.',
        security: [{ bearerAuth: [] }],
        params: AttachmentParamsSchema,
        body: RenameAttachmentBodySchema,
        response: {
          200: AttachmentResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          415: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireBidOwner(req.params.bidId, req.user.sub);

      const current = await findAttachment(app.sql, {
        bidId: req.params.bidId,
        attachmentId: req.params.attachmentId,
      });
      if (!current) throw attachmentNotFound();

      let filename: string;
      try {
        filename = sanitizeFilename(req.body.filename);
        assertSameKind(current.filename, filename);
      } catch (error) {
        toHttpError(error);
      }

      if (filename === current.filename) return attachmentToResponse(current);

      const renamed = await renameAttachment(app.sql, {
        bidId: req.params.bidId,
        attachmentId: req.params.attachmentId,
        filename,
      });
      if (!renamed) throw filenameTaken();

      return attachmentToResponse(renamed);
    },
  );

  app.delete(
    '/bids/:bidId/attachments/:attachmentId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'deleteAttachment',
        tags: ['attachments'],
        summary: 'Radera ett dokument',
        security: [{ bearerAuth: [] }],
        params: AttachmentParamsSchema,
        response: {
          200: DeleteAttachmentResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireBidOwner(req.params.bidId, req.user.sub);

      const storageKey = await deleteAttachment(app.sql, {
        bidId: req.params.bidId,
        attachmentId: req.params.attachmentId,
      });
      if (!storageKey) throw attachmentNotFound();

      await app.objects.delete(storageKey);

      return { deleted: true };
    },
  );
};
