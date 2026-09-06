import type { Page } from '@playwright/test';

/**
 * Keycloaks admin-API, så långt sviten behöver det.
 *
 * Sedan självregistreringen stängdes är **inbjudan enda vägen in**, och den skickas av en
 * admin. Det är hela svaret på vem som godkänner att någon blir medlem i ett företag: den
 * som redan är där och bjuder in.
 *
 * **Anropen görs inifrån webbläsaren**, inte från node. Keycloak bygger adresserna i sina
 * brev ur den begäran som utlöste dem, och sviten ser servern från två håll: webbläsaren
 * surfar på `localhost` (se playwright.config.ts) medan node når den på tunnelns värdnamn.
 * Skickas inbjudan från node pekar länken i brevet på tunneln, och när webbläsaren sedan
 * följer den på localhost avvisar Keycloak token — *"The link you clicked is no longer
 * valid"*. Samma origin i båda ändar, alltså. CORS är ingen fråga: /auth ligger på
 * webbens egen origin.
 *
 * Kontot är fast (`admin`/`admin`), satt av AppHosten. Se kommentaren vid
 * keycloak-resursen i apphost.mts.
 */
const REALM = 'gigga';
const user = process.env.KEYCLOAK_ADMIN_USER ?? 'admin';
const password = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

interface AdminCall {
  path: string;
  method?: string;
  form?: Record<string, string>;
  json?: unknown;
  user: string;
  password: string;
  realm: string;
}

/**
 * Kör en admin-begäran i sidans kontext. Sidan måste stå på gigga:s origin — anroparna
 * går via `ensureSignedOut`, som navigerar dit.
 */
async function admin(page: Page, call: Omit<AdminCall, 'user' | 'password' | 'realm'>): Promise<unknown> {
  return await page.evaluate(
    async ({ path, method, form, json, user, password, realm }: AdminCall) => {
      const base = `${location.origin}/auth`;

      const tokenRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'admin-cli',
          username: user,
          password,
          grant_type: 'password',
        }),
      });
      if (!tokenRes.ok) throw new Error(`admin-inloggning: ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const headers: Record<string, string> = { authorization: `Bearer ${access_token}` };
      let body: string | undefined;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      } else if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      }

      const res = await fetch(`${base}/admin/realms/${realm}${path}`, {
        method: method ?? 'GET',
        headers,
        body,
      });
      if (!res.ok) throw new Error(`${method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : await res.json().catch(() => null);
    },
    { ...call, user, password, realm: REALM } as AdminCall,
  );
}

async function organizationId(page: Page, alias: string): Promise<string> {
  const organizations = (await admin(page, { path: '/organizations' })) as {
    id: string;
    alias: string;
  }[];
  const organization = organizations.find((candidate) => candidate.alias === alias);
  if (!organization) {
    throw new Error(`Ingen organisation med aliaset ${alias}. Finns den i realm-filen?`);
  }
  return organization.id;
}

/**
 * Bjuder in en adress till en organisation. Brevet landar i mailpit som allt annat.
 *
 * Den som tar emot inbjudan sätter sitt lösenord och blir medlem i samma veva — och får
 * `VERIFY_EMAIL` kvar som krav, så adressen bekräftas efteråt. Ordningen är värdefull:
 * medlemskapet finns *före* bekräftelsen, vilket är precis vad gigga behöver för att
 * bekräftelselänken ska landa i katalogen och inte på ett 403.
 */
export async function inviteToOrganization(
  page: Page,
  email: string,
  alias: string,
  firstName: string,
  lastName = 'Testsson',
): Promise<void> {
  await admin(page, {
    path: `/organizations/${await organizationId(page, alias)}/members/invite-user`,
    method: 'POST',
    form: { email, firstName, lastName },
  });
}

/**
 * Ett konto som finns, är bekräftat, men inte hör till någon organisation.
 *
 * Går inte att få fram genom gränssnittet sedan självregistreringen stängdes — och det är
 * poängen. Läget uppstår ändå i drift (en indragen inbjudan, ett konto upplagt för hand),
 * och API:ets `403 organization-missing` måste vara prövat.
 */
export async function createUserWithoutOrganization(
  page: Page,
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  await admin(page, {
    path: '/users',
    method: 'POST',
    json: {
      username: email,
      email,
      firstName: displayName,
      lastName: 'Testsson',
      emailVerified: true,
      enabled: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    },
  });
}
