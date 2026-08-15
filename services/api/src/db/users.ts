import type { SQL } from 'bun';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

export interface UserWithSecret extends User {
  passwordHash: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  createdAt: row.created_at,
});

/** Trim + gemener. Kolumnen är citext, men vi lagrar normaliserat så svaren blir förutsägbara. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Skapar användaren, eller returnerar null om adressen redan är tagen.
 *
 * ON CONFLICT DO NOTHING istället för att sniffa felkod 23505: konfliktfallet blir en
 * tom RETURNING, vilket är samma svar oavsett om två anrop krockar samtidigt.
 */
export async function insertUser(
  sql: SQL,
  input: { email: string; passwordHash: string; displayName: string },
): Promise<User | null> {
  const rows = (await sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${normalizeEmail(input.email)}, ${input.passwordHash}, ${input.displayName})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, display_name, password_hash, created_at
  `) as UserRow[];

  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function findUserByEmail(
  sql: SQL,
  email: string,
): Promise<UserWithSecret | null> {
  const rows = (await sql`
    SELECT id, email, display_name, password_hash, created_at
    FROM users
    WHERE email = ${normalizeEmail(email)}
  `) as UserRow[];

  const row = rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}
