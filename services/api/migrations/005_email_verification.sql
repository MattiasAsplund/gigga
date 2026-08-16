-- E-postverifiering. Token är en egen uuid, inte användarens id: id:t syns i API-svaren
-- och i avtalens villkor, och får därför inte kunna användas för att verifiera ett konto.
ALTER TABLE users
  ADD COLUMN email_verified     boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_token uuid    NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN verified_at        timestamptz;

CREATE UNIQUE INDEX users_verification_token_idx ON users (verification_token);
