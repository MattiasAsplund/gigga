import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { App } from '../../src/server.ts';
import { signToken } from './keys.ts';

/**
 * En inloggad användare som bär sitt eget Authorization-huvud.
 * Testerna ska handla om domänen, inte om tokenhantering.
 *
 * Rollerna är inte fasta i modellen — samma organisation kan vara köpare i en förfrågan
 * och säljare i en annan. Namnet är bara en etikett som gör testet läsbart.
 *
 * Sedan Keycloak tog över identiteten skriver hjälparen sin token direkt istället för att
 * gå via registrering och bekräftelselänk. Det är inte en genväg förbi något: kontot
 * skapas ändå på riktigt, av `requireAuth`, vid aktörens första anrop — speglingen är
 * hela vägen dit gigga äger.
 */
export interface Actor {
  id: string;
  email: string;
  displayName: string;
  organization: string;
  organizationId: string;
  token: string;
  headers: { authorization: string };
  get(url: string, options?: InjectOptions): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown, options?: InjectOptions): Promise<LightMyRequestResponse>;
  patch(url: string, payload?: unknown, options?: InjectOptions): Promise<LightMyRequestResponse>;
  del(url: string, options?: InjectOptions): Promise<LightMyRequestResponse>;
}

let counter = 0;

export interface ActorOptions {
  /**
   * Aliaset i organization-claimen. Två aktörer med samma alias är kollegor.
   *
   * Utelämnas det får aktören ett företag för sig själv. Det är med flit: en svit som
   * skriver `actor(app, 'kim')` och `actor(app, 'robin')` menar två motparter, och skulle
   * de dela organisation vore robins anbud plötsligt ett anbud på den egna förfrågan.
   * Kollegor begärs uttryckligen, med `colleagueOf`.
   */
  organization?: string;
}

export async function actor(app: App, name: string, options: ActorOptions = {}): Promise<Actor> {
  const serial = ++counter;
  const organization = options.organization ?? `org-${serial}`;
  const email = `${name}-${serial}@example.test`;
  // Stabilt per aktör och skilt från e-posten: Keycloaks `sub` är en egen identitet, och
  // testerna ska inte råka bevisa något som bara gäller när de två följs åt.
  const subject = `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;

  const token = await signToken({
    subject,
    email,
    displayName: name,
    organizations: [organization],
  });
  const headers = { authorization: `Bearer ${token}` };

  const inject = (method: string) => (url: string, payload?: unknown, options: InjectOptions = {}) =>
    app.inject({
      method: method as InjectOptions['method'],
      url,
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
      ...options,
      headers: { ...headers, ...options.headers },
    });

  // Första anropet skapar speglingen. Att göra det här och inte lat gör att aktören har
  // ett `id` att jämföra mot innan testet ens börjat.
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  if (me.statusCode !== 200) {
    throw new Error(`Kunde inte spegla ${email}: ${me.statusCode} ${me.body}`);
  }
  const identity = me.json<{
    id: string;
    email: string;
    displayName: string;
    organization: { id: string; alias: string };
  }>();

  return {
    id: identity.id,
    email: identity.email,
    displayName: identity.displayName,
    organization: identity.organization.alias,
    organizationId: identity.organization.id,
    token,
    headers,
    get: (url, options) => inject('GET')(url, undefined, options),
    post: (url, payload, options) => inject('POST')(url, payload, options),
    patch: (url, payload, options) => inject('PATCH')(url, payload, options),
    del: (url, options) => inject('DELETE')(url, undefined, options),
  };
}

/** En kollega i samma organisation som en befintlig aktör. */
export function colleagueOf(app: App, other: Actor, name: string): Promise<Actor> {
  return actor(app, name, { organization: other.organization });
}
