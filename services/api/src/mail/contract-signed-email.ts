import type { OutgoingMail } from './mailer.ts';

/**
 * Brevet som går ut när båda parter signerat.
 *
 * **Länken, inte bilagan.** Avtalet ligger bakom inloggning och en behörighetskontroll,
 * och ett PDF-vidarebefordrat brev är varken det ena eller det andra. Länken leder till
 * webben, som skickar besökaren till Keycloak om hen inte redan är inloggad och laddar
 * ner dokumentet först därefter.
 *
 * Brevet är på svenska som all annan post API:et skickar — dokumentet är på engelska,
 * vilket det säger rakt ut. Post på mottagarens eget språk kräver att språkvalet följer
 * med användaren till servern, och det gör det inte än (§10).
 */
export function contractSignedEmail(input: {
  to: string;
  requestTitle: string;
  counterpartyName: string;
  documentUrl: string;
}): OutgoingMail {
  const lines = [
    `${input.counterpartyName} har signerat, och avtalet om "${input.requestTitle}" gäller.`,
    '',
    'Hämta det signerade avtalet här:',
    input.documentUrl,
    '',
    'Länken leder till gigga och kräver inloggning — avtalet är bara tillgängligt för',
    'parterna. Dokumentet är på engelska och bär båda signaturerna med namn, företag och',
    'tidsstämpel.',
  ];

  return {
    to: input.to,
    subject: `Signerat avtal: ${input.requestTitle}`,
    text: lines.join('\n'),
  };
}
