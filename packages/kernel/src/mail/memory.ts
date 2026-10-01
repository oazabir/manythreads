import type { MailMessage, Mailer } from './types.ts';

/** A mailer that keeps what it was asked to send (tests, and local runs without SMTP). */
export interface MemoryMailer extends Mailer {
  readonly sent: readonly MailMessage[];
  /** Messages for one address, oldest first. */
  to(address: string): MailMessage[];
  /** The newest message for an address, or undefined. */
  last(address: string): MailMessage | undefined;
  clear(): void;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push({ ...message });
      return Promise.resolve();
    },
    to: (address) => sent.filter((m) => m.to.toLowerCase() === address.toLowerCase()),
    last: (address) => sent.filter((m) => m.to.toLowerCase() === address.toLowerCase()).at(-1),
    clear: () => {
      sent.length = 0;
    },
  };
}
