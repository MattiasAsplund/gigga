import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { SQL } from 'bun';
import { ProblemSchema } from '../schemas/common.ts';
import {
  AddCriterionBodySchema,
  ChangeCriterionBodySchema,
  CriterionParamsSchema,
  OpenSpecBodySchema,
  RemoveCriterionResponseSchema,
  SaveAnswersBodySchema,
  SaveAnswersResponseSchema,
  SpecCriterionSchema,
  SpecParamsSchema,
  SpecResponseSchema,
} from '../schemas/gig.ts';
import { findRequestById } from '../db/requests.ts';
import { hasReadPermission } from '../db/permissions.ts';
import { findTemplatesByKeys, loadInterview } from '../db/gig-catalog.ts';
import {
  addCriterion,
  answerMap,
  approveCriterion,
  completenessOf,
  createDraftSpec,
  findCriterionOwner,
  findDraftSpec,
  findPublishedSpec,
  getSpec,
  openNextDraft,
  publishSpec,
  QuestionNotAskedError,
  removeCriterion,
  saveAnswers,
  SpecNotDraftError,
  UnknownGigTypeError,
  updateCriterion,
  type RequestSpec,
  type SpecCriterion,
} from '../db/request-specs.ts';
import { AnswerNotValidError } from '../domain/gig-answers.ts';
import { isConditionMet } from '../domain/gig-conditions.ts';
import {
  criterionNotFound,
  noPublishedSpec,
  notRequestOwner,
  requestNotFound,
  specExists,
  specNotDraft,
  specNotFound,
  specNotPublishable,
  validationFailed,
} from '../plugins/errors.ts';
import { questionToResponse } from './gig-types.ts';

/** Unik nyckel i Postgres. Två samtidiga försök att öppna kravspecen landar här. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { errno?: string }).errno === '23505';

/**
 * Domänens fel blir Problem Details. Modulerna under `db/` kastar egna feltyper i stället
 * för HTTP-koder — översättningen hör hemma här, i det lager som talar HTTP.
 */
function asProblem(err: unknown): never {
  if (err instanceof UnknownGigTypeError) {
    throw validationFailed(
      err.keys.map((key) => ({ path: 'gigTypes', message: `okänd uppdragstyp: ${key}` })),
    );
  }
  if (err instanceof QuestionNotAskedError) {
    throw validationFailed([
      { path: err.questionKey, message: 'ingår inte i intervjun för de valda typerna' },
    ]);
  }
  if (err instanceof AnswerNotValidError) {
    throw validationFailed([{ path: err.questionKey, message: err.issues.join('; ') }]);
  }
  if (err instanceof SpecNotDraftError) throw specNotDraft();
  if (isUniqueViolation(err)) throw specExists();

  throw err;
}

function criterionToResponse(criterion: SpecCriterion) {
  return {
    id: criterion.id,
    kind: criterion.kind,
    statement: criterion.statement,
    verification: criterion.verification,
    position: criterion.position,
    origin: criterion.origin,
    sourceTemplateKey: criterion.sourceTemplateKey,
    sourceClauseKey: criterion.sourceClauseKey,
    status: criterion.status,
    approvedAt: criterion.approvedAt?.toISOString() ?? null,
    approvedBy: criterion.approvedBy,
  };
}

/**
 * Kravspecen som JSON: versionen, intervjun med villkoren utvärderade mot lämnade svar,
 * och fullständighetsindikatorn. Frågorna följer med i svaret så att klienten aldrig
 * behöver känna till någon uppdragstyp — den renderar det den får.
 */
async function specToResponse(sql: SQL, spec: RequestSpec) {
  const [interview, completeness, types] = await Promise.all([
    loadInterview(sql, spec.typeKeys),
    completenessOf(sql, spec),
    findTemplatesByKeys(sql, spec.typeKeys),
  ]);

  const answers = answerMap(spec);

  return {
    requestId: spec.version.requestId,
    version: {
      id: spec.version.id,
      version: spec.version.version,
      status: spec.version.status,
      createdAt: spec.version.createdAt.toISOString(),
      publishedAt: spec.version.publishedAt?.toISOString() ?? null,
    },
    gigTypes: types.map((type) => ({ key: type.key, name: type.name })),
    questions: interview.map((question) => ({
      ...questionToResponse(question),
      visible: isConditionMet(question.condition, answers),
      answered: Object.hasOwn(answers, question.key),
    })),
    answers: spec.answers.map((answer) => ({
      questionKey: answer.questionKey,
      prompt: answer.prompt,
      value: answer.value,
      answeredAt: answer.answeredAt.toISOString(),
    })),
    criteria: spec.criteria.map(criterionToResponse),
    completeness,
  };
}

