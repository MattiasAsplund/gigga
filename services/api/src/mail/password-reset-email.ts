import type { OutgoingMail } from './mailer.ts';

/**
 * Återställningsmailet bär **token**, inte en färdig länk.
 *
 * Till skillnad från bekräftelselänken kan återställningen inte utföras med ett klick —
 * den kräver ett nytt lösenord, alltså ett formulär. Länken pekar därför på webbens
 * `/reset-password`, som tar koden ur adressen och frågar efter lösenordet.
 *
 * Utan `resetUrl` bär mailet koden i klartext i stället. Det gällde så länge det inte
 * fanns någon sida att skicka någon till, och står kvar för den som kör API:et ensamt.
 */
export function passwordResetEmail(input: {
  to: string;
  displayName: string;
  token: string;
  resetUrl: string | null;
  ttlHours: number;
}): OutgoingMail {
  const link = input.resetUrl ? `${input.resetUrl}?token=${input.token}` : null;

  const instructions = link
    ? ['Återställ lösenordet här:', link]
    : [
        'Använd den här koden för att sätta ett nytt lösenord:',
        input.token,
        '',
        'Skicka den till POST /api/v1/auth/reset-password tillsammans med det nya lösenordet.',
      ];

  return {
    to: input.to,
    subject: 'Återställ ditt lösenord hos gigga',
    text: [
      `Hej ${input.displayName}!`,
      '',
      ...instructions,
      '',
      `Koden gäller i ${input.ttlHours} timme. Har du inte begärt någon återställning kan`,
      'du strunta i det här mailet — lösenordet ändras inte förrän koden används.',
    ].join('\n'),
  };
}
