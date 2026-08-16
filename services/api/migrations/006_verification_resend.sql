-- När det senaste bekräftelsemailet gick ut. Bär kylperioden som hindrar att
-- /auth/resend-verification används för att spamma en adress med mail.
ALTER TABLE users
  ADD COLUMN verification_sent_at timestamptz NOT NULL DEFAULT now();
