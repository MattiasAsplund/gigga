-- Utloggning av en stateless token: den kan inte tas tillbaka, bara nekas.
-- Varje token bär ett eget id (jti) som läggs här när sessionen avslutas.
--
-- Tabellen hålls liten av sig själv: en rad behövs bara tills token ändå gått ut,
-- och utgångna rader städas bort vid nästa utloggning.
CREATE TABLE revoked_tokens (
  jti        uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);
