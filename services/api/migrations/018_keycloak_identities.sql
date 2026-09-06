-- Identiteten flyttar till Keycloak. Kvar i Postgres blir en spegling: den lokala
-- användarraden som alla främmande nycklar redan pekar på, plus organisationen hen
-- handlar för.
--
-- Ingen bakfyllnad, ingen dubbelskrivningsperiod: databasen har ingen volym och är tom
-- vid varje start (planen §1). Det gör en destruktiv migration både trygg och ärlig —
-- alternativet vore kolumner som ligger kvar och ljuger om att de används.

-- Organisationen är part i affären. `alias` är det Keycloak stoppar i organization-
-- claimen, och därmed det enda vi behöver för att känna igen ett företag — inget
-- uppslag mot admin-API:et.
CREATE TABLE organizations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alias      citext      NOT NULL UNIQUE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- users.id står kvar som primärnyckel. Det är hela poängen med en spegling: requests,
-- bids, contracts och request_permissions rör sig inte ur fläcken, och Keycloaks `sub`
-- blir en alternativnyckel istället för en ny identitet att skriva om domänen kring.
ALTER TABLE users
  ADD COLUMN keycloak_sub    text NOT NULL UNIQUE,
  ADD COLUMN organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT;

-- Lösenord, bekräftelsekoder, återställningskoder och tokenversioner hör hemma i
-- Keycloak nu. Indexen faller med sina kolumner.
ALTER TABLE users
  DROP COLUMN password_hash,
  DROP COLUMN email_verified,
  DROP COLUMN verification_token,
  DROP COLUMN verified_at,
  DROP COLUMN verification_sent_at,
  DROP COLUMN verification_expires_at,
  DROP COLUMN password_reset_token,
  DROP COLUMN password_reset_expires_at,
  DROP COLUMN password_reset_sent_at,
  DROP COLUMN token_version;

-- Sessionsregistren var vår egen tokenhantering. Keycloak har sina egna.
DROP TABLE refresh_tokens;
DROP TABLE revoked_tokens;

-- Vem som *agerade* står kvar i buyer_id/seller_id; vem som är *part* är organisationen.
-- Båda behövs: signaturraden ska visa vem som skrev under, ägarskapet ska gälla företaget.
ALTER TABLE requests
  ADD COLUMN buyer_organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT;

ALTER TABLE bids
  ADD COLUMN seller_organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT;

-- Motsvarigheten till requests_buyer_created_idx, nu när "mina förfrågningar" betyder
-- organisationens. Bär också sidbrytningens (created_at, id)-markör.
CREATE INDEX requests_buyer_org_created_idx
  ON requests (buyer_organization_id, created_at DESC, id DESC);

CREATE INDEX bids_seller_org_created_idx
  ON bids (seller_organization_id, created_at DESC, id DESC);

CREATE INDEX users_organization_idx ON users (organization_id);

-- Ett aktivt anbud per *företag* och förfrågan, inte per person. Två kollegor som råkar
-- lämna var sitt anbud på samma förfrågan är inte två anbud — det är ett företag som
-- talar med två röster. Den gamla spärren låg på seller_id och släppte igenom det.
DROP INDEX bids_one_active_per_seller_idx;

CREATE UNIQUE INDEX bids_one_active_per_seller_org_idx
  ON bids (request_id, seller_organization_id)
  WHERE status <> 'withdrawn';
