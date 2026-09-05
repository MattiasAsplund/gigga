-- Acceptansmallarna som data (docs/gigga-acceptansmallar.md, lager 1 och 2).
--
-- Poängen med de här tabellerna är att en ny uppdragstyp eller en ny fråga ska vara
-- en rad, aldrig en deploy. Innehållet ligger som JSON under services/api/catalog/ och
-- synkas in vid varje boot (src/db/gig-catalog.ts) — databasen är ändå icke-persistent.
--
-- Tre nivåer:
--   gig_templates          basmallen (gäller varje gigg) och typmallarna ovanpå den
--   gig_questions          frågebanken: en fråga definieras en gång och återanvänds
--   gig_template_questions vilka frågor en mall ställer, i vilken ordning, med villkor
--
-- Frågebanken är skild från mallarna just för att flera valda typer ska kunna dela en
-- fråga: intervjun slår ihop typernas frågor och dubbletterna faller bort på question_id
-- i stället för på en textjämförelse.

CREATE TYPE gig_template_layer AS ENUM ('base', 'type');

-- Textrader en mall bidrar med till kravspecen. 'criterion' är acceptanskriterier,
-- 'minimum' de alltid gällande minimikraven (1.4), 'exclusion' utkast till ingår-inte
-- (1.5) och 'term' villkor som klockstopp och garanti (1.7, 1.9).
CREATE TYPE gig_clause_kind AS ENUM ('criterion', 'minimum', 'exclusion', 'term');

-- Frågetyperna. Varje typ bär ett JSON Schema för svarets värde, så att validering av
-- ett svar inte behöver veta vilken fråga det gäller (src/domain/gig-answers.ts).
CREATE TABLE gig_question_kinds (
  key           text  PRIMARY KEY,
  description   text  NOT NULL,
  answer_schema jsonb NOT NULL
);

CREATE TABLE gig_questions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text        NOT NULL UNIQUE,
  prompt     text        NOT NULL,
  help_text  text,
  kind       text        NOT NULL REFERENCES gig_question_kinds (key),
  -- Skärper frågetypens schema för just den här frågan: maxLength, minimum, maximum,
  -- default. Läggs ovanpå answer_schema vid validering.
  config     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Frågor raderas aldrig när de försvinner ur katalogen — lämnade svar pekar på dem.
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gig_question_options (
  question_id uuid    NOT NULL REFERENCES gig_questions (id) ON DELETE CASCADE,
  key         text    NOT NULL,
  label       text    NOT NULL,
  position    integer NOT NULL,

  PRIMARY KEY (question_id, key)
);

CREATE INDEX gig_question_options_order_idx ON gig_question_options (question_id, position);

CREATE TABLE gig_templates (
  id         uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text               NOT NULL UNIQUE,
  layer      gig_template_layer NOT NULL,
  name       text               NOT NULL,
  summary    text,
  position   integer            NOT NULL,
  active     boolean            NOT NULL DEFAULT true,
  created_at timestamptz        NOT NULL DEFAULT now(),
  updated_at timestamptz        NOT NULL DEFAULT now()
);

-- Basmallen läggs under varje gigg. Två av dem vore tyst dubbelfrågande.
CREATE UNIQUE INDEX gig_templates_single_base_idx
  ON gig_templates (layer) WHERE layer = 'base' AND active;

-- Katalogens visningsordning, och samma ordning som frågorna slås ihop i.
CREATE INDEX gig_templates_order_idx ON gig_templates (position) WHERE active;

CREATE TABLE gig_template_questions (
  template_id uuid    NOT NULL REFERENCES gig_templates (id) ON DELETE CASCADE,
  question_id uuid    NOT NULL REFERENCES gig_questions (id) ON DELETE CASCADE,
  position    integer NOT NULL,
  -- Obligatorisk i den här mallen. Samma fråga kan vara frivillig i en annan.
  required    boolean NOT NULL DEFAULT true,
  -- Villkorslogik, utvärderad mot redan lämnade svar (src/domain/gig-conditions.ts):
  --   {"question": "base.deployment", "notEquals": "none"}
  --   {"question": "screen.design", "in": ["sketch", "design-system"]}
  --   {"question": "bugfix.tests", "answered": true}
  -- NULL = frågan ställs alltid.
  condition   jsonb,

  PRIMARY KEY (template_id, question_id)
);

CREATE INDEX gig_template_questions_order_idx
  ON gig_template_questions (template_id, position);

CREATE TABLE gig_template_clauses (
  id           uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid            NOT NULL REFERENCES gig_templates (id) ON DELETE CASCADE,
  key          text            NOT NULL,
  kind         gig_clause_kind NOT NULL,
  statement    text            NOT NULL,
  -- Föreslagen verifieringsmetod. Kunden får ändra den när raden hamnat i kravspecen.
  verification text,
  position     integer         NOT NULL,

  UNIQUE (template_id, key)
);

CREATE INDEX gig_template_clauses_order_idx
  ON gig_template_clauses (template_id, kind, position);
