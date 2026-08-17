import { test, expect, beforeAll, afterAll } from 'bun:test';
import { buildTestApp, type TestApp } from '../helpers/app.ts';

let ctx: TestApp;
let doc: OpenApiDocument;

interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** API:erna ur planens §6, som operationId → metod och väg. */
const EXPECTED_OPERATIONS: Record<string, [string, string]> = {
  register: ['post', '/api/v1/auth/register'],
  login: ['post', '/api/v1/auth/login'],
  listMyRequests: ['get', '/api/v1/me/requests'],
  listMyBids: ['get', '/api/v1/me/bids'],
  createRequest: ['post', '/api/v1/requests'],
  createBid: ['post', '/api/v1/requests/{requestId}/bids'],
  changeBid: ['patch', '/api/v1/bids/{bidId}'],
  withdrawBid: ['post', '/api/v1/bids/{bidId}/withdrawal'],
  signContract: ['post', '/api/v1/bids/{bidId}/contract/signatures'],
  listOpenRequests: ['get', '/api/v1/requests'],
  // Klickas ur ett mail, alltså utan token — därför inte i PROTECTED.
  validateUser: ['get', '/api/v1/validate-user'],
  // Anropas av någon som inte kan logga in än, alltså också öppen.
  resendVerification: ['post', '/api/v1/auth/resend-verification'],
  forgotPassword: ['post', '/api/v1/auth/forgot-password'],
  resetPassword: ['post', '/api/v1/auth/reset-password'],
  logout: ['post', '/api/v1/auth/logout'],
  // Öppen: den som behöver refresha har ingen giltig access-token.
  refreshSession: ['post', '/api/v1/auth/refresh'],
  getRequest: ['get', '/api/v1/requests/{requestId}'],
  grantRequestPermission: ['post', '/api/v1/requests/{requestId}/permissions'],
  listRequestPermissions: ['get', '/api/v1/requests/{requestId}/permissions'],
  revokeRequestPermission: ['delete', '/api/v1/requests/{requestId}/permissions/{userId}'],
  uploadAttachment: ['post', '/api/v1/bids/{bidId}/attachments'],
  listAttachments: ['get', '/api/v1/bids/{bidId}/attachments'],
  downloadAttachmentArchive: ['get', '/api/v1/bids/{bidId}/attachments/archive'],
  renameAttachment: ['patch', '/api/v1/bids/{bidId}/attachments/{attachmentId}'],
  deleteAttachment: ['delete', '/api/v1/bids/{bidId}/attachments/{attachmentId}'],
};

/** Operationer som kräver token, och därmed ska deklarera bearerAuth. */
const PROTECTED = new Set([
  'listMyRequests',
  'listMyBids',
  'createRequest',
  'createBid',
  'changeBid',
  'withdrawBid',
  'signContract',
  'listOpenRequests',
  // Kräver token — det är just den sessionen som avslutas.
  'logout',
  'getRequest',
  'grantRequestPermission',
  'listRequestPermissions',
  'revokeRequestPermission',
  'uploadAttachment',
  'listAttachments',
  'downloadAttachmentArchive',
  'renameAttachment',
  'deleteAttachment',
]);

function operations(document: OpenApiDocument): { id: string; op: Operation; where: string }[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, op]) => ({
        id: op.operationId ?? '(saknas)',
        op,
        where: `${method.toUpperCase()} ${path}`,
      })),
  );
}

beforeAll(async () => {
  ctx = await buildTestApp();
  const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
  expect(res.statusCode).toBe(200);
  doc = res.json<OpenApiDocument>();
});

afterAll(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------- X.1

test('X.1 dokumentet är OpenAPI 3.1 med ifylld info', () => {
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.info.title).toBeTruthy();
  expect(doc.info.version).toBeTruthy();
  expect(doc.info.description).toBeTruthy();
});

