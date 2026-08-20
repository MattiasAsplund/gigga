import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  GigTypeListResponseSchema,
  InterviewQuerySchema,
  InterviewResponseSchema,
} from '../schemas/gig.ts';
import {
  findTemplatesByKeys,
  listGigTypes,
  loadInterview,
  loadTemplateClauses,
  type InterviewQuestion,
} from '../db/gig-catalog.ts';
import { validationFailed } from '../plugins/errors.ts';

/** Frågan som den lämnas ut i API:et. Katalogens form, inte databasens. */
export function questionToResponse(question: InterviewQuestion) {
  return {
    key: question.key,
    prompt: question.prompt,
    helpText: question.helpText,
    kind: question.kind,
    options: question.options,
    config: question.config,
    required: question.required,
    condition: question.condition,
    templateKey: question.templateKey,
  };
}

/** `?types=a,b` — kommaseparerat, för att en lista i en query-parameter inte har någon form. */
export function parseTypeKeys(value: string | undefined): string[] {
  if (!value) return [];

  return [
    ...new Set(
      value
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0),
    ),
  ];
}

export const gigTypeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/gig-types',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'listGigTypes',
        tags: ['gig-types'],
        summary: 'Lista uppdragstyper',
        description:
          'Typmallarna kunden väljer mellan i steg 1 av intervjun. Flera får väljas. ' +
          'Basmallen står inte med: dess frågor gäller varje gigg och läggs alltid på. ' +
          'Listan är data — nya typer tillkommer utan att API:et ändras.',
        security: [{ bearerAuth: [] }],
        response: { 200: GigTypeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema },
      },
    },
    async () => {
      const types = await listGigTypes(app.sql);

      return {
        items: types.map((type) => ({
          key: type.key,
          name: type.name,
          summary: type.summary,
          questionCount: type.questionCount,
          criterionCount: type.criterionCount,
        })),
      };
    },
  );

  app.get(
    '/gig-types/interview',
    {
      onRequest: app.requireAuth,
      schema: {
        operationId: 'previewGigInterview',
        tags: ['gig-types'],
        summary: 'Förhandsvisa intervjun för valda typer',
        description:
          'Basmallens frågor plus de valda typernas, sammanslagna: en fråga som flera ' +
          'typer ställer kommer med en gång. Svaret bär också utkastet till kriterier, ' +
          'minimikrav och ingår-inte. Används innan förfrågan har en kravspec.',
        security: [{ bearerAuth: [] }],
        querystring: InterviewQuerySchema,
        response: {
          200: InterviewResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req) => {
      const keys = parseTypeKeys(req.query.types);
      const templates = await findTemplatesByKeys(app.sql, keys);

      const found = new Set(templates.map((template) => template.key));
      const unknown = keys.filter((key) => !found.has(key));
      if (unknown.length > 0) {
        throw validationFailed(
          unknown.map((key) => ({ path: 'types', message: `okänd uppdragstyp: ${key}` })),
        );
      }

      const [questions, clauses] = await Promise.all([
        loadInterview(app.sql, keys),
        loadTemplateClauses(app.sql, keys),
      ]);

      return {
        types: templates.map((template) => ({ key: template.key, name: template.name })),
        questions: questions.map(questionToResponse),
        clauses,
      };
    },
  );
};
