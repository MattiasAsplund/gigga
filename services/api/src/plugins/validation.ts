import AjvCompiler from '@fastify/ajv-compiler';
import type { FastifyInstance } from 'fastify';

/**
 * Två valideringsregimer, för att de har olika jobb:
 *
 * - **body**: ingen typtvång. Skickar en klient `"4500000"` där ett heltal ska stå är det
 *   ett fel vi vill se, inte något vi tyst städar bort. Belopp är den känsliga biten.
 * - **querystring och params**: allt kommer in som strängar över HTTP, så `?limit=2` måste
 *   få bli talet 2. Utan typtvång vore ett heltal i en query-parameter omöjligt att
 *   uttrycka i schemat.
 *
 * Fastify har bara en validator-kompilator, så vi väljer regim per `httpPart`.
 */
/**
 * Tillåter tom kropp med `content-type: application/json`.
 *
 * Fastify avvisar annars med *"Body cannot be empty when content-type is set to
 * 'application/json'"* — och POST utan kropp är precis vad API 7 (signera avtal) är.
 * De flesta HTTP-klienter sätter content-type på varje POST oavsett om det finns en
 * kropp, så utan detta är routen obrukbar från fetch, curl och de flesta SDK:er.
 *
 * En tom kropp blir `undefined`, vilket för routes som *kräver* en kropp faller ut som
 * ett vanligt valideringsfel (422) istället för 400.
 */
function allowEmptyJsonBody(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text.trim() === '') return done(null, undefined);

      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const failure = err as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );
}

export function registerValidation(app: FastifyInstance): void {
  allowEmptyJsonBody(app);

  const factory = AjvCompiler();

  // factory(externalSchemas, options) — första argumentet är delade scheman, inte options.
  const strict = factory({}, { customOptions: { coerceTypes: false, removeAdditional: false } });
  const coercing = factory({}, { customOptions: { coerceTypes: true, removeAdditional: false } });

  app.setValidatorCompiler((route) =>
    route.httpPart === 'body' ? strict(route) : coercing(route),
  );
}
