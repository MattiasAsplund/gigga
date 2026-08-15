CREATE TYPE contract_status AS ENUM ('pending_signatures', 'active', 'void');

CREATE TABLE contracts (
  id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid            NOT NULL UNIQUE REFERENCES requests (id) ON DELETE CASCADE,
  bid_id            uuid            NOT NULL UNIQUE REFERENCES bids (id) ON DELETE CASCADE,
  -- Fryst kopia av anbudets villkor. Ändras anbudet senare rör det inte avtalet.
  terms             jsonb           NOT NULL,
  buyer_signed_at   timestamptz,
  seller_signed_at  timestamptz,
  status            contract_status NOT NULL DEFAULT 'pending_signatures',
  created_at        timestamptz     NOT NULL DEFAULT now(),

  -- Ett aktivt avtal utan båda signaturerna ska inte kunna existera, oavsett kodväg.
  CONSTRAINT contracts_active_requires_both_signatures CHECK (
    status <> 'active'
    OR (buyer_signed_at IS NOT NULL AND seller_signed_at IS NOT NULL)
  )
);
