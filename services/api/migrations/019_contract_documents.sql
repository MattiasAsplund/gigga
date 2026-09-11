-- Avtalet som dokument: vem som höll i pennan, och var PDF:en ligger.
--
-- **Vem som signerade är inte samma sak som vem som skrev förfrågan.** Parterna är
-- företagen, och den kollega som tecknar firman idag behöver inte vara den som lade
-- anbudet i förrgår. `terms` bär de senare; signaturblocken i dokumentet ska bära de
-- förra, med namn, företag och tidsstämpel.
ALTER TABLE contracts
  ADD COLUMN buyer_signed_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN seller_signed_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- Dokumentet kompileras en gång, när den andra signaturen faller, och ligger sedan i
-- objektlagringen. Nyckeln bär inte filnamnet — namnet är en presentationsfråga och får
-- ändras utan att objektet flyttas — och raden bär båda, så nedladdningen aldrig behöver
-- gissa vad filen ska heta.
ALTER TABLE contracts
  ADD COLUMN document_key          text,
  ADD COLUMN document_filename     text,
  ADD COLUMN document_generated_at timestamptz;
