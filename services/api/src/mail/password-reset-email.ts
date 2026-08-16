import type { OutgoingMail } from './mailer.ts';

/**
 * Återställningsmailet bär **token**, inte en färdig länk.
 *
 * Till skillnad från bekräftelselänken kan återställningen inte utföras med ett klick —
 * den kräver ett nytt lösenord, alltså ett formulär. Så länge det inte finns någon
 * frontend vore en länk in i API:et bara en 404. Sätt `PASSWORD_RESET_URL` när en sida
 * finns, så följer en klickbar länk med.
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
    subject: 'Återställ ditt lösenord hos fastgig',
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
