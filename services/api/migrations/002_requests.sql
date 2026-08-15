CREATE TYPE compensation_pref AS ENUM ('fixed', 'hourly', 'any');
CREATE TYPE request_status AS ENUM ('open', 'awarded', 'cancelled');

CREATE TABLE requests (
  id                 uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           uuid              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title              text              NOT NULL,
  description        text              NOT NULL,
  compensation_pref  compensation_pref NOT NULL,
  -- Belopp i minorenhet (öre). NULL = ingen budget angiven.
  budget_minor       bigint,
  currency           char(3)           NOT NULL DEFAULT 'SEK',
  deadline_at        timestamptz,
  status             request_status    NOT NULL DEFAULT 'open',
  created_at         timestamptz       NOT NULL DEFAULT now(),

  CONSTRAINT requests_budget_positive CHECK (budget_minor IS NULL OR budget_minor > 0)
);

-- Bär både "mina förfrågningar, nyaste först" och sidbrytningens (created_at, id)-markör.
CREATE INDEX requests_buyer_created_idx ON requests (buyer_id, created_at DESC, id DESC);
