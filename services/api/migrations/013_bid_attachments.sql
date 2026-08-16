-- Anbudsdokument. Innehållet ligger som bytea i databasen: den är ändå icke-persistent,
-- så filerna delar livscykel med allt annat och det tillkommer inga rörliga delar.
-- Byts lagringen mot objektlagring är det den här tabellen som får en nyckel i stället.
CREATE TABLE bid_attachments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id       uuid        NOT NULL REFERENCES bids (id) ON DELETE CASCADE,
  filename     text        NOT NULL,
  content_type text        NOT NULL,
  size_bytes   integer     NOT NULL,
  content      bytea       NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bid_attachments_size_positive CHECK (size_bytes > 0),
  -- Ett filnamn per anbud: annars blir två likadana namn i samma ZIP-arkiv.
  CONSTRAINT bid_attachments_unique_name UNIQUE (bid_id, filename)
);

CREATE INDEX bid_attachments_bid_idx ON bid_attachments (bid_id, uploaded_at DESC);
