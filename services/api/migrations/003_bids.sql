CREATE TYPE compensation_type AS ENUM ('fixed', 'hourly');
CREATE TYPE bid_status AS ENUM ('submitted', 'withdrawn', 'accepted', 'rejected');

CREATE TABLE bids (
  id                  uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid              NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  seller_id           uuid              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Genomförandeplanen: det säljaren faktiskt erbjuder sig att göra.
  plan                text              NOT NULL,
  compensation_type   compensation_type NOT NULL,
  fixed_amount_minor  bigint,
  hourly_rate_minor   bigint,
  estimated_hours     numeric(6,2),
  currency            char(3)           NOT NULL DEFAULT 'SEK',
  status              bid_status        NOT NULL DEFAULT 'submitted',
  created_at          timestamptz       NOT NULL DEFAULT now(),

  -- Databasens tvilling till domänregeln i src/domain/bid-rules.ts: exakt en av
  -- ersättningsformerna får vara ifylld, och beloppen måste vara positiva.
  CONSTRAINT bids_compensation_shape CHECK (
    (compensation_type = 'fixed'
      AND fixed_amount_minor IS NOT NULL AND fixed_amount_minor > 0
      AND hourly_rate_minor IS NULL
      AND estimated_hours IS NULL)
    OR
    (compensation_type = 'hourly'
      AND hourly_rate_minor IS NOT NULL AND hourly_rate_minor > 0
      AND estimated_hours IS NOT NULL AND estimated_hours > 0
      AND fixed_amount_minor IS NULL)
  )
);

-- Ett aktivt anbud per säljare och förfrågan. Tillbakadragna anbud räknas inte,
-- så säljaren kan lämna ett nytt efter att ha dragit tillbaka det gamla.
CREATE UNIQUE INDEX bids_one_active_per_seller_idx
  ON bids (request_id, seller_id)
  WHERE status <> 'withdrawn';

-- "Mina anbud, nyaste först" (API 4) respektive "anbud på min förfrågan" (API 3).
CREATE INDEX bids_seller_created_idx ON bids (seller_id, created_at DESC, id DESC);
CREATE INDEX bids_request_created_idx ON bids (request_id, created_at DESC, id DESC);
