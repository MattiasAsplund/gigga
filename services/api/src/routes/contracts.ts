import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  BidIdParamsSchema,
  ContractIdParamsSchema,
  ContractResponseSchema,
} from '../schemas/contract.ts';
import {
  findContractById,
  findContractByBidForUpdate,
  insertContract,
  lockBidForSigning,
  settleAward,
  updateSignatures,
  type Contract,
  type ContractTerms,
  type SigningContext,
} from '../db/contracts.ts';
import {
  ensureContractDocument,
  generateContractDocument,
} from '../documents/contract-document.ts';
import { contractSignedEmail } from '../mail/contract-signed-email.ts';
import { findIdentityById } from '../db/identities.ts';
import { applySignature, isActive, type SignerRole } from '../domain/contract-rules.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import {
  bidNotFound,
  contractNotActive,
  contractNotFound,
  documentUnavailable,
  noContractYet,
  notAParty,
  validationFailed,
} from '../plugins/errors.ts';

function contractToResponse(contract: Contract) {
  return {
    contractId: contract.id,
    status: contract.status,
    buyerSignedAt: contract.buyerSignedAt?.toISOString() ?? null,
    sellerSignedAt: contract.sellerSignedAt?.toISOString() ?? null,
    terms: contract.terms,
  };
}

/** Ögonblicksbilden som avtalet vilar på. Tas en gång, när avtalet skapas. */
function freezeTerms(context: SigningContext, frozenAt: Date): ContractTerms {
  const { bid, request } = context;
  return {
    bidId: bid.id,
    requestId: request.id,
    buyerId: request.buyerId,
    sellerId: bid.sellerId,
    buyerOrganizationId: request.buyerOrganizationId,
    sellerOrganizationId: bid.sellerOrganizationId,
    requestTitle: request.title,
    plan: bid.plan,
    compensation: bid.compensation,
    estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
    frozenAt: frozenAt.toISOString(),
  };
}

/**
 * Content-Disposition med ett filnamn som kan innehålla vad som helst.
 *
 * `filename` är ASCII och är vad gamla klienter förstår; `filename*` bär originalet med
 * å, ä och ö. Den som förstår båda väljer den senare (RFC 6266).
 */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Följden av att avtalet blev bindande: dokumentet skrivs och båda parter får det i ett
 * brev.
 *
 * **Utanför transaktionen, och aldrig fällande.** Signaturen är det som gäller, och en
 * typsättningsmotor som ligger nere får inte kunna rulla tillbaka ett avtal.
 *
 * Brevet går ut även när typsättningen misslyckades. Länken pekar på en väg som sätter
 * dokumentet när den behöver det, så en part som klickar får sitt avtal — medan ett
 * uteblivet brev hade lämnat båda ovetande om att avtalet gäller.
 */
async function deliverContract(app: FastifyInstance, contract: Contract): Promise<void> {
  try {
    await generateContractDocument(
      { sql: app.sql, objects: app.objects, typst: app.typst },
      contract,
    );
  } catch (err) {
    app.log.error({ err, contractId: contract.id }, 'avtalsdokumentet kunde inte skrivas');
  }

  const url = `${app.publicBaseUrl()}/contracts/${contract.id}/document`;
  const [buyer, seller] = await Promise.all([
    findIdentityById(app.sql, contract.buyerSignedBy ?? contract.terms.buyerId),
    findIdentityById(app.sql, contract.sellerSignedBy ?? contract.terms.sellerId),
  ]);

  const recipients = [
    { identity: buyer, counterparty: seller },
    { identity: seller, counterparty: buyer },
  ];

  for (const { identity, counterparty } of recipients) {
    if (!identity) continue;
    await app.mailer.send(
      contractSignedEmail({
        to: identity.email,
        requestTitle: contract.terms.requestTitle,
        counterpartyName: counterparty?.organizationName ?? 'Motparten',
        documentUrl: url,
      }),
    );
  }
}

