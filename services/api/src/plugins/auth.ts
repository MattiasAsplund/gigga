import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import jwt from '@fastify/jwt';
import { emailNotVerified, tokenRevoked, unauthorized } from './errors.ts';

/** Access-tokenens livslängd. Refresh-tokens är medvetet utelämnade i etapp 1 (planen §10). */
export const TOKEN_TTL_SECONDS = 60 * 60;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** `ver` speglar users.token_version vid utfärdandet. */
    payload: { sub: string; ver: number };
    user: { sub: string; ver: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: onRequestHookHandler;
    issueToken(userId: string, tokenVersion: number): string;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: app.config.JWT_SECRET,
    sign: { expiresIn: TOKEN_TTL_SECONDS },
  });

  app.decorate('issueToken', (userId: string, tokenVersion: number) =>
    app.jwt.sign({ sub: userId, ver: tokenVersion }),
  );

  /**
   * onRequest-hook för skyddade routes. Alla misslyckanden med själva token — saknad,
   * utgången, manipulerad eller osignerad — ger samma 401 (A2.4).
   *
   * Därefter slås kontot upp: rätt tokenversion och bekräftad e-postadress. Det kostar en primärnyckelträff per skyddad begäran, och
   * alternativet — att baka in `email_verified` som claim i token — vore fel byte:
   * claimen blir inaktuell i samma stund användaren klickar på bekräftelselänken, och
   * en token utfärdad vid registreringen skulle då aldrig kunna börja fungera (V.11).
   */
  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized('Token saknas, är utgången eller ogiltig.');
    }

    const rows = (await app.sql`
      SELECT email_verified, token_version FROM users WHERE id = ${req.user.sub}
    `) as { email_verified: boolean; token_version: number }[];

    const account = rows[0];
    // Giltig signatur men inget konto: token hör till något som inte finns längre.
    if (!account) throw unauthorized('Kontot finns inte längre.');

    // Versionen kommer gratis i samma uppslag som verifieringskontrollen. En token utan
    // `ver` — utfärdad innan versionerna fanns — matchar aldrig och avvisas.
    if (req.user.ver !== account.token_version) throw tokenRevoked();

    if (!account.email_verified) throw emailNotVerified();
  });
}
