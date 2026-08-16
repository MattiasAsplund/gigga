-- Refresh-tokens. Ogenomskinliga slumpsträngar, aldrig JWT: de lever länge och måste
-- gå att återkalla, vilket en stateless token inte kan.
--
-- `session_id` överlever rotationen och binder ihop kedjan med access-tokens `sid`.
-- Det är så utloggning kan avsluta hela sessionen och inte bara den token som råkar
-- vara aktuell.
CREATE TABLE refresh_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 av hemligheten. Ingen argon2: värdet är redan 256 bitar slump, så det
  -- finns inget att brute-forca, och uppslaget måste vara en indexträff.
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Två skilda skäl, för de betyder olika saker för den som presenterar token:
  --   consumed_at  token har roterats normalt. Dyker den upp igen har den läckt.
  --   revoked_at   sessionen avslutades (utloggning eller lösenordsbyte).
  -- Slås de ihop får den som loggat ut beskedet att deras token blivit stulen.
  consumed_at timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
