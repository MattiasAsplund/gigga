import type { SQL } from 'bun';

/** Det API:et behöver ur en verifierad token för att veta vem som ringer. */
export interface IdentityClaims {
  subject: string;
  email: string;
  displayName: string;
  organizationAlias: string;
}

/** Den lokala identiteten — den domänen räknar med, inte den Keycloak känner till. */
export interface Identity {
  id: string;
  email: string;
  displayName: string;
  organizationId: string;
  organizationAlias: string;
  organizationName: string;
}

interface IdentityRow {
  id: string;
  email: string;
  display_name: string;
  organization_id: string;
  organization_alias: string;
  organization_name: string;
}

const toIdentity = (row: IdentityRow): Identity => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  organizationId: row.organization_id,
  organizationAlias: row.organization_alias,
  organizationName: row.organization_name,
});

const SELECT_IDENTITY = `
  SELECT u.id, u.email, u.display_name,
         o.id AS organization_id, o.alias AS organization_alias, o.name AS organization_name
  FROM users u
  JOIN organizations o ON o.id = u.organization_id
`;

/**
 * Speglar identiteten ur token till den lokala användarraden, och skapar den vid första
 * anropet.
 *
 * **Ett uppslag i normalfallet.** Läsningen först är inte en optimering på måfå: den
 * ersätter precis det uppslag `requireAuth` gjorde förut för tokenversion och bekräftad
 * adress, så en skyddad begäran kostar lika mycket som den gjorde innan. Skrivningen sker
 * bara när något faktiskt skiljer sig — första gången användaren syns, eller när
 * adressen, namnet eller organisationen ändrats i Keycloak.
 *
 * Att jämföra och inte blint skriva spelar roll: en `UPDATE` per begäran hade gjort varje
 * läsning till en skrivning, och därmed till en rad i WAL:en och ett lås på användarraden.
 */
export async function upsertIdentity(sql: SQL, claims: IdentityClaims): Promise<Identity> {
  const rows = (await sql`
    ${sql.unsafe(SELECT_IDENTITY)}
    WHERE u.keycloak_sub = ${claims.subject}
  `) as IdentityRow[];

  const known = rows[0];
  if (
    known &&
    known.email === claims.email &&
    known.display_name === claims.displayName &&
    known.organization_alias.toLowerCase() === claims.organizationAlias.toLowerCase()
  ) {
    return toIdentity(known);
  }

  /*
   * En transaktion, för att organisationen och användaren ska bli till tillsammans. Två
   * samtidiga förstagångsbesök från samma företag får annars kapplöpa om organisationen.
   *
   * `DO UPDATE SET alias = EXCLUDED.alias` är skrivningen som inte skriver något: den
   * finns för att `RETURNING` ska ge en rad även när raden redan fanns. `DO NOTHING`
   * returnerar tomt, och då hade vi behövt en läsning till.
   *
   * Namnet faller tillbaka på aliaset. Organisationens visningsnamn följer inte med i
   * organization-claimen — den bär bara alias — och API:et ska inte behöva Keycloaks
   * admin-API för att ta emot en begäran. Noterat som skuld i planen §10.
   */
  return await sql.begin(async (tx: SQL) => {
    const orgRows = (await tx`
      INSERT INTO organizations (alias, name)
      VALUES (${claims.organizationAlias}, ${claims.organizationAlias})
      ON CONFLICT (alias) DO UPDATE SET alias = EXCLUDED.alias
      RETURNING id, alias, name
    `) as { id: string; alias: string; name: string }[];

    const org = orgRows[0];
    if (!org) throw new Error('Organisationen kunde inte läsas tillbaka');

    const userRows = (await tx`
      INSERT INTO users (keycloak_sub, email, display_name, organization_id)
      VALUES (${claims.subject}, ${claims.email}, ${claims.displayName}, ${org.id})
      ON CONFLICT (keycloak_sub) DO UPDATE
        SET email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            organization_id = EXCLUDED.organization_id
      RETURNING id, email, display_name
    `) as { id: string; email: string; display_name: string }[];

    const user = userRows[0];
    if (!user) throw new Error('Användaren kunde inte läsas tillbaka');

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      organizationId: org.id,
      organizationAlias: org.alias,
      organizationName: org.name,
    };
  });
}
