import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';
import { MAX_FILENAME_LENGTH } from '../domain/attachments.ts';

export const BidIdParamsSchema = Type.Object({ bidId: UuidSchema });

export const AttachmentParamsSchema = Type.Object({
  bidId: UuidSchema,
  attachmentId: UuidSchema,
});

export const AttachmentResponseSchema = Type.Object({
  id: UuidSchema,
  bidId: UuidSchema,
  filename: Type.String(),
  contentType: Type.String({ examples: ['text/markdown', 'application/pdf'] }),
  sizeBytes: Type.Integer(),
  available: Type.Boolean({
    description:
      'Falskt om innehållet saknas i lagringen. Metadata finns kvar — raden är beviset ' +
      'på att dokumentet bifogats — men filen går inte att ladda ner.',
  }),
  uploadedAt: Type.String({ format: 'date-time' }),
});

export const AttachmentListResponseSchema = Type.Object({
  items: Type.Array(AttachmentResponseSchema),
});

export const RenameAttachmentBodySchema = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      maxLength: MAX_FILENAME_LENGTH,
      description: 'Nytt filnamn. Filändelsen måste behållas.',
    }),
  },
  { additionalProperties: false },
);

export const DeleteAttachmentResponseSchema = Type.Object({
  deleted: Type.Boolean(),
});
