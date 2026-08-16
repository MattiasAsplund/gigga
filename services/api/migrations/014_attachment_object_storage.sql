-- Innehållet flyttar till objektlagring; databasen bär bara nyckeln.
-- Tio megabyte per rad genom anslutningspoolen är inget en driftsatt tjänst vill ha.
--
-- Ingen datamigrering: databasen är icke-persistent, så det finns inga rader att flytta.
-- Mot en persistent databas hade det här behövt vara två steg med en kopieringsomgång
-- emellan (se migrationsskulden i §10).
ALTER TABLE bid_attachments
  DROP COLUMN content,
  ADD COLUMN storage_key text NOT NULL;

CREATE UNIQUE INDEX bid_attachments_storage_key_idx ON bid_attachments (storage_key);
