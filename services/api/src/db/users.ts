import type { SQL } from 'bun';

/**
 * Den lokala speglingen av ett Keycloak-konto.
 *
 * Modulen är liten numera. Registrering, lösenord, bekräftelsekoder och återställning
 * hör hemma i Keycloak, och det som blev kvar här är uppslaget bakom "ge den här
 * adressen läsrätt" — det enda stället där gigga fortfarande letar upp en användare på
 * något annat än sin egen token. Speglingen i sig ligger i db/identities.ts.
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
  organizationId: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  organization_id: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  organizationId: row.organization_id,
});

/**
 * Adressen normaliseras före jämförelsen. Kolumnen är `citext` och skulle klara sig
 * ändå, men inledande blanksteg ur ett formulärfält gör den inte något åt.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export async function findUserByEmail(sql: SQL, email: string): Promise<User | null> {
  const rows = (await sql`
    SELECT id, email, display_name, organization_id
    FROM users
    WHERE email = ${normalizeEmail(email)}
  `) as UserRow[];

  const row = rows[0];
  return row ? toUser(row) : null;
}
