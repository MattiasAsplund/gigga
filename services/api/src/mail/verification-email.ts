import type { OutgoingMail } from './mailer.ts';

/**
 * Verifieringslänken. Token ligger som query-parameter så att länken går att klicka
 * direkt ur ett mailprogram.
 */
export function verificationUrl(baseUrl: string, token: string): string {
  const url = new URL('/api/v1/validate-user', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export function verificationEmail(input: {
  to: string;
  displayName: string;
  baseUrl: string;
  token: string;
}): OutgoingMail {
  const link = verificationUrl(input.baseUrl, input.token);

  return {
    to: input.to,
    subject: 'Bekräfta din e-postadress hos fastgig',
    text: [
      `Hej ${input.displayName}!`,
      '',
      'Bekräfta din e-postadress för att kunna logga in på fastgig:',
      link,
      '',
      'Har du inte skapat något konto kan du strunta i det här mailet.',
    ].join('\n'),
    html: [
      `<p>Hej ${escapeHtml(input.displayName)}!</p>`,
      '<p>Bekräfta din e-postadress för att kunna logga in på fastgig:</p>',
      `<p><a href="${escapeHtml(link)}">Bekräfta e-postadressen</a></p>`,
      '<p>Har du inte skapat något konto kan du strunta i det här mailet.</p>',
    ].join('\n'),
  };
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
