import nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryMailer extends Mailer {
  /** Allt som skickats, i ordning. Testernas motsvarighet till mailpits inkorg. */
  readonly sent: OutgoingMail[];
}

/** För tester: samlar utgående post istället för att prata SMTP. */
export function createMemoryMailer(): MemoryMailer {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
    async close() {},
  };
}

/**
 * SMTP mot mailpit i utvecklingsmiljön. Ingen autentisering och ingen TLS — mailpit tar
 * emot allt och skickar aldrig vidare, vilket är hela poängen med den i AppHosten.
 */
export function createSmtpMailer(config: {
  host: string;
  port: number;
  from: string;
}): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    // Mailpit kräver inget, men en riktig server skulle: låt anslutningen misslyckas
    // högljutt istället för att tyst falla tillbaka på något annat.
    ignoreTLS: true,
  });

  return {
    async send(mail) {
      await transport.sendMail({
        from: config.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
      });
    },
    async close() {
      transport.close();
    },
  };
}
