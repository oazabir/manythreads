import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from './types.ts';

/** How long a connection, the server's greeting, or a silent socket may take before a send fails. */
export const SMTP_TIMEOUT_MS = 20_000;
export const DEFAULT_MAIL_FROM = 'manythreads <no-reply@localhost>';

export interface SmtpMailerOptions {
  /** `smtp://user:pass@host:587`, `smtps://...`, or the dev mailpit `smtp://localhost:1025`. */
  url: string;
  from?: string;
  /** How long connecting, the server's greeting and a silent socket may each take (default 20 seconds). */
  timeoutMs?: number;
  /** Replace the nodemailer transport (tests pass a JSON transport). */
  transport?: Transporter;
}

/** Sends through SMTP with nodemailer. A failed send rejects; callers decide whether the person may learn of it. */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  // A hung mail server must not stall the caller (the digest job sends one mail after another): connecting, the greeting and an idle socket each give up.
  const timeoutMs = options.timeoutMs ?? SMTP_TIMEOUT_MS;
  const transport = options.transport ?? nodemailer.createTransport({ url: options.url, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs });
  const from = options.from ?? DEFAULT_MAIL_FROM;
  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: message.from ?? from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.headers ? { headers: message.headers } : {}),
      });
    },
  };
}

/** Used when no SMTP url is configured: records nothing, sends nothing, tells the operator once per message. */
export function createUnconfiguredMailer(warn: (line: string) => void): Mailer {
  return {
    configured: false,
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