test('X.1 alla API:erna finns på rätt metod och väg', () => {
  for (const [operationId, [method, path]] of Object.entries(EXPECTED_OPERATIONS)) {
    const op = doc.paths[path]?.[method];
    expect(op, `${method.toUpperCase()} ${path} saknas`).toBeDefined();
    expect(op!.operationId).toBe(operationId);
  }
});

test('X.1 API-ytan är exakt de deklarerade plus /health', () => {
  const surface = operations(doc)
    .map((o) => o.where)
    .sort();

  expect(surface).toEqual(
    [
      'GET /health',
      ...Object.values(EXPECTED_OPERATIONS).map(
        ([method, path]) => `${method.toUpperCase()} ${path}`,
      ),
    ].sort(),
  );
});

test('X.1 varje $ref går att slå upp i components', () => {
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.push(value);
      else walk(value);
    }
  };
  walk(doc.paths);

  for (const ref of refs) {
    expect(ref, `oväntad ref-form: ${ref}`).toStartWith('#/components/');
    const resolved = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown> | undefined)?.[key],
        doc as unknown,
      );
    expect(resolved, `${ref} går inte att slå upp`).toBeDefined();
  }
});

// ---------------------------------------------------------------- X.2

test('X.2 varje operation har unikt operationId, tags och summary', () => {
  const seen = new Set<string>();

  for (const { id, op, where } of operations(doc)) {
    expect(op.operationId, `${where} saknar operationId`).toBeTruthy();
    expect(seen.has(id), `${where} har ett operationId som redan används: ${id}`).toBe(false);
    seen.add(id);

    expect(op.tags?.length, `${where} saknar tags`).toBeGreaterThan(0);
    expect(op.summary, `${where} saknar summary`).toBeTruthy();
  }
});

test('X.2 varje felsvar är beskrivet och har en kropp', () => {
  for (const { op, where } of operations(doc)) {
    const failures = Object.entries(op.responses ?? {}).filter(([code]) =>
      code.startsWith('4'),
    );

    for (const [code, response] of failures) {
      expect(response.description, `${where} ${code} saknar beskrivning`).toBeTruthy();
      expect(
        response.content?.['application/json'],
        `${where} ${code} saknar kroppsschema`,
      ).toBeDefined();
    }
  }
});

test('X.2 skyddade operationer deklarerar bearerAuth, öppna gör det inte', () => {
  expect(doc.components?.securitySchemes?.bearerAuth).toBeDefined();

  for (const { id, op, where } of operations(doc)) {
    if (PROTECTED.has(id)) {
      expect(op.security, `${where} saknar security`).toEqual([{ bearerAuth: [] }]);
    } else {
      expect(op.security ?? [], `${where} ska inte kräva token`).toEqual([]);
    }
  }
});

test('X.2 varje skyddad operation dokumenterar 401 och 403', () => {
  // 403 gäller alla skyddade routes sedan requireAuth även kräver bekräftad e-post.
  for (const { id, op, where } of operations(doc)) {
    if (!PROTECTED.has(id)) continue;
    expect(op.responses?.['401'], `${where} dokumenterar inte 401`).toBeDefined();
    expect(op.responses?.['403'], `${where} dokumenterar inte 403`).toBeDefined();
  }
});

// ---------------------------------------------------------------- X.4

test('X.4 okänd väg ger 404 i Problem Details-format', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/finns-inte' });

  expect(res.statusCode).toBe(404);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json<{ type: string; title: string; status: number }>()).toMatchObject({
    type: 'https://fastgig.dev/problems/not-found',
    status: 404,
  });
});

test('X.4 fel metod på en känd väg ger 404 i samma format', async () => {
  const res = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/requests' });

  expect(res.statusCode).toBe(404);
  expect(res.json<{ type: string }>().type).toBe('https://fastgig.dev/problems/not-found');
});

test('X.4 felsvar från en riktig route är också problem+json', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/requests' });

  expect(res.statusCode).toBe(401);
  expect(res.headers['content-type']).toContain('application/problem+json');
});
