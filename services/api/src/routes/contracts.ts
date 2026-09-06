import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import { BidIdParamsSchema, ContractResponseSchema } from '../schemas/contract.ts';
import {
  findContractByBidForUpdate,
  insertContract,
  lockBidForSigning,
  settleAward,
  updateSignatures,
  type Contract,
  type ContractTerms,
  type SigningContext,
} from '../db/contracts.ts';
import { applySignature, isActive, type SignerRole } from '../domain/contract-rules.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import {
  bidNotFound,
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

        const updated = await updateSignatures(tx, existing.id, next);

        if (isActive(next) && !isActive(existing)) {
          await settleAward(tx, {
            requestId: existing.requestId,
            winningBidId: existing.bidId,
          });
        }

        return updated;
      });

      return reply.code(200).send(contractToResponse(contract));
    },
  );
};
