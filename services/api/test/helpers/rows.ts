import type { SQL } from 'bun';

/**
 * Rader direkt i databasen, förbi API:et.
 *
 * De db-nära sviterna bygger sina förutsättningar i SQL istället för att gå genom
 * routerna — det är hela poängen med dem. Sedan identiteten speglas från Keycloak bär en
 * användarrad både `keycloak_sub` och en organisation, och en förfrågan bär sin
 * köparorganisation, så det hör inte längre hemma som en INSERT per testfil.
 */

/** En organisation, med ett alias som inte krockar med någon annan testfils. */
export async function insertOrganization(sql: SQL, name = 'Testbolaget'): Promise<string> {
  const rows = (await sql`
    INSERT INTO organizations (alias, name)
    VALUES (${`org-${crypto.randomUUID()}`}, ${name})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

export interface InsertedUser {
  id: string;
  organizationId: string;
}

/**
 * En användare i en egen ny organisation, eller i en befintlig när `organizationId` ges
 * — det senare är hur man skriver en kollega.
 */
export async function insertUser(
  sql: SQL,
  options: { organizationId?: string; displayName?: string } = {},
): Promise<InsertedUser> {
  const organizationId = options.organizationId ?? (await insertOrganization(sql));
  const rows = (await sql`
    INSERT INTO users (keycloak_sub, email, display_name, organization_id)
    VALUES (${crypto.randomUUID()}, ${`u-${crypto.randomUUID()}@example.test`},
            ${options.displayName ?? 'Testperson'}, ${organizationId})
    RETURNING id
  `) as { id: string }[];
  return { id: rows[0]!.id, organizationId };
}
