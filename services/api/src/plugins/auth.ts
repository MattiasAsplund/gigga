import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import jwt from '@fastify/jwt';
import { unauthorized } from './errors.ts';

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
   * onRequest-hook för skyddade routes. Alla misslyckanden — saknad, utgången,
   * manipulerad eller osignerad token — ger samma 401 (A2.4).
   */
  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized('Token saknas, är utgången eller ogiltig.');
    }
  });
}
