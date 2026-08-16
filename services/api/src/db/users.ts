import type { SQL } from 'bun';

export interface User {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: Date;
}

export interface UserWithSecret extends User {
  passwordHash: string;
}

/** Nyregistrerad användare, med den token som verifieringslänken bygger på. */
export interface NewUser extends User {
  verificationToken: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  email_verified: boolean;
  verification_token: string;
  created_at: Date;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  emailVerified: row.email_verified,
  createdAt: row.created_at,
});

const USER_COLUMNS =
  'id, email, display_name, password_hash, email_verified, verification_token, created_at';

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
): Promise<NewUser | null> {
  const rows = (await sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${normalizeEmail(input.email)}, ${input.passwordHash}, ${input.displayName})
    ON CONFLICT (email) DO NOTHING
    RETURNING ${sql.unsafe(USER_COLUMNS)}
  `) as UserRow[];

  const row = rows[0];
  return row ? { ...toUser(row), verificationToken: row.verification_token } : null;
}

/**
 * Markerar adressen som verifierad. Idempotent: en redan verifierad användare
 * returneras oförändrad, så att en länk som klickas två gånger inte blir ett fel.
 */
export async function verifyUserByToken(
  sql: SQL,
  token: string,
): Promise<User | null> {
  const rows = (await sql`
    UPDATE users
    SET email_verified = true,
        verified_at = COALESCE(verified_at, now())
    WHERE verification_token = ${token}
    RETURNING ${sql.unsafe(USER_COLUMNS)}
  `) as UserRow[];

  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function findUserByEmail(
  sql: SQL,
  email: string,
): Promise<UserWithSecret | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(USER_COLUMNS)}
    FROM users
    WHERE email = ${normalizeEmail(email)}
  `) as UserRow[];

  const row = rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}
