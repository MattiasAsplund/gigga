import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ProblemSchema } from '../schemas/common.ts';
import {
  LoginBodySchema,
  LoginResponseSchema,
  RegisterBodySchema,
  RegisterResponseSchema,
  ForgotPasswordBodySchema,
  ForgotPasswordResponseSchema,
  ResendVerificationBodySchema,
  ResendVerificationResponseSchema,
  ResetPasswordBodySchema,
  ResetPasswordResponseSchema,
  ValidateUserQuerySchema,
  ValidateUserResponseSchema,
} from '../schemas/auth.ts';
import {
  findUserByEmail,
  insertUser,
  normalizeEmail,
  resetPasswordByToken,
  rotateVerificationToken,
  startPasswordReset,
  verifyUserByToken,
  PASSWORD_RESET_TTL_HOURS,
  VERIFICATION_TTL_HOURS,
} from '../db/users.ts';
import {
  emailNotVerified,
  emailTaken,
  invalidCredentials,
  resetTokenExpired,
  resetTokenNotFound,
  verificationTokenExpired,
  verificationTokenNotFound,
} from '../plugins/errors.ts';
import { TOKEN_TTL_SECONDS } from '../plugins/auth.ts';
import { verificationEmail } from '../mail/verification-email.ts';
import { passwordResetEmail } from '../mail/password-reset-email.ts';

/**
 * En argon2id-hash av ett kasserat lösenord. Vid inloggning mot en okänd e-postadress
 * verifierar vi mot den istället för att returnera direkt — annars går det att skilja
 * "kontot finns inte" från "fel lösenord" på svarstiden (A2.2/A2.3).
 */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= Bun.password.hash('inte-ett-riktigt-losenord'));

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/auth/register',
    {
      schema: {
        operationId: 'register',
        tags: ['auth'],
        summary: 'Registrering av konto',
        description:
          'Skapar ett konto och returnerar en access-token. Rollen är inte fast — samma ' +
          'konto kan vara köpare i en förfrågan och säljare i en annan.',
        body: RegisterBodySchema,
        response: {
          201: RegisterResponseSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const { email, password, displayName } = req.body;

      const user = await insertUser(app.sql, {
        email,
        passwordHash: await Bun.password.hash(password),
        displayName,
      });

      if (!user) throw emailTaken();

      // Mailen skickas efter att kontot skapats, men innan svaret går ut: går den inte
      // fram är registreringen inte klar, och användaren ska få veta det direkt.
      await app.mailer.send(
        verificationEmail({
          to: user.email,
          displayName: user.displayName,
          baseUrl: app.publicBaseUrl(),
          token: user.verificationToken,
        }),
      );

      return reply.code(201).send({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
        token: app.issueToken(user.id, user.tokenVersion),
      });
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        operationId: 'login',
        tags: ['auth'],
        summary: 'Inloggning',
        body: LoginBodySchema,
        response: {
          200: LoginResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const { password } = req.body;
      const user = await findUserByEmail(app.sql, normalizeEmail(req.body.email));

      const matches = await Bun.password.verify(password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !matches) throw invalidCredentials();

      // Först efter rätt lösenord — annars gick det att kartlägga vilka adresser som
      // finns registrerade genom att jämföra 401 mot 403.
      if (!user.emailVerified) throw emailNotVerified();

      return reply.code(200).send({
        token: app.issueToken(user.id, user.tokenVersion),
        expiresIn: TOKEN_TTL_SECONDS,
      });
    },
  );

  app.get(
    '/validate-user',
    {
      schema: {
        operationId: 'validateUser',
        tags: ['auth'],
        summary: 'Bekräfta e-postadress',
        description:
          'Målet för länken i bekräftelsemailet. Sätter kontot som verifierat, vilket ' +
          'krävs för att kunna logga in. Idempotent — länken tål att klickas flera gånger. ' +
          `Gäller i ${VERIFICATION_TTL_HOURS} timmar; en passerad länk ger 410 och kan ` +
          'ersättas via /auth/resend-verification.',
        querystring: ValidateUserQuerySchema,
        response: {
          200: ValidateUserResponseSchema,
          404: ProblemSchema,
          410: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await verifyUserByToken(app.sql, req.query.token);
      if (result.outcome === 'expired') throw verificationTokenExpired();
      if (result.outcome === 'unknown') throw verificationTokenNotFound();

      return reply
        .code(200)
        .send({ verified: result.user.emailVerified, email: result.user.email });
    },
  );

  app.post(
    '/auth/resend-verification',
    {
      schema: {
        operationId: 'resendVerification',
        tags: ['auth'],
        summary: 'Begär ett nytt bekräftelsemail',
        description:
          'Skickar en ny verifieringslänk och gör den föregående ogiltig. Svaret är ' +
          'alltid 202 och identiskt oavsett om adressen finns, redan är bekräftad eller ' +
          'nyss fått ett mail — annars gick endpointen att använda för att kartlägga ' +
          'vilka adresser som är registrerade. En kylperiod hindrar upprepade utskick.',
        body: ResendVerificationBodySchema,
        response: {
          202: ResendVerificationResponseSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const rotated = await rotateVerificationToken(app.sql, req.body.email);

      // null betyder okänd adress, redan verifierad, eller inom kylperioden. Vilket
      // av dem vet vi inte här — och ska inte veta, se rotateVerificationToken.
      if (rotated) {
        await app.mailer.send(
          verificationEmail({
            to: rotated.user.email,
            displayName: rotated.user.displayName,
            baseUrl: app.publicBaseUrl(),
            token: rotated.verificationToken,
          }),
        );
      }

      return reply.code(202).send({ accepted: true });
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      schema: {
        operationId: 'forgotPassword',
        tags: ['auth'],
        summary: 'Begär lösenordsåterställning',
        description:
          'Skickar en återställningskod och gör en tidigare kod ogiltig. Svaret är alltid ' +
          '202 och identiskt oavsett om adressen finns — annars gick endpointen att ' +
          'använda för att kartlägga registrerade adresser. Samma kylperiod som för ' +
          'bekräftelsemail.',
        body: ForgotPasswordBodySchema,
        response: { 202: ForgotPasswordResponseSchema, 422: ProblemSchema },
      },
    },
    async (req, reply) => {
      const started = await startPasswordReset(app.sql, req.body.email);

      if (started) {
        await app.mailer.send(
          passwordResetEmail({
            to: started.user.email,
            displayName: started.user.displayName,
            token: started.resetToken,
            resetUrl: app.config.PASSWORD_RESET_URL || null,
            ttlHours: PASSWORD_RESET_TTL_HOURS,
          }),
        );
      }

      return reply.code(202).send({ accepted: true });
    },
  );

  app.post(
    '/auth/reset-password',
    {
      schema: {
        operationId: 'resetPassword',
        tags: ['auth'],
        summary: 'Sätt nytt lösenord med återställningskod',
        description:
          `Koden gäller i ${PASSWORD_RESET_TTL_HOURS} timme och bara en gång. Utgången ` +
          'kod ger 410, okänd eller redan använd ger 404. Bekräftar inte e-postadressen ' +
          '— det är ett eget flöde.',
        body: ResetPasswordBodySchema,
        response: {
          200: ResetPasswordResponseSchema,
          404: ProblemSchema,
          410: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await resetPasswordByToken(
        app.sql,
        req.body.token,
        await Bun.password.hash(req.body.password),
      );

      if (result.outcome === 'expired') throw resetTokenExpired();
      if (result.outcome === 'unknown') throw resetTokenNotFound();

      return reply.code(200).send({ reset: true, email: result.user.email });
    },
  );
};
