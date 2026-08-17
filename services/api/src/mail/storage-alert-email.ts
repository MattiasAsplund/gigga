import type { OutgoingMail } from './mailer.ts';
import type { MarkedAttachment } from '../storage/sweeper.ts';

/** Hur många dokument som radas upp i larmet innan listan kortas av. */
export const ALERT_SAMPLE_SIZE = 15;

/**
 * Larm om att lagringen tappat innehåll.
 *
 * **Ett mail per körning, inte per dokument.** Ett lagringsfel kan slå ut tusen
 * dokument på en gång, och tusen mail är inte ett larm utan ett haveri i sig. Listan
 * kortas av, men antalet framgår alltid.
 *
 * Något behöver inte skickas om igen: ett redan markerat dokument markeras inte en
 * andra gång, så varje trasigt dokument larmar exakt en gång.
 */
export function storageAlertEmail(input: {
  to: string;
  marked: MarkedAttachment[];
  total: number;
}): OutgoingMail {
  const sample = input.marked.slice(0, ALERT_SAMPLE_SIZE);
  const remaining = input.total - sample.length;

  const lines = [
    `${input.total} anbudsdokument saknar sitt innehåll i objektlagringen.`,
    '',
    'Metadata finns kvar och raderna är markerade som otillgängliga — de raderas inte',
    'automatiskt. Dokumenten går inte att ladda ner förrän innehållet finns igen.',
    '',
    ...sample.map((item) => `  ${item.filename}  (anbud ${item.bidId}, dokument ${item.id})`),
  ];

  if (remaining > 0) lines.push(`  … och ${remaining} till.`);

  lines.push(
    '',
    'Kommer objekten tillbaka — till exempel efter en återläsning — tar nästa körning',
    'bort markeringen av sig själv.',
  );

  return {
    to: input.to,
    subject: `gigga: innehåll saknas för ${input.total} anbudsdokument`,
    text: lines.join('\n'),
  };
}
