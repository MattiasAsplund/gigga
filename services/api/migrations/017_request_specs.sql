-- Kravspecen per förfrågan: valda typer, svaren på intervjufrågorna och
-- acceptanskriterierna som rader (docs/gigga-acceptansmallar.md, lager 3).
--
-- Allt spec-innehåll hänger på en *version*, inte på förfrågan. Skälet står i
-- dokumentet: ett svar under den publika frågefasen kan ändra omfattningen, och då
-- måste alla anbud gå att härleda till den lydelse de skrevs mot. En version är
-- oföränderlig när den publicerats; en ändring öppnar nästa utkast som kopia.
--
-- Kriterieraderna är kopior, inte referenser, till mallens rader. Mallen får ändras i
-- katalogen utan att en publicerad kravspec ändrar sig bakom ryggen på parterna.

CREATE TYPE spec_version_status AS ENUM ('draft', 'published', 'superseded');

-- Radens utfall vid verifieringen. Godkännandet av *lydelsen* är en annan sak och
-- ligger i approved_at/approved_by.
CREATE TYPE criterion_status AS ENUM ('pending', 'met', 'failed', 'waived');

CREATE TYPE criterion_origin AS ENUM ('template', 'custom');

CREATE TABLE request_spec_versions (
  id           uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid                NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  version      integer             NOT NULL,
  status       spec_version_status NOT NULL DEFAULT 'draft',
  created_at   timestamptz         NOT NULL DEFAULT now(),
  published_at timestamptz,

  UNIQUE (request_id, version),
  CONSTRAINT request_spec_versions_version_positive CHECK (version > 0),
  -- Publicerad (eller ersatt) ⇔ tidsstämplad. Ingen halvpublicerad version.
  CONSTRAINT request_spec_versions_published_at_matches_status
    CHECK ((status = 'draft') = (published_at IS NULL))
);

-- Ett utkast och en gällande version i taget. Äldre versioner ligger kvar som
-- 'superseded' och är det anbuden pekar på.
CREATE UNIQUE INDEX request_spec_versions_one_draft_idx
  ON request_spec_versions (request_id) WHERE status = 'draft';
CREATE UNIQUE INDEX request_spec_versions_one_published_idx
  ON request_spec_versions (request_id) WHERE status = 'published';

CREATE INDEX request_spec_versions_history_idx
  ON request_spec_versions (request_id, version DESC);

-- Kundens val av uppdragstyp. Flera får väljas — då slås typernas frågor ihop.
-- Basmallen står inte här: den gäller alltid och läggs på vid läsningen.
CREATE TABLE request_spec_types (
  spec_version_id uuid    NOT NULL REFERENCES request_spec_versions (id) ON DELETE CASCADE,
  template_id     uuid    NOT NULL REFERENCES gig_templates (id),
  position        integer NOT NULL,

  PRIMARY KEY (spec_version_id, template_id)
);

CREATE INDEX request_spec_types_order_idx ON request_spec_types (spec_version_id, position);

CREATE TABLE request_answers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_version_id uuid        NOT NULL REFERENCES request_spec_versions (id) ON DELETE CASCADE,
  question_id     uuid        NOT NULL REFERENCES gig_questions (id),
  -- Ögonblicksbild av frågan som den ställdes. Katalogen får skriva om sin lydelse
  -- utan att ett lämnat svar plötsligt besvarar en annan fråga.
  question_key    text        NOT NULL,
  prompt          text        NOT NULL,
  -- Svarets värde i den form frågetypen föreskriver: sträng, tal, boolean eller
  -- array av alternativnycklar.
  value           jsonb       NOT NULL,
  answered_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (spec_version_id, question_id)
);

CREATE TABLE request_criteria (
  id                  uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_version_id     uuid             NOT NULL REFERENCES request_spec_versions (id) ON DELETE CASCADE,
  kind                gig_clause_kind  NOT NULL,
  statement           text             NOT NULL,
  verification        text,
  position            integer          NOT NULL,
  origin              criterion_origin NOT NULL,
  -- Var raden kom ifrån. Nycklar, inte främmande nycklar: mallens rad får ändras eller
  -- försvinna utan att kravspecen följer med.
  source_template_key text,
  source_clause_key   text,
  status              criterion_status NOT NULL DEFAULT 'pending',
  -- Kundens aktiva godkännande av lydelsen (steg 5). Tidsstämpeln är ansvarsskyddet:
  -- kravspecen är kundens, inte plattformens.
  approved_at         timestamptz,
  -- SET NULL, inte RESTRICT: tidsstämpeln är ansvarsskyddet och måste överleva, men
  -- ett raderat konto får inte gå att använda som lås mot radering av användare.
  approved_by         uuid             REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz      NOT NULL DEFAULT now(),

  -- Ett godkännande utan tidpunkt finns inte. Däremot kan tidpunkten stå kvar sedan
  -- kontot som godkände raderats.
  CONSTRAINT request_criteria_approval_has_time
    CHECK (approved_by IS NULL OR approved_at IS NOT NULL),
  CONSTRAINT request_criteria_template_rows_name_their_source
    CHECK ((origin = 'template') = (source_template_key IS NOT NULL))
);

CREATE INDEX request_criteria_order_idx
  ON request_criteria (spec_version_id, kind, position);

-- Anbudet avser en bestämd lydelse av kravspecen. NULL för förfrågningar utan
-- publicerad version — vilket är alla som lades innan intervjuflödet fanns.
ALTER TABLE bids ADD COLUMN spec_version_id uuid REFERENCES request_spec_versions (id);

CREATE INDEX bids_spec_version_idx ON bids (spec_version_id);
