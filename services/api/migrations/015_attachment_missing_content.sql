-- Motsatsen till föräldralösa objekt: en rad vars innehåll saknas i lagringen.
--
-- Raden raderas aldrig automatiskt. Den är beviset på att säljaren bifogat ett dokument,
-- och att tyst ta bort den vore att låta ett lagringsfel se ut som om det aldrig funnits.
-- I stället markeras den, och API:et redovisar dokumentet som otillgängligt.
ALTER TABLE bid_attachments
  ADD COLUMN content_missing_since timestamptz;

-- Frågan "vad är trasigt just nu?" ska vara billig även när nästan inget är det.
CREATE INDEX bid_attachments_missing_idx
  ON bid_attachments (content_missing_since)
  WHERE content_missing_since IS NOT NULL;
