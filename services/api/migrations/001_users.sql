-- citext gör e-postjämförelser skiftlägesokänsliga i databasen istället för i koden.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext      NOT NULL UNIQUE,
  password_hash  text        NOT NULL,
  display_name   text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
