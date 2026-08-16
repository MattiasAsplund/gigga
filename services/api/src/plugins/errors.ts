import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_BASE = 'https://fastgig.dev/problems';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Ett fel som ska ut till klienten som RFC 9457 Problem Details.
 * Allt annat som kastas blir 500 utan detaljer — interna fel läcker aldrig ut.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;

  constructor(args: {
    status: number;
    slug: string;
    title: string;
    detail?: string;
    errors?: FieldError[];
  }) {
    super(args.detail ?? args.title);
    this.name = 'ProblemError';
    this.status = args.status;
    this.type = `${PROBLEM_BASE}/${args.slug}`;
    this.title = args.title;
    this.detail = args.detail;
    this.errors = args.errors;
  }

  toBody() {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.errors === undefined ? {} : { errors: this.errors }),
    };
  }
}

export const unauthorized = (detail = 'Autentisering krävs.') =>
  new ProblemError({ status: 401, slug: 'unauthorized', title: 'Ej autentiserad', detail });

export const invalidCredentials = () =>
  new ProblemError({
    status: 401,
    slug: 'invalid-credentials',
    title: 'Felaktiga inloggningsuppgifter',
    // Medvetet intetsägande: svaret får inte röja om kontot finns (A2.2/A2.3).
    detail: 'E-postadressen eller lösenordet stämmer inte.',
  });

/**
 * Semantiska valideringsfel som schemat inte kan uttrycka — t.ex. "deadline måste ligga
 * i framtiden". Samma form som schemabrotten, så klienten bara behöver hantera en.
 */
export const validationFailed = (errors: FieldError[], detail?: string) =>
  new ProblemError({
    status: 422,
    slug: 'validation-failed',
    title: 'Ogiltig indata',
    detail: detail ?? 'Begäran validerade inte mot reglerna.',
    errors,
  });

export const emailNotVerified = () =>
  new ProblemError({
    status: 403,
    slug: 'email-not-verified',
    title: 'E-postadressen är inte bekräftad',
    // Röjs först efter rätt lösenord, så det säger inget till den som gissar.
    detail: 'Klicka på länken i bekräftelsemailet innan du loggar in.',
  });

export const verificationTokenNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'verification-token-not-found',
    title: 'Verifieringslänken gäller inte',
    detail: 'Länken hör inte till något konto. Begär ett nytt bekräftelsemail.',
  });

export const verificationTokenExpired = () =>
  new ProblemError({
    status: 410,
    slug: 'verification-token-expired',
    title: 'Verifieringslänken har gått ut',
    detail: 'Begär ett nytt bekräftelsemail via /auth/resend-verification.',
  });

export const tokenRevoked = () =>
  new ProblemError({
    status: 401,
    slug: 'token-revoked',
    title: 'Sessionen har avslutats',
    // Bäraren har redan en signerad token för kontot, så det röjer inget att säga varför.
    detail: 'Lösenordet har ändrats sedan token utfärdades. Logga in igen.',
  });

export const refreshTokenInvalid = () =>
  new ProblemError({
    status: 401,
    slug: 'refresh-token-invalid',
    title: 'Refresh-token gäller inte',
    // Okänd, utgången och avslutad ger samma svar: skillnaden angår inte bäraren.
    detail: 'Token är okänd, utgången eller tillhör en avslutad session. Logga in igen.',
  });

export const refreshTokenReused = () =>
  new ProblemError({
    status: 401,
    slug: 'refresh-token-reused',
    title: 'Refresh-token har återanvänts',
    detail:
      'En redan förbrukad token användes igen, vilket tyder på att den läckt. Hela ' +
      'sessionen har avslutats. Logga in igen.',
  });

export const sessionEnded = () =>
  new ProblemError({
    status: 401,
    slug: 'session-ended',
    title: 'Sessionen är avslutad',
    detail: 'Du har loggat ut. Logga in igen för att fortsätta.',
  });

export const resetTokenNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'reset-token-not-found',
    title: 'Återställningskoden gäller inte',
    detail: 'Koden är okänd eller redan använd. Begär en ny återställning.',
  });

export const resetTokenExpired = () =>
  new ProblemError({
    status: 410,
    slug: 'reset-token-expired',
    title: 'Återställningskoden har gått ut',
    detail: 'Begär en ny via /auth/forgot-password.',
  });

export const emailTaken = () =>
  new ProblemError({
    status: 409,
    slug: 'email-taken',
    title: 'E-postadressen är upptagen',
    detail: 'Det finns redan ett konto med den adressen.',
  });

export const unsupportedFileType = (detail: string) =>
  new ProblemError({
    status: 415,
    slug: 'unsupported-file-type',
    title: 'Filtypen tas inte emot',
    detail,
  });

export const fileTooLarge = (maxBytes: number) =>
  new ProblemError({
    status: 413,
    slug: 'file-too-large',
    title: 'Filen är för stor',
    detail: `Högst ${Math.round(maxBytes / 1024 / 1024)} MB per dokument.`,
  });

