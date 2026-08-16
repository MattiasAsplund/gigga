import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import jwt from '@fastify/jwt';
import { emailNotVerified, unauthorized } from './errors.ts';

/** Access-tokenens livslängd. Refresh-tokens är medvetet utelämnade i etapp 1 (planen §10). */
export const TOKEN_TTL_SECONDS = 60 * 60;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: onRequestHookHandler;
    issueToken(userId: string): string;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: app.config.JWT_SECRET,
    sign: { expiresIn: TOKEN_TTL_SECONDS },
  });

  app.decorate('issueToken', (userId: string) => app.jwt.sign({ sub: userId }));

  /**
   * onRequest-hook för skyddade routes. Alla misslyckanden med själva token — saknad,
   * utgången, manipulerad eller osignerad — ger samma 401 (A2.4).
   *
   * Därefter slås kontot upp. Det kostar en primärnyckelträff per skyddad begäran, och
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
      SELECT email_verified FROM users WHERE id = ${req.user.sub}
    `) as { email_verified: boolean }[];

    const account = rows[0];
    // Giltig signatur men inget konto: token hör till något som inte finns längre.
    if (!account) throw unauthorized('Kontot finns inte längre.');
    if (!account.email_verified) throw emailNotVerified();
  });
}
