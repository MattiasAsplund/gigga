-- Lösenordsåterställning. Egna kolumner, skilda från verifieringen: en
-- återställningstoken får aldrig kunna användas för att bekräfta en adress, eller tvärtom.
-- Alla tre är NULL när ingen återställning pågår.
ALTER TABLE users
  ADD COLUMN password_reset_token      uuid,
  ADD COLUMN password_reset_expires_at timestamptz,
  ADD COLUMN password_reset_sent_at    timestamptz;

CREATE UNIQUE INDEX users_password_reset_token_idx
  ON users (password_reset_token)
  WHERE password_reset_token IS NOT NULL;
