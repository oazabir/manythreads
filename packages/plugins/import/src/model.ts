import type { ImportSkipReason, ImportSource } from '@manythreads/shared';

// What an archive is once it has been read: the same few shapes whichever product it came from. The readers (slack.ts, mattermost.ts) turn the
// archive into these, already checked and cleaned; the engine (engine.ts) only knows these.

/** Why an archive cannot be read at all, in words an admin can act on. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchivePerson {
  /** The id the archive uses for the person (Slack's user id; Mattermost's username). */
  key: string;
  /** The name shown on their messages. */
  name: string;
  /** Lowercase, or null when the archive gives none. */
  email: string | null;
  /** A bot or an app: its messages are left out. */
  isBot: boolean;
}

export interface ArchiveChannel {
  key: string;
  name: string;
  kind: 'public' | 'private' | 'direct';
  /** A name made of ASCII letters and digits to use when `name` has none (Arabic, Chinese): the channel's own short name or id. */
  slug?: string;
  purpose: string;
  /** Keys of the people in a private channel or a direct conversation; null when the archive does not list them. */
  memberKeys: string[] | null;
}

export interface ArchiveMessage {
  channelKey: string;
  /** Unique within the source and stable between runs: how a second run recognises a message it already wrote. */
  key: string;
  /** Milliseconds since 1970, never in the future. */
  at: number;
  authorKey: string | null;
  /** Cleaned text, already in the platform's plain form; may be empty when `skip` is set. */
  text: string;
  /** The key of the first message of the thread this one replies in; null for a message that starts a thread or stands alone. */
  rootKey: string | null;
  /** True when other messages reply to this one. */
  startsThread: boolean;
  reactions: { emoji: string; userKeys: string[] }[];
  /** Files the message names (the platform does not copy their bytes yet). */
  files: { name: string; inArchive: boolean }[];
  /** Why the message is left out; null when it is imported. */
  skip: ImportSkipReason | null;
  mentions: number;
  shortened: boolean;
}

/** Counts of things the reader left out or could not read, by reason. */
export type Notes = Map<ImportSkipReason, number>;

export const note = (notes: Notes, reason: ImportSkipReason, n = 1): void => {
  notes.set(reason, (notes.get(reason) ?? 0) + n);
};

export interface ArchiveReader {
  readonly source: ImportSource;
  /** Things left out while reading, by reason. Complete only after every method has been used. */
  readonly notes: Notes;
  /** A person's name for a key the archive's user list does not describe (a key may carry an archive prefix that no one should read). */
  nameOf?(key: string): string;
  people(): Promise<ArchivePerson[]>;
  channels(): Promise<ArchiveChannel[]>;
  /** Every message, oldest first within a channel; `include` limits it to the channels the caller will use. */
  messages(include?: (channelKey: string) => boolean): AsyncGenerator<ArchiveMessage>;
  close(): Promise<void>;
}
