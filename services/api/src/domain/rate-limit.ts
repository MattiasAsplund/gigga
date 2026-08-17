export interface RateLimitConfig {
  /** Antal anrop som släpps igenom per fönster och nyckel. */
  limit: number;
  /** Fönstrets längd i millisekunder. */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Sekunder tills fönstret öppnar igen. Alltid minst 1 när anropet nekats. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, now: number): RateLimitVerdict;
  /** Antal nycklar som hålls i minnet. Finns för att kunna vakta att kartan städas. */
  size(): number;
}

/**
 * Fast fönster i minnet: per nyckel räknas anrop tills fönstret löper ut, då räkningen
 * börjar om. Ingen klocka inuti — tiden kommer in som argument, vilket gör beteendet vid
 * fönsterbyte exakt testbart utan att någon behöver vänta.
 *
 * Fast fönster och inte glidande: ett glidande kräver att varje tidpunkt sparas, och
 * vinsten — att en anropare inte kan skicka 2 × limit över en fönstergräns — är inte värd
 * minnet för det som är ett skydd mot utskicksspam, inte en exakt kvot.
 *
 * **Räknarna lever i processen.** De nollställs vid omstart och delas inte mellan
 * instanser. Med en API-process, som AppHosten kör, är det tillräckligt; skalas tjänsten
 * ut behöver räknarna flytta till delad lagring.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const windows = new Map<string, { startedAt: number; count: number }>();

  /**
   * Kartan får inte växa av just den trafik gränsen finns för att stoppa: en angripare
   * som varierar nyckel skulle annars fylla minnet. Utgångna fönster rensas när ett nytt
   * anrop kommer, vilket räcker — det finns ingen last utan anrop.
   */
  function sweep(now: number): void {
    for (const [key, window] of windows) {
      if (now - window.startedAt >= config.windowMs) windows.delete(key);
    }
  }

  return {
    hit(key, now) {
      sweep(now);

      const window = windows.get(key);
      if (!window) {
        windows.set(key, { startedAt: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (window.count < config.limit) {
        window.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const msLeft = window.startedAt + config.windowMs - now;
      return {
        // Uppåt: 0 hade betytt "försök igen nu", vilket inte är sant.
        retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
        allowed: false,
      };
    },

    size() {
      return windows.size;
    },
  };
}
