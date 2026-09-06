import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  BidIdParamsSchema,
  BidResponseSchema,
  ChangeBidBodySchema,
  CreateBidBodySchema,
  RequestIdParamsSchema,
} from '../schemas/bid.ts';
import { findRequestById } from '../db/requests.ts';
import { findPublishedSpec } from '../db/request-specs.ts';
import { findBidById, insertBid, updateBid, withdrawBid, type Bid } from '../db/bids.ts';
import { findContractByBid } from '../db/contracts.ts';
import { estimatedTotalMinor } from '../domain/bid-rules.ts';
import { currencyOr } from '../domain/money.ts';
import {
  bidExists,
  bidNotFound,
  contractExists,
  notBidOwner,
  ownRequest,
  requestNotFound,
  specNotPublished,
  validationFailed,
} from '../plugins/errors.ts';

export function bidToResponse(bid: Bid) {
  return {
    id: bid.id,
    requestId: bid.requestId,
    sellerId: bid.sellerId,
    sellerOrganizationId: bid.sellerOrganizationId,
    plan: bid.plan,
    compensation: bid.compensation,
    estimatedTotalMinor: estimatedTotalMinor(bid.compensation),
    status: bid.status,
    createdAt: bid.createdAt.toISOString(),
  };
}

export const bidRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/requests/:requestId/bids',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'createBid',
        tags: ['bids'],
        summary: 'Registrera anbud',
        description:
          'Lämnar ett anbud med genomförandeplan och ersättningsform på en öppen ' +
          'förfrågan. En säljare kan ha ett aktivt anbud per förfrågan. Förfrågan måste ' +
          'ha en publicerad kravspec — anbudet binds till den lydelsen.',
        security: [{ bearerAuth: [] }],
        params: RequestIdParamsSchema,
        body: CreateBidBodySchema,
        response: {
          201: BidResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const request = await findRequestById(app.sql, req.params.requestId);
      if (!request) throw requestNotFound();

      // Ordningen är medveten: vem du är avgörs före förfrågans tillstånd, så en köpare
      // aldrig får veta något om sin egen förfrågan via en annan felkod.
      //
      // Jämförelsen går på organisationen. Regeln har alltid betytt "man bjuder inte på
      // sig själv", och med företag som part är kollegans förfrågan lika mycket ens egen.
      if (request.buyerOrganizationId === req.identity.organizationId) throw ownRequest();

      if (request.status !== 'open') {
        throw validationFailed(
          [{ path: 'status', message: `förfrågan är ${request.status}, inte open` }],
          'Förfrågan tar inte emot anbud längre.',
        );
      }

      if (request.deadlineAt && request.deadlineAt.getTime() <= Date.now()) {
        throw validationFailed(
          [{ path: 'deadlineAt', message: 'sista anbudsdag har passerat' }],
          'Förfrågans deadline har passerat.',
        );
      }

      /*
       * Utan publicerad kravspec finns ingen omfattning att prissätta, och anbudet skulle
       * inte gå att binda till någon lydelse (bids.spec_version_id). Kontrollen ligger
       * efter ägarskapet och förfrågans tillstånd: den säger något om köparens arbete,
       * och det angår bara den som faktiskt får bjuda.
       */
      if (!(await findPublishedSpec(app.sql, request.id))) throw specNotPublished();

      const bid = await insertBid(app.sql, {
        requestId: request.id,
        sellerId: req.identity.id,
        sellerOrganizationId: req.identity.organizationId,
        plan: req.body.plan,
        compensation: {
          ...req.body.compensation,
          currency: currencyOr(req.body.compensation.currency),
        },
      });

      if (!bid) throw bidExists();

      return reply.code(201).send(bidToResponse(bid));
    },
  );

  /**
   * Gemensamma spärrar för att röra ett befintligt anbud. Ordningen är medveten och
   * densamma som vid registrering: vem du är avgörs före tillstånd, så att ingen kan
   * kartlägga andras anbud på skillnaden mellan felkoderna.
   */
  async function requireChangeableBid(bidId: string, organizationId: string): Promise<Bid> {
    const bid = await findBidById(app.sql, bidId);
    if (!bid) throw bidNotFound();
    // Kollegan får ändra företagets anbud. Vem som skrev in det står kvar i seller_id.
    if (bid.sellerOrganizationId !== organizationId) throw notBidOwner();

    // Villkoren fryses i avtalet när köparen signerar (S7.7). Att låta anbudet glida
    // isär från dem vore att ha två sanningar om samma uppgörelse.
    if (await findContractByBid(app.sql, bidId)) throw contractExists();

    if (bid.status !== 'submitted') {
      throw validationFailed(
        [{ path: 'status', message: `anbudet är ${bid.status}, inte submitted` }],
        'Anbudet är inte längre aktivt.',
      );
    }

    const request = await findRequestById(app.sql, bid.requestId);
    if (!request) throw requestNotFound();

    if (request.status !== 'open') {
      throw validationFailed(
        [{ path: 'status', message: `förfrågan är ${request.status}, inte open` }],
        'Förfrågan tar inte emot ändringar längre.',
      );
    }

    if (request.deadlineAt && request.deadlineAt.getTime() <= Date.now()) {
      throw validationFailed(
        [{ path: 'deadlineAt', message: 'sista anbudsdag har passerat' }],
        'Förfrågans deadline har passerat.',
      );
    }

    return bid;
  }

  app.patch(
    '/bids/:bidId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'changeBid',
        tags: ['bids'],
        summary: 'Ändra anbud',
        description:
          'Skriver om genomförandeplanen, ersättningen eller båda. Bara säljaren som ' +
          'lämnat anbudet, och bara så länge förfrågan är öppen och inget avtal skapats. ' +
          'Ersättningen byts i sin helhet, inte fält för fält.',
        security: [{ bearerAuth: [] }],
        params: BidIdParamsSchema,
        body: ChangeBidBodySchema,
        response: {
          200: BidResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireChangeableBid(req.params.bidId, req.identity.organizationId);

      const compensation = req.body.compensation
        ? { ...req.body.compensation, currency: currencyOr(req.body.compensation.currency) }
        : null;

      const updated = await updateBid(app.sql, {
        bidId: req.params.bidId,
        plan: req.body.plan ?? null,
        compensation,
      });

      if (!updated) throw bidNotFound();
      return bidToResponse(updated);
    },
  );

  app.post(
    '/bids/:bidId/withdrawal',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'withdrawBid',
        tags: ['bids'],
        summary: 'Dra tillbaka anbud',
        description:
          'Sätter anbudet till `withdrawn`. Idempotent: att dra tillbaka ett redan ' +
          'tillbakadraget anbud svarar 200 med samma resultat. Ett tillbakadraget anbud ' +
          'räknas inte längre i katalogen, och säljaren får lämna ett nytt på förfrågan.',
        security: [{ bearerAuth: [] }],
        params: BidIdParamsSchema,
        response: {
          200: BidResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      // Ett redan tillbakadraget anbud får svara 200 med sig självt istället för att
      // falla på statusspärren — annars vore upprepningen inte ofarlig (Ä.12).
      const existing = await findBidById(app.sql, req.params.bidId);
      if (!existing) throw bidNotFound();
      if (existing.sellerOrganizationId !== req.identity.organizationId) throw notBidOwner();
      if (existing.status === 'withdrawn') return bidToResponse(existing);

      await requireChangeableBid(req.params.bidId, req.identity.organizationId);

      const withdrawn = await withdrawBid(app.sql, req.params.bidId);
      if (!withdrawn) throw bidNotFound();
      return bidToResponse(withdrawn);
    },
  );
};