export const requestSpecRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Kravspecen är köparens arbete: bara köparorganisationen skriver i den. Att den
   * skrivs av flera händer är själva poängen — en kravspec är sällan en persons verk.
   */
  async function requireOwnedRequest(requestId: string, organizationId: string) {
    const request = await findRequestById(app.sql, requestId);
    if (!request) throw requestNotFound();
    if (request.buyerOrganizationId !== organizationId) throw notRequestOwner();
    return request;
  }

  /** Utkastet man skriver i. Finns inget är kravspecen antingen publicerad eller oöppnad. */
  async function requireDraft(requestId: string): Promise<RequestSpec> {
    const draft = await findDraftSpec(app.sql, requestId);
    if (draft) return draft;

    // Skillnaden mellan "publicerad" och "aldrig öppnad" är olika fel för anroparen.
    if (await findPublishedSpec(app.sql, requestId)) throw specNotDraft();
    throw specNotFound();
  }

  app.get(
    '/requests/:requestId/spec',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'getRequestSpec',
        tags: ['spec'],
        summary: 'Läs kravspecen',
        description:
          'Köparen och den med läsrätt ser sitt utkast; alla andra inloggade ser den ' +
          'publicerade versionen — det är den anbudet ska avse. Finns ingen publicerad ' +
          'version svarar API:et 404 för utomstående: ett utkast är köparens interna arbete.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        response: {
          200: SpecResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      const request = await findRequestById(app.sql, req.params.requestId);
      if (!request) throw requestNotFound();

      const insider =
        request.buyerOrganizationId === req.identity.organizationId ||
        (await hasReadPermission(app.sql, {
          requestId: request.id,
          userId: req.identity.id,
        }));

      const spec = insider
        ? ((await findDraftSpec(app.sql, request.id)) ??
          (await findPublishedSpec(app.sql, request.id)))
        : await findPublishedSpec(app.sql, request.id);

      if (!spec) throw specNotFound();
      return specToResponse(app.sql, spec);
    },
  );

  app.post(
    '/requests/:requestId/spec',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'openRequestSpec',
        tags: ['spec'],
        summary: 'Öppna kravspecen med valda uppdragstyper',
        description:
          'Steg 1 i intervjun. Typerna avgör vilka frågor som ställs och vilka ' +
          'kriterierader utkastet får. Flera typer får väljas — frågorna slås ihop. ' +
          'Kriterieraderna är kopior av mallens, så en senare ändring i katalogen rör ' +
          'inte den här kravspecen.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        body: OpenSpecBodySchema,
        response: {
          201: SpecResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);

      const existing =
        (await findDraftSpec(app.sql, req.params.requestId)) ??
        (await findPublishedSpec(app.sql, req.params.requestId));
      if (existing) throw specExists();

      const spec = await createDraftSpec(app.sql, {
        requestId: req.params.requestId,
        typeKeys: req.body.gigTypes,
      }).catch(asProblem);

      return reply.code(201).send(await specToResponse(app.sql, spec));
    },
  );

  app.post(
    '/requests/:requestId/spec/revisions',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'openSpecRevision',
        tags: ['spec'],
        summary: 'Öppna nästa utkast som kopia av den gällande versionen',
        description:
          'Vägen tillbaka in i intervjun när ett svar under den publika frågefasen ändrar ' +
          'omfattningen. Den publicerade versionen står kvar som gällande tills det nya ' +
          'utkastet publiceras, så anbud som kommer in under tiden avser en lydelse som ' +
          'inte flyttar sig.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        response: {
          201: SpecResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);

      // Ordningen är avsiktlig: finns ingen gällande version är det den som saknas, och
      // ett utkast som redan står öppet är först därefter det som är i vägen.
      if (!(await findPublishedSpec(app.sql, req.params.requestId))) throw noPublishedSpec();
      if (await findDraftSpec(app.sql, req.params.requestId)) throw specExists();

      const draft = await openNextDraft(app.sql, req.params.requestId).catch(asProblem);
      if (!draft) throw noPublishedSpec();

      return reply.code(201).send(await specToResponse(app.sql, draft));
    },
  );

  app.put(
    '/requests/:requestId/spec/answers',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'saveSpecAnswers',
        tags: ['spec'],
        summary: 'Spara svar på intervjufrågorna',
        description:
          'Ett steg i taget. Varje svar prövas mot frågans egen form — frågetypens schema ' +
          'skärpt av frågans gränser och alternativ — och hela steget avvisas om något ' +
          'inte håller. Ett nytt svar på samma fråga ersätter det gamla.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        body: SaveAnswersBodySchema,
        response: {
          200: SaveAnswersResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      const draft = await requireDraft(req.params.requestId);

      const saved = await saveAnswers(app.sql, {
        specVersionId: draft.version.id,
        answers: req.body.answers,
      }).catch(asProblem);

      const updated = await getSpec(app.sql, draft.version.id);
      if (!updated) throw specNotFound();

      return {
        answers: saved.map((answer) => ({
          questionKey: answer.questionKey,
          prompt: answer.prompt,
          value: answer.value,
          answeredAt: answer.answeredAt.toISOString(),
        })),
        completeness: await completenessOf(app.sql, updated),
      };
    },
  );

  app.post(
    '/requests/:requestId/spec/criteria',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'addSpecCriterion',
        tags: ['spec'],
        summary: 'Lägg till en egen rad i kravspecen',
        description:
          'Kundens eget kriterium, minimikrav, undantag eller villkor — samma formkrav som ' +
          'de mallen genererat.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        body: AddCriterionBodySchema,
        response: {
          201: SpecCriterionSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      const draft = await requireDraft(req.params.requestId);

      const criterion = await addCriterion(app.sql, {
        specVersionId: draft.version.id,
        kind: req.body.kind,
        statement: req.body.statement,
        verification: req.body.verification ?? null,
      }).catch(asProblem);

      return reply.code(201).send(criterionToResponse(criterion));
    },
  );

  /** Raden måste höra till den förfrågan som står i vägen — id:t i URL:en räcker inte. */
  async function requireCriterionIn(requestId: string, criterionId: string): Promise<void> {
    const owner = await findCriterionOwner(app.sql, criterionId);
    if (!owner || owner.requestId !== requestId) throw criterionNotFound();
  }

  app.patch(
    '/requests/:requestId/spec/criteria/:criterionId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'changeSpecCriterion',
        tags: ['spec'],
        summary: 'Skriv om en rad i kravspecen',
        description:
          'Ett tidigare godkännande faller: kunden har godkänt en text, inte ett radnummer, ' +
          'och en omskriven rad ska godkännas på nytt.',
        security: [{ bearerAuth: [] }],
        params: CriterionParamsSchema,
        body: ChangeCriterionBodySchema,
        response: {
          200: SpecCriterionSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      await requireCriterionIn(req.params.requestId, req.params.criterionId);

      const changed = await updateCriterion(app.sql, {
        criterionId: req.params.criterionId,
        ...(req.body.statement === undefined ? {} : { statement: req.body.statement }),
        ...(req.body.verification === undefined ? {} : { verification: req.body.verification }),
      }).catch(asProblem);

      if (!changed) throw criterionNotFound();
      return criterionToResponse(changed);
    },
  );

  app.delete(
    '/requests/:requestId/spec/criteria/:criterionId',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'removeSpecCriterion',
        tags: ['spec'],
        summary: 'Stryk en rad ur kravspecen',
        description:
          'Steg 4 i intervjun: kunden stryker och lägger till i utkastet till ingår-inte. ' +
          'Steget upplevs som irriterande och är det mest värdefulla.',
        security: [{ bearerAuth: [] }],
        params: CriterionParamsSchema,
        response: {
          200: RemoveCriterionResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      await requireCriterionIn(req.params.requestId, req.params.criterionId);

      const removed = await removeCriterion(app.sql, req.params.criterionId).catch(asProblem);
      if (!removed) throw criterionNotFound();

      return { removed };
    },
  );

  app.post(
    '/requests/:requestId/spec/criteria/:criterionId/approval',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'approveSpecCriterion',
        tags: ['spec'],
        summary: 'Godkänn en rad i kravspecen',
        description:
          'Steg 5: kunden godkänner varje rad aktivt, och godkännandet tidsstämplas med ' +
          'användaren. Det är också det som håller ansvaret för kravspecen hos kunden och ' +
          'inte hos gigga. Att godkänna igen är ofarligt.',
        security: [{ bearerAuth: [] }],
        params: CriterionParamsSchema,
        response: {
          200: SpecCriterionSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      await requireCriterionIn(req.params.requestId, req.params.criterionId);

      const approved = await approveCriterion(app.sql, {
        criterionId: req.params.criterionId,
        userId: req.identity.id,
      }).catch(asProblem);

      if (!approved) throw criterionNotFound();
      return criterionToResponse(approved);
    },
  );

  app.post(
    '/requests/:requestId/spec/publication',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'publishRequestSpec',
        tags: ['spec'],
        summary: 'Publicera kravspecen',
        description:
          'Publiceringskontrollen (steg 6): varje synlig obligatorisk fråga besvarad, minst ' +
          'tre acceptanskriterier, samtliga godkända av kunden och en ingår-inte-lista som ' +
          'inte är tom. Brister kommer tillbaka som 422 med en rad per brist. Efter ' +
          'publicering är lydelsen låst — anbuden binds till den.',
        security: [{ bearerAuth: [] }],
        params: SpecParamsSchema,
        response: {
          200: SpecResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      await requireOwnedRequest(req.params.requestId, req.identity.organizationId);
      const draft = await requireDraft(req.params.requestId);

      const result = await publishSpec(app.sql, draft.version.id).catch(asProblem);

      if (result.blockers) {
        throw specNotPublishable(
          result.blockers.map((blocker) => ({
            path: blocker.path ?? '(kravspecen)',
            message: blocker.detail,
          })),
        );
      }

      const published = await getSpec(app.sql, result.published.id);
      if (!published) throw specNotFound();

      return specToResponse(app.sql, published);
    },
  );
};
