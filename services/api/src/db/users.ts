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

/** Hur länge en verifieringslänk gäller. */
export const VERIFICATION_TTL_HOURS = 24;

export type VerificationResult =
  | { outcome: 'verified'; user: User }
  | { outcome: 'expired' }
  | { outcome: 'unknown' };

/**
 * Markerar adressen som verifierad.
 *
 * Tre utfall, för att "länken har gått ut" och "länken finns inte" kräver olika svar:
 * det första går att åtgärda med ett nytt bekräftelsemail, det andra inte.
 *
 * Idempotent: en redan verifierad användare returneras oförändrad även om tiden runnit
 * ut — annars skulle en länk som fungerade igår plötsligt bli ett fel (V.25).
 */
export async function verifyUserByToken(
  sql: SQL,
  token: string,
): Promise<VerificationResult> {
  const rows = (await sql`
    UPDATE users
    SET email_verified = true,
        verified_at = COALESCE(verified_at, now())
    WHERE verification_token = ${token}
      AND (email_verified = true OR verification_expires_at > now())
    RETURNING ${sql.unsafe(USER_COLUMNS)}
  `) as UserRow[];

  const row = rows[0];
  if (row) return { outcome: 'verified', user: toUser(row) };

  // Ingen rad uppdaterades: antingen finns token inte, eller så har den gått ut.
  const existing = (await sql`
    SELECT 1 AS finns FROM users WHERE verification_token = ${token}
  `) as { finns: number }[];

  return existing.length > 0 ? { outcome: 'expired' } : { outcome: 'unknown' };
}

/** Hur ofta ett nytt bekräftelsemail får skickas till samma adress. */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Roterar verifieringstoken inför ett nytt bekräftelsemail, och returnerar null om
 * inget mail ska skickas.
 *
 * Villkoren ligger i WHERE-satsen med flit: okänd adress, redan verifierat konto och
 * begäran inom kylperioden ger alla samma tomma resultat. Anroparen *kan* därför inte
 * råka svara olika i de tre fallen, vilket är vad som hindrar att endpointen används
 * för att kartlägga vilka adresser som är registrerade.
 *
 * Rotationen gör samtidigt att bara den senast utskickade länken gäller, och startar om
 * utgångstiden.
 */
export async function rotateVerificationToken(
  sql: SQL,
  email: string,
  cooldownSeconds = RESEND_COOLDOWN_SECONDS,
): Promise<{ user: User; verificationToken: string } | null> {
  const rows = (await sql`
    UPDATE users
    SET verification_token = gen_random_uuid(),
        verification_sent_at = now(),
        verification_expires_at = now() + make_interval(hours => ${VERIFICATION_TTL_HOURS})
    WHERE email = ${normalizeEmail(email)}
      AND email_verified = false
      AND verification_sent_at < now() - make_interval(secs => ${cooldownSeconds})
    RETURNING ${sql.unsafe(USER_COLUMNS)}
  `) as UserRow[];

  const row = rows[0];
  return row ? { user: toUser(row), verificationToken: row.verification_token } : null;
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

/** Hur länge en återställningskod gäller. Kortare än verifieringen — den är känsligare. */
export const PASSWORD_RESET_TTL_HOURS = 1;

export type PasswordResetResult =
  | { outcome: 'reset'; user: User }
  | { outcome: 'expired' }
  | { outcome: 'unknown' };

/**
 * Startar en återställning och returnerar null om inget mail ska skickas.
 *
 * Samma mönster som rotateVerificationToken: okänd adress och begäran inom kylperioden
 * ger båda tomt resultat, så routen kan inte råka svara olika och därmed inte användas
 * för att kartlägga registrerade adresser.
 *
 * Till skillnad från verifieringen görs ingen kontroll av `email_verified` — den som
 * glömt sitt lösenord ska kunna återställa det oavsett.
 */
export async function startPasswordReset(
  sql: SQL,
  email: string,
  cooldownSeconds = RESEND_COOLDOWN_SECONDS,
): Promise<{ user: User; resetToken: string } | null> {
  const rows = (await sql`
    UPDATE users
    SET password_reset_token = gen_random_uuid(),
        password_reset_sent_at = now(),
        password_reset_expires_at = now() + make_interval(hours => ${PASSWORD_RESET_TTL_HOURS})
    WHERE email = ${normalizeEmail(email)}
      AND (password_reset_sent_at IS NULL
           OR password_reset_sent_at < now() - make_interval(secs => ${cooldownSeconds}))
    RETURNING ${sql.unsafe(USER_COLUMNS)}, password_reset_token AS issued_token
  `) as (UserRow & { issued_token: string })[];

  const row = rows[0];
  return row ? { user: toUser(row), resetToken: row.issued_token } : null;
}

/**
 * Sätter det nya lösenordet och **bränner token** — den går bara att använda en gång.
 *
 * Samma tre utfall som verifieringen: utgången kod är åtgärdbar med en ny begäran,
 * okänd är det inte.
 */
export async function resetPasswordByToken(
  sql: SQL,
  token: string,
  passwordHash: string,
): Promise<PasswordResetResult> {
  const rows = (await sql`
    UPDATE users
    SET password_hash = ${passwordHash},
        password_reset_token = NULL,
        password_reset_expires_at = NULL
    WHERE password_reset_token = ${token}
      AND password_reset_expires_at > now()
    RETURNING ${sql.unsafe(USER_COLUMNS)}
  `) as UserRow[];

  const row = rows[0];
  if (row) return { outcome: 'reset', user: toUser(row) };

  const existing = (await sql`
    SELECT 1 AS finns FROM users WHERE password_reset_token = ${token}
  `) as { finns: number }[];

  return existing.length > 0 ? { outcome: 'expired' } : { outcome: 'unknown' };
}
