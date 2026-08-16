import type { SQL } from 'bun';

/**
 * Återkallade tokens. En stateless JWT går inte att ta tillbaka — bara att neka — så
 * utloggning innebär att sessionens id (`jti`) läggs här tills token ändå gått ut.
 */

/** Idempotent: att logga ut samma token igen ändrar ingenting. */
export async function revokeToken(
  sql: SQL,
  input: { jti: string; userId: string; expiresAt: Date },
): Promise<void> {
  await sql`
    INSERT INTO revoked_tokens (jti, user_id, expires_at)
    VALUES (${input.jti}, ${input.userId}, ${input.expiresAt})
    ON CONFLICT (jti) DO NOTHING
  `;
}

/**
 * Städar bort rader vars token ändå gått ut.
 *
 * Körs opportunistiskt vid utloggning i stället för som bakgrundsjobb: tabellen växer
 * bara när någon loggar ut, så det är precis då den behöver rensas.
 */
export async function purgeExpiredRevocations(sql: SQL): Promise<void> {
  await sql`DELETE FROM revoked_tokens WHERE expires_at < now()`;
}

// ---------------------------------------------------------------- Refresh-tokens

/** Livslängd på en refresh-token. Access-tokenens timme är oförändrad. */
export const REFRESH_TTL_DAYS = 30;
export const REFRESH_TTL_SECONDS = REFRESH_TTL_DAYS * 24 * 60 * 60;

/** SHA-256 räcker: hemligheten är 256 bitar slump, inte ett gissbart lösenord. */
const hashToken = (secret: string): string =>
  new Bun.CryptoHasher('sha256').update(secret).digest('hex');

const newSecret = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  .toString('base64url');

export interface IssuedRefreshToken {
  secret: string;
  sessionId: string;
  expiresAt: Date;
}

/** Startar en ny session, eller förlänger en befintlig vid rotation. */
export async function issueRefreshToken(
  sql: SQL,
  input: { userId: string; sessionId: string },
): Promise<IssuedRefreshToken> {
  const secret = newSecret();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

  await sql`
    INSERT INTO refresh_tokens (session_id, user_id, token_hash, expires_at)
    VALUES (${input.sessionId}, ${input.userId}, ${hashToken(secret)}, ${expiresAt})
  `;

  return { secret, sessionId: input.sessionId, expiresAt };
}

export type RefreshResult =
  | { outcome: 'rotated'; userId: string; sessionId: string; issued: IssuedRefreshToken }
  /** Token fanns men var redan förbrukad — den har läckt. Hela sessionen är död. */
  | { outcome: 'reused' }
  | { outcome: 'invalid' };

/**
 * Byter in en refresh-token mot en ny.
 *
 * Rotation med återanvändningsdetektering: varje token duger en gång. Dyker en redan
 * förbrukad token upp igen finns den på två ställen — den ursprungliga klienten och
 * någon annan — och då är det enda säkra att avsluta hela sessionen. Den som blev av
 * med sin token får logga in igen; den som stal den kommer ingenstans.
 */
export async function rotateRefreshToken(sql: SQL, secret: string): Promise<RefreshResult> {
  const hash = hashToken(secret);

  const rows = (await sql`
    SELECT session_id, user_id, expires_at, consumed_at, revoked_at
    FROM refresh_tokens
    WHERE token_hash = ${hash}
  `) as {
    session_id: string;
    user_id: string;
    expires_at: Date;
    consumed_at: Date | null;
    revoked_at: Date | null;
  }[];

  const row = rows[0];
  if (!row) return { outcome: 'invalid' };

  // Avslutad session först: den som loggat ut ska inte anklagas för att ha läckt token.
  if (row.revoked_at !== null) return { outcome: 'invalid' };

  if (row.consumed_at !== null) {
    await revokeSession(sql, row.session_id);
    return { outcome: 'reused' };
  }

  if (row.expires_at.getTime() <= Date.now()) return { outcome: 'invalid' };

  await sql`
    UPDATE refresh_tokens SET consumed_at = now() WHERE token_hash = ${hash}
  `;

  return {
    outcome: 'rotated',
    userId: row.user_id,
    sessionId: row.session_id,
    issued: await issueRefreshToken(sql, {
      userId: row.user_id,
      sessionId: row.session_id,
    }),
  };
}

/** Avslutar en session: alla refresh-tokens i kedjan slutar gälla. */
export async function revokeSession(sql: SQL, sessionId: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE session_id = ${sessionId}
  `;
}

/** Avslutar samtliga sessioner för ett konto. Används vid lösenordsbyte. */
export async function revokeAllSessions(sql: SQL, userId: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}
