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
export function registerValidation(app: FastifyInstance): void {
  const factory = AjvCompiler();

  // factory(externalSchemas, options) — första argumentet är delade scheman, inte options.
  const strict = factory({}, { customOptions: { coerceTypes: false, removeAdditional: false } });
  const coercing = factory({}, { customOptions: { coerceTypes: true, removeAdditional: false } });

  app.setValidatorCompiler((route) =>
    route.httpPart === 'body' ? strict(route) : coercing(route),
  );
}
