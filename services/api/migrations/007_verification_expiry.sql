-- Utgångstid på verifieringslänken. Utan den gäller varje gammalt bekräftelsemail
-- i inkorgen som nyckel till kontot, för alltid.
ALTER TABLE users
  ADD COLUMN verification_expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours';
