/** Alla anrop går genom Vites proxy, så webben och API:et delar origin. */
const BASE = '/api/v1';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

/** Ett felsvar från API:et, i RFC 9457-form. */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
    this.name = 'ApiError';
  }

  /** Fälten som inte höll måttet, som "budget.amountMinor: must be >= 1". */
  get fieldErrors(): string {
    return (this.problem.errors ?? [])
      .map((error) => `${error.path}: ${error.message}`)
      .join(', ');
  }
}

export interface Session {
  token: string;
  refreshToken: string;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method: options.method ?? (options.body || options.form ? 'POST' : 'GET'),
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });

  const payload = await parse(res);
  if (!res.ok) {
    throw new ApiError(
      (payload as Problem | null) ?? {
        type: 'about:blank',
        title: `Anropet misslyckades (${res.status})`,
        status: res.status,
      },
    );
  }
  return payload as T;
}

/** Öppnar en nedladdning i webbläsaren med rätt token i huvudet. */
export async function download(path: string, token: string, filename: string): Promise<void> {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError((await parse(res)) as Problem);

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- Modeller

export interface Money {
  amountMinor: number;
  currency?: string;
}

export type Compensation =
  | { type: 'fixed'; amountMinor: number; currency?: string }
  | { type: 'hourly'; rateMinor: number; estimatedHours: number; currency?: string };

export interface RequestSummary {
  id: string;
  buyerId: string;
  buyerOrganizationId: string;
  title: string;
  description: string;
  compensationPref: 'fixed' | 'hourly' | 'any';
  budget: Money | null;
  deadlineAt: string | null;
  status: 'open' | 'awarded' | 'cancelled';
  createdAt: string;
}

export interface CatalogItem extends RequestSummary {
  buyerDisplayName: string;
  bidCount: number;
  hasMyBid: boolean;
  /** Utan publicerad kravspec går uppdraget inte att bjuda på. */
  hasPublishedSpec: boolean;
  canBid: boolean;
}

export interface ContractSummary {
  id: string;
  status: 'pending_signatures' | 'active' | 'void';
  buyerSignedAt: string | null;
  sellerSignedAt: string | null;
}

export interface BidSummary {
  id: string;
  sellerId: string;
  sellerOrganizationId: string;
  sellerDisplayName: string;
  plan: string;
  compensation: Compensation;
  estimatedTotalMinor: number;
  status: 'submitted' | 'withdrawn' | 'accepted' | 'rejected';
  contract: ContractSummary | null;
  createdAt: string;
}

export interface RequestDetail extends RequestSummary {
  bids: BidSummary[];
}

export interface MyBid {
  id: string;
  requestId: string;
  requestTitle: string;
  plan: string;
  compensation: Compensation;
  estimatedTotalMinor: number;
  status: BidSummary['status'];
  contract: ContractSummary | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  bidId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  available: boolean;
  uploadedAt: string;
}

export interface Permission {
  requestId: string;
  userId: string;
  email: string;
  displayName: string;
  level: string;
  grantedAt: string;
}

export interface ContractTerms {
  bidId: string;
  requestId: string;
  buyerId: string;
  sellerId: string;
  buyerOrganizationId: string;
  sellerOrganizationId: string;
  requestTitle: string;
  plan: string;
  compensation: Compensation;
  estimatedTotalMinor: number;
  frozenAt: string;
}

export interface Contract {
  contractId: string;
  status: 'pending_signatures' | 'active' | 'void';
  buyerSignedAt: string | null;
  sellerSignedAt: string | null;
  terms: ContractTerms;
}

// ------------------------------------------------- Uppdragstyper och kravspec

/**
 * Frågorna kommer ur API:et, aldrig härifrån. Webben känner till *formerna* — vad en
 * `choice` är för sorts fält — men aldrig en enda frågenyckel. Nya uppdragstyper och
 * frågor tillkommer i katalogen och dyker upp i gränssnittet utan att den här filen ändras.
 */
export type QuestionKind =
  | 'text'
  | 'longtext'
  | 'choice'
  | 'multichoice'
  | 'bool'
  | 'integer'
  | 'date';

export type ClauseKind = 'criterion' | 'minimum' | 'exclusion' | 'term';

export interface GigType {
  key: string;
  name: string;
  summary: string | null;
  questionCount: number;
  criterionCount: number;
}

export interface QuestionCondition {
  question: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  answered?: boolean;
}

export interface InterviewQuestion {
  key: string;
  prompt: string;
  helpText: string | null;
  kind: QuestionKind;
  options: { key: string; label: string }[];
  config: Record<string, unknown>;
  required: boolean;
  condition: QuestionCondition | null;
  templateKey: string;
}

/** Frågan mitt i intervjun: villkoret är utvärderat, och svaret vet om det finns. */
export interface SpecQuestion extends InterviewQuestion {
  visible: boolean;
  answered: boolean;
}

export interface SpecAnswer {
  questionKey: string;
  prompt: string;
  value: unknown;
  answeredAt: string;
}

export interface SpecCriterion {
  id: string;
  kind: ClauseKind;
  statement: string;
  verification: string | null;
  position: number;
  origin: 'template' | 'custom';
  sourceTemplateKey: string | null;
  sourceClauseKey: string | null;
  status: 'pending' | 'met' | 'failed' | 'waived';
  approvedAt: string | null;
  approvedBy: string | null;
}

export interface Completeness {
  requiredQuestions: number;
  answeredRequired: number;
  criteria: number;
  approvedCriteria: number;
  publishable: boolean;
  blockers: { code: string; path: string | null; detail: string }[];
}

export interface RequestSpec {
  requestId: string;
  version: {
    id: string;
    version: number;
    status: 'draft' | 'published' | 'superseded';
    createdAt: string;
    publishedAt: string | null;
  };
  gigTypes: { key: string; name: string }[];
  questions: SpecQuestion[];
  answers: SpecAnswer[];
  criteria: SpecCriterion[];
  completeness: Completeness;
}

/**
 * Kravspecen om den finns. En förfrågan utan fastställd kravspec svarar 404, och det är
 * ett läge i flödet — inte ett fel att visa för användaren.
 */
export async function loadSpec(requestId: string, token: string): Promise<RequestSpec | null> {
  try {
    return await call<RequestSpec>(`/requests/${requestId}/spec`, { token });
  } catch (cause) {
    if (cause instanceof ApiError && cause.problem.status === 404) return null;
    throw cause;
  }
}

export const CLAUSE_HEADINGS: Record<ClauseKind, string> = {
  criterion: 'Acceptanskriterier',
  minimum: 'Alltid gällande minimikrav',
  exclusion: 'Ingår inte',
  term: 'Villkor',
};
