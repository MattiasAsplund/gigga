import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { App } from '../../src/server.ts';

/**
 * En registrerad användare som bär sitt eget Authorization-huvud.
 * Testerna ska handla om domänen, inte om token-hantering.
 *
 * Rollerna är inte fasta i modellen — samma konto kan vara köpare i en förfrågan och
 * säljare i en annan. Namnet är bara en etikett som gör testet läsbart.
 */
export interface Actor {
  id: string;
  email: string;
  displayName: string;
  token: string;
  headers: { authorization: string };
  get(url: string, options?: InjectOptions): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown, options?: InjectOptions): Promise<LightMyRequestResponse>;
  del(url: string, options?: InjectOptions): Promise<LightMyRequestResponse>;
}

export const DEFAULT_PASSWORD = 'ett-tillrackligt-langt-losenord';

let counter = 0;

interface RegisterBody {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

export async function actor(app: App, name: string, password = DEFAULT_PASSWORD): Promise<Actor> {
  const email = `${name}-${++counter}@example.test`;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password, displayName: name },
  });

  if (res.statusCode !== 201) {
    throw new Error(`Kunde inte registrera ${email}: ${res.statusCode} ${res.body}`);
  }

  // Kontot måste bekräftas för att kunna logga in. Vi går den riktiga vägen — hämtar
  // token ur databasen och anropar /validate-user — så varje test kör med en användare
  // som passerat verifieringen på riktigt.
  const rows = (await app.sql`
    SELECT verification_token FROM users WHERE email = ${email}
  `) as { verification_token: string }[];

  const verified = await app.inject({
    method: 'GET',
    url: `/api/v1/validate-user?token=${rows[0]!.verification_token}`,
  });
  if (verified.statusCode !== 200) {
    throw new Error(`Kunde inte verifiera ${email}: ${verified.statusCode} ${verified.body}`);
  }

  const body = res.json<RegisterBody>();
  const headers = { authorization: `Bearer ${body.token}` };

  return {
    id: body.id,
    email: body.email,
    displayName: body.displayName,
    token: body.token,
    headers,
    get: (url, options = {}) =>
      app.inject({ method: 'GET', url, ...options, headers: { ...headers, ...options.headers } }),
    post: (url, payload, options = {}) =>
      app.inject({
        method: 'POST',
        url,
        payload: payload as InjectOptions['payload'],
        ...options,
        headers: { ...headers, ...options.headers },
      }),
    del: (url, options = {}) =>
      app.inject({
        method: 'DELETE',
        url,
        ...options,
        headers: { ...headers, ...options.headers },
      }),
  };
}
