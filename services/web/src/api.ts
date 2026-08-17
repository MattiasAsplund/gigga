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
