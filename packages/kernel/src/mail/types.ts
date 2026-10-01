/** One outgoing mail. Both bodies are always set: plain text for clients that want it, simple HTML for the rest. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Defaults to the mailer's configured sender. */
  from?: string;
}

/** The kernel's one way to send mail. Implementations: SMTP, in-memory (tests), unconfigured (logs, sends nothing). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
