import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from './types.ts';

export const DEFAULT_MAIL_FROM = 'manythreads <no-reply@localhost>';

export interface SmtpMailerOptions {
  /** `smtp://user:pass@host:587`, `smtps://...`, or the dev mailpit `smtp://localhost:1025`. */
  url: string;
  from?: string;
  /** Replace the nodemailer transport (tests pass a JSON transport). */
  transport?: Transporter;
}

/** Sends through SMTP with nodemailer. A failed send rejects; callers decide whether the person may learn of it. */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const transport = options.transport ?? nodemailer.createTransport(options.url);
  const from = options.from ?? DEFAULT_MAIL_FROM;
  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: message.from ?? from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

/** Used when no SMTP url is configured: records nothing, sends nothing, tells the operator once per message. */
export function createUnconfiguredMailer(warn: (line: string) => void): Mailer {
  return {
    send(message) {
      // Never print the body: it holds a one-time link.
      warn(`mail not sent to ${message.to} ("${message.subject}"): set MANYTHREADS_SMTP_URL (dev: smtp://localhost:1025)`);
      return Promise.resolve();
    },
  };
}

export interface MailerEnv {
  MANYTHREADS_SMTP_URL?: string | undefined;
  MANYTHREADS_MAIL_FROM?: string | undefined;
}

/** SMTP when MANYTHREADS_SMTP_URL is set, otherwise the unconfigured mailer. */
export function mailerFromEnv(env: MailerEnv = process.env, warn: (line: string) => void = () => undefined): Mailer {
  const url = env.MANYTHREADS_SMTP_URL;
  if (!url) return createUnconfiguredMailer(warn);
  return createSmtpMailer({ url, ...(env.MANYTHREADS_MAIL_FROM ? { from: env.MANYTHREADS_MAIL_FROM } : {}) });
}
