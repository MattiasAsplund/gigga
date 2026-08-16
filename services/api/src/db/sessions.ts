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