export const contractRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/bids/:bidId/contract/signatures',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'signContract',
        tags: ['contracts'],
        summary: 'Signera avtal',
        description:
          'Köparens signatur skapar avtalet med anbudets villkor frysta och innebär att ' +
          'anbudet antas. Säljarens signatur aktiverar avtalet, varvid förfrågan tilldelas ' +
          'och övriga anbud avslås. Idempotent: samma part kan signera flera gånger utan ' +
          'att något ändras.',
        security: [{ bearerAuth: [] }],
        params: BidIdParamsSchema,
        response: {
          200: ContractResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const now = new Date();
      const organizationId = req.identity.organizationId;

      let activated = false;

      const contract = await app.sql.begin(async (tx) => {
        // Låser förfrågningsraden — hela flödet nedan är serialiserat per förfrågan.
        const context = await lockBidForSigning(tx, req.params.bidId);
        if (!context) throw bidNotFound();

        // Parterna är företagen. Vem som håller i pennan får variera — den som
        // tecknar firman idag är inte nödvändigtvis den som skrev förfrågan i förrgår.
        const isBuyer = context.request.buyerOrganizationId === organizationId;
        const isSeller = context.bid.sellerOrganizationId === organizationId;
        if (!isBuyer && !isSeller) throw notAParty();
        const role: SignerRole = isBuyer ? 'buyer' : 'seller';

        const existing = await findContractByBidForUpdate(tx, req.params.bidId);

        if (!existing) {
          // Köparens signatur är det som skapar avtalet — säljaren har inget att signera än.
          if (role !== 'buyer') throw noContractYet();

          if (context.bid.status !== 'submitted') {
            throw validationFailed(
              [{ path: 'status', message: `anbudet är ${context.bid.status}, inte submitted` }],
              'Anbudet går inte att teckna avtal om.',
            );
          }
          if (context.request.status !== 'open') {
            throw validationFailed(
              [{ path: 'status', message: `förfrågan är ${context.request.status}, inte open` }],
              'Förfrågan är inte öppen längre.',
            );
          }

          return insertContract(tx, {
            requestId: context.request.id,
            bidId: context.bid.id,
            terms: freezeTerms(context, now),
            signedBy: req.identity.id,
            state: applySignature(
              { status: 'pending_signatures', buyerSignedAt: null, sellerSignedAt: null },
              'buyer',
              now,
            ),
          });
        }

        const next = applySignature(existing, role, now);

        // Redan signerat av den här parten: ingen skrivning, samma svar som förra gången.
        if (
          next.status === existing.status &&
          next.buyerSignedAt?.getTime() === existing.buyerSignedAt?.getTime() &&
          next.sellerSignedAt?.getTime() === existing.sellerSignedAt?.getTime()
        ) {
          return existing;
        }

        const updated = await updateSignatures(tx, existing.id, next, {
          role,
          userId: req.identity.id,
        });

        if (isActive(next) && !isActive(existing)) {
          activated = true;
          await settleAward(tx, {
            requestId: existing.requestId,
            winningBidId: existing.bidId,
          });
        }

        return updated;
      });

      // Först när transaktionen är committad: dokumentet ska aldrig kunna beskriva ett
      // avtal som rullades tillbaka.
      if (activated) {
        try {
          await deliverContract(app, contract);
        } catch (err) {
          app.log.error({ err, contractId: contract.id }, 'avtalet kunde inte levereras');
        }
      }

      return reply.code(200).send(contractToResponse(contract));
    },
  );

  app.get(
    '/contracts/:contractId/document',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'downloadContractDocument',
        tags: ['contracts'],
        summary: 'Hämta det signerade avtalet som PDF',
        description:
          'Dokumentet skrivs när båda parter signerat och ligger sedan i objektlagringen. ' +
          'Bara parterna kommer åt det. Saknas objektet — motorn var nere när avtalet ' +
          'slöts, eller lagringen har tappat det — sätts det om ur avtalets frysta ' +
          'villkor, som är desamma varje gång.',
        security: [{ bearerAuth: [] }],
        params: ContractIdParamsSchema,
        response: {
          200: {
            description: 'Avtalet som PDF, med uppdrag, datum och parterna i filnamnet.',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
          },
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const contract = await findContractById(app.sql, req.params.contractId);
      if (!contract) throw contractNotFound();

      // Parten är företaget: en kollega till den som signerade ska kunna hämta avtalet.
      const organizationId = req.identity.organizationId;
      const isParty =
        contract.terms.buyerOrganizationId === organizationId ||
        contract.terms.sellerOrganizationId === organizationId;
      if (!isParty) throw notAParty();

      if (contract.status !== 'active') throw contractNotActive();

      let document;
      try {
        document = await ensureContractDocument(
          { sql: app.sql, objects: app.objects, typst: app.typst },
          contract,
        );
      } catch (err) {
        app.log.error({ err, contractId: contract.id }, 'avtalsdokumentet kunde inte hämtas');
        throw documentUnavailable();
      }

      return reply
        .code(200)
        .header('content-type', 'application/pdf')
        .header('content-disposition', attachmentDisposition(document.filename))
        .send(Buffer.from(document.content) as unknown as string);
    },
  );
};
