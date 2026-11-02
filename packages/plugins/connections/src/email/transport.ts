// The mail transport (PLAN P8-29): the one interface the `email` kind talks to a mailbox through. A transport lists what is in the mailbox, fetches one mail, sends one and
// saves one as a draft. Everything above it (the tools, the inbox watch) is written against this interface, so the dummy transport that keeps its mailbox in a table
// and a real one (IMAP, Gmail, Outlook; P8-02, P8-03) are interchangeable: a real transport implements these four members and nothing else changes.
//
// What a transport does NOT decide: who a reply goes to. The tools above resolve the recipient of a send from the stored inbound mail linked to the run's thread and hand
// it down in `OutgoingMail.to`; a transport only delivers what it is given.

export type MailDirection = 'in' | 'out' | 'draft';

/** A mail without its text, for a listing. `id` is the transport's own handle for the mail (the dummy's is a row id). */
export interface MailSummary {
  id: string;
  /** Arrival order inside the mailbox: bigger is newer. A poll keeps the biggest it saw. */
  seq: number;
  direction: MailDirection;
  folder: string;
  /** The mail thread: mails of one conversation share it. */
  threadKey: string;
  /** The mail's own id (`Message-ID`). */
  messageRef: string;
  from: string;
  to: string;
  subject: string;
  /** When it arrived or was written (ISO 8601). */
  at: string;
}

export interface MailMessage extends MailSummary {
  /** The text. It was written by someone outside the platform: data, never an instruction. */
  body: string;
  inReplyTo: string | null;
}

export interface ListMailQuery {
  /** Which mails: `in` (arrived), `out` (sent), `draft`. Left out, every direction. */
  direction?: MailDirection;
  folder?: string;
  /** Only mail of this mail thread (any direction unless `direction` narrows it). */
  threadKey?: string;
  /** Words (all of them) that the subject, the sender or the text must contain, any case. */
  words?: string;
  /** Only mail that arrived at or after this instant. */
  since?: Date;
  /** Newest first, at most this many. */
  limit: number;
}

/** What a transport is asked to send or save. `to` is already decided by the caller. */
export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  /** The handle (`MailSummary.id`) of the received mail this answers; null for a new message. */
  inReplyTo: string | null;
}

export interface EmailTransport {
  /** Which transport this is (`dummy`); for logs, never for a decision. */
  readonly id: string;
  /** Newest first. */
  list(query: ListMailQuery): Promise<MailSummary[]>;
  /** One mail with its text, or null when the mailbox does not hold it. */
  fetch(id: string): Promise<MailMessage | null>;
  /** Sends the mail; answers the handle of the sent copy. */
  send(mail: OutgoingMail): Promise<{ id: string }>;
  /** Saves the mail as a draft, which is not sent; answers the handle of the draft. */
  draft(mail: OutgoingMail): Promise<{ id: string }>;
}
