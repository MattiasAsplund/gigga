import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { emailNotVerified, sessionEnded, tokenRevoked, unauthorized } from './errors.ts';

/** Access-tokenens livslängd. Refresh-tokens är medvetet utelämnade i etapp 1 (planen §10). */
export const TOKEN_TTL_SECONDS = 60 * 60;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** `ver` speglar users.token_version vid utfärdandet, `jti` identifierar sessionen. */
    payload: { sub: string; ver: number; jti: string };
    user: { sub: string; ver: number; jti: string; exp?: number };
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

  // jti gör sessionen adresserbar: utan ett id går en enskild token inte att logga ut.
  app.decorate('issueToken', (userId: string, tokenVersion: number) =>
    app.jwt.sign({ sub: userId, ver: tokenVersion, jti: randomUUID() }),
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

    // Ett uppslag för alltihop: konto, tokenversion och om sessionen är utloggad.
    const rows = (await app.sql`
      SELECT u.email_verified,
             u.token_version,
             EXISTS (SELECT 1 FROM revoked_tokens r WHERE r.jti = ${req.user.jti}) AS revoked
      FROM users u
      WHERE u.id = ${req.user.sub}
    `) as { email_verified: boolean; token_version: number; revoked: boolean }[];

    const account = rows[0];
    // Giltig signatur men inget konto: token hör till något som inte finns längre.
    if (!account) throw unauthorized('Kontot finns inte längre.');

    // Versionen kommer gratis i samma uppslag som verifieringskontrollen. En token utan
    // `ver` — utfärdad innan versionerna fanns — matchar aldrig och avvisas.
    if (req.user.ver !== account.token_version) throw tokenRevoked();
    if (account.revoked) throw sessionEnded();

    if (!account.email_verified) throw emailNotVerified();
  });
}
