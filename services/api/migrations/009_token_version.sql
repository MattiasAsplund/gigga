-- Versionsnummer som varje utfärdad access-token bär med sig. Höjs vid lösenordsbyte,
-- vilket gör alla tidigare tokens ogiltiga utan att vi behöver ett sessionsregister.
ALTER TABLE users
  ADD COLUMN token_version integer NOT NULL DEFAULT 0;
