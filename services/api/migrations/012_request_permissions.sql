-- Delade läsrättigheter på en förfrågan. Köparen äger sin förfrågan och kan låta andra
-- läsa den — typiskt kollegor som ska bedöma anbuden.
CREATE TYPE permission_level AS ENUM ('read');

CREATE TABLE request_permissions (
  request_id uuid             NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id    uuid             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  level      permission_level NOT NULL DEFAULT 'read',
  granted_by uuid             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  granted_at timestamptz      NOT NULL DEFAULT now(),

  PRIMARY KEY (request_id, user_id)
);

-- "Vad har jag fått läsa?" — inte exponerat än, men gratis att förbereda.
CREATE INDEX request_permissions_user_idx ON request_permissions (user_id);