export const tooManyFiles = (max: number) =>
  new ProblemError({
    status: 422,
    slug: 'too-many-attachments',
    title: 'För många dokument',
    detail: `Ett anbud kan ha högst ${max} dokument. Radera något först.`,
  });

export const filenameTaken = () =>
  new ProblemError({
    status: 409,
    slug: 'filename-taken',
    title: 'Filnamnet är upptaget',
    detail: 'Anbudet har redan ett dokument med det namnet.',
  });

export const attachmentNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'attachment-not-found',
    title: 'Dokumentet finns inte',
    detail: 'Det finns inget dokument med det id:t på anbudet.',
  });

export const notBidOwner = () =>
  new ProblemError({
    status: 403,
    slug: 'not-bid-owner',
    title: 'Inte anbudets ägare',
    detail: 'Bara säljaren som lämnat anbudet kan ändra dess dokument.',
  });

export const noAttachmentAccess = () =>
  new ProblemError({
    status: 403,
    slug: 'no-attachment-access',
    title: 'Saknar åtkomst till dokumenten',
    detail:
      'Anbudets dokument är öppna för säljaren, förfrågans köpare och den som ' +
      'tilldelats läsrätt på förfrågan.',
  });

export const userNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'user-not-found',
    title: 'Användaren finns inte',
    detail: 'Ingen användare med den e-postadressen.',
  });

export const notRequestOwner = () =>
  new ProblemError({
    status: 403,
    slug: 'not-request-owner',
    title: 'Inte förfrågans ägare',
    detail: 'Bara köparen som publicerat förfrågan kan hantera dess rättigheter.',
  });

export const noRequestAccess = () =>
  new ProblemError({
    status: 403,
    slug: 'no-request-access',
    title: 'Saknar åtkomst till förfrågan',
    detail: 'Du är varken förfrågans köpare eller tilldelad läsrätt.',
  });

export const permissionNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'permission-not-found',
    title: 'Rättigheten finns inte',
    detail: 'Användaren har ingen tilldelad rättighet på förfrågan.',
  });

export const requestNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'request-not-found',
    title: 'Förfrågan finns inte',
    detail: 'Det finns ingen uppdragsförfrågan med det id:t.',
  });

export const ownRequest = () =>
  new ProblemError({
    status: 403,
    slug: 'own-request',
    title: 'Egen förfrågan',
    detail: 'Du kan inte lämna anbud på en förfrågan du själv har publicerat.',
  });

export const bidExists = () =>
  new ProblemError({
    status: 409,
    slug: 'bid-exists',
    title: 'Anbud finns redan',
    detail: 'Du har redan ett aktivt anbud på den här förfrågan.',
  });

export const bidNotFound = () =>
  new ProblemError({
    status: 404,
    slug: 'bid-not-found',
    title: 'Anbudet finns inte',
    detail: 'Det finns inget anbud med det id:t.',
  });

export const notAParty = () =>
  new ProblemError({
    status: 403,
    slug: 'not-a-party',
    title: 'Inte part i avtalet',
    detail: 'Bara förfrågans köpare och anbudets säljare kan signera.',
  });

export const noContractYet = () =>
  new ProblemError({
    status: 409,
    slug: 'no-contract-yet',
    title: 'Inget avtal att signera',
    detail:
      'Köparen signerar först, vilket skapar avtalet. Det finns inget att signera ännu.',
  });

/**
 * Översätter Fastifys valideringsfel till 422 med fältpekare.
 * 400 är reserverat för trasig syntax; ett schemabrott är semantiskt (planens §8.1).
 */
function validationProblem(error: FastifyError): ProblemError {
  const errors: FieldError[] = (error.validation ?? []).map((v) => {
    const missing = (v.params as { missingProperty?: string } | undefined)?.missingProperty;
    const path = missing ?? v.instancePath.replace(/^\//, '').replace(/\//g, '.');
    return { path: path || '(body)', message: v.message ?? 'ogiltigt värde' };
  });

  return new ProblemError({
    status: 422,
    slug: 'validation-failed',
    title: 'Ogiltig indata',
    detail: 'Begäran validerade inte mot schemat.',
    errors,
  });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const problem =
      error instanceof ProblemError
        ? error
        : error.validation
          ? validationProblem(error)
          : null;

    if (problem) {
      return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem.toBody());
    }

    // Fastifys egna fel med en vettig statuskod (t.ex. trasig JSON) får passera som de är.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      const passthrough = new ProblemError({
        status: error.statusCode,
        slug: 'bad-request',
        title: 'Begäran kunde inte behandlas',
        detail: error.message,
      });
      return reply.code(passthrough.status).type(PROBLEM_CONTENT_TYPE).send(passthrough.toBody());
    }

    req.log.error({ err: error }, 'ohanterat fel');
    const internal = new ProblemError({
      status: 500,
      slug: 'internal-error',
      title: 'Internt fel',
    });
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(internal.toBody());
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const problem = new ProblemError({
      status: 404,
      slug: 'not-found',
      title: 'Resursen finns inte',
      detail: `Ingen route matchar ${req.method} ${req.url}.`,
    });
    return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem.toBody());
  });
}
