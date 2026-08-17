import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import { createRateLimiter } from '../domain/rate-limit.ts';
import { tooManyRequests } from './errors.ts';

/**
 * Grundvärden, satta i config: vad en människa rimligen behöver är ett bekräftelsemail
 * som inte kom fram, och ett par gånger till om det krånglar. Kylperioden per konto är
 * 60 sekunder, så fem försök på en kvart räcker med marginal för ärligt ärende — och
 * biter på den som varierar adressen för att kartlägga vilka konton som finns.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * onRequest-hook som kvoterar per anropare och hink. Skilda hinkar räknas var för
     * sig, så att ett tak på en endpoint inte stänger en annan.
     */
    rateLimit(bucket: string): onRequestHookHandler;
  }
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const limiter = createRateLimiter({
    limit: app.config.AUTH_RATE_LIMIT_PER_WINDOW,
    windowMs: app.config.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  });

  app.decorate('rateLimit', (bucket: string): onRequestHookHandler => {
    return async (req, reply) => {
      // req.ip är socketens adress, eller första adressen i x-forwarded-for när
      // trustProxy är på — vilket den är, för annars ser alla webbläsaranrop ut att
      // komma från Vites proxy och skulle dela ett och samma tak.
      const verdict = limiter.hit(`${bucket}:${req.ip}`, Date.now());
      if (verdict.allowed) return;

      // Hooken körs före hanteraren, så ett kvoterat anrop skickar aldrig något mail.
      void reply.header('retry-after', String(verdict.retryAfterSeconds));
      throw tooManyRequests(verdict.retryAfterSeconds);
    };
  });
}
