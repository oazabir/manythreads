import type { PluginTx, ProviderImpl } from './types.ts';

// The one path a channel message is written on, as other plugins see it (PLAN P5-18): `ctx.providers.get<MessageProvider>('messages')`, registered
// by the channels plugin (`provider.messages`). Look it up when a request arrives, not in `register` (channels may load after you).
//
// Why a provider and not the `messages.post` capability: a capability is something a bot's model can be granted and call with arguments it
// chose, so it cannot carry anything the platform must vouch for. A provider is reachable by plugin code alone. What the answer plugin posts
// carries `meta.answer`, which the client draws as the platform's own statement of what was cited and whom it was for; if a bot could set it
// through a tool, a bot could forge it.

/** What a message needs. The author is the transaction's actor; the permission is the channel's own `post` rule for that actor. */
export interface MessagePostInput {
  channelId: string;
  body: string;
  /** The thread to reply in (the root message id); absent or null posts a top-level message. */
  threadRootId?: string | null;
  /**
   * The platform's bookkeeping for the row, never a caller's: `answer` (an `AnswerPayload`, validated against the shared schema) and `runId`
   * (the bot run that wrote the message, which is how the runtime knows the run already answered) and `runFailure` (the category of a failed run's notice,
   * which is how the runtime knows it already said so; it needs `runId`) and `surfaceRef` (the id of a surface the posting bot drew in its run, which the client draws in the message; the surfaces plugin checks the surface, this provider checks only that a bot inside a run posts it) and `meetingNotes` (the meeting a note-taker's nudge is about: the client draws the Share and Save buttons from it). Any other key is refused. The provider checks
   * them against the transaction: `runId` must be the run the transaction acts for, and an `answer` must name that run and the posting bot in
   * `answeredFor` and carry the message's own text as its `body` (403 for another run or bot, 400 for another text).
   */
  meta?: { answer?: unknown; runId?: string; runFailure?: string; surfaceRef?: string; meetingNotes?: { meetingId: string } };
  /**
   * The answer this message is a masked copy of (P5-17): the id of an Answer in the caller's OWN bot conversation. Given, the provider accepts an
   * `answer` posted by a person (no run), after checking it against that stored answer: the same run, bot and asker, the caller is the asker, the
   * text is the original's with whole sentences taken out (a subsequence), every citation is one of the original's by number (kept as it was
   * but for a re-read label, or masked), and nothing is added (no chips; "Sources reached" and the lineage are subsets). Nothing about the original
   * is stored on the copy. 403 for an answer that is not the caller's, 400 for a copy that is not one.
   */
  copyOf?: string;
  /**
   * Do not record what the text names (people, channels, links), so nobody is notified and nothing is linked because of it. For text a plugin
   * writes from something a person typed that must not ping anyone (a reminder's text). Plugin code only: the provider is not reachable by a bot.
   */
  skipRefs?: boolean;
  /**
   * Files already uploaded to this channel by the transaction's actor (`POST /api/channels/:channelId/files`), attached as `meta.attachments`, exactly as the
   * post route attaches them. Plugin code only; refused with 400 for a file that is not the actor's own upload to this channel.
   */
  attachmentIds?: readonly string[];
  /** The message is imported history (see `ImportedMessage`); cannot be combined with `meta` or `copyOf`. */
  imported?: ImportedMessage;
}

/**
 * A message that is history from another product (PLAN P14-13, the import plugin): it keeps the time it was written at, gets an id that sorts at that
 * time, carries `meta.importedFrom`, and raises nothing: no event, no live push, no unread count, no notification, no mention. Only a system
 * transaction may post one (403 otherwise); the author is the transaction's actor, which the import plugin sets for each message.
 */
export interface ImportedMessage {
  /** When the message was written in the source, ISO 8601. Not in the future. */
  at: string;
  source: 'slack' | 'mattermost';
  /** The message's id in the source (or a key derived from it), recorded in `meta.importedFrom.id`. */
  sourceId: string;
  /** Reactions to add with the message: one row per (emoji, actor id). */
  reactions?: readonly { emoji: string; actorIds: readonly string[] }[];
}

/** A channel the import plugin asks for: made in a team as the transaction's actor (a lead or admin), with the people who may read it when private. */
export interface ImportChannelInput {
  teamId: string;
  /** Any text: it is turned into a channel name (lowercase letters, digits and hyphens) and made unique in the team. */
  name: string;
  private: boolean;
  purpose: string;
  /** People (person ids) to add to a private channel; the ones who are not on the team are counted as skipped. */
  memberPersonIds: readonly string[];
}

export interface ImportedChannel {
  channelId: string;
  /** The name the channel got (the asked name made valid and unique). */
  name: string;
  membersAdded: number;
  membersSkipped: number;
}

export interface MessagePosted {
  id: string;
  channelId: string;
  threadRootId: string | null;
  createdAt: string;
}

/** What an edit needs. The editor is the transaction's actor, who must be the message's author. */
export interface MessageEditInput {
  channelId: string;
  messageId: string;
  body: string;
}

/** What an edit answers: ids only, never the text back. */
export interface MessageEdited {
  id: string;
  channelId: string;
  /** False when the new text was the text already there: nothing changed, nothing was recorded. */
  changed: boolean;
}

/** What a reaction change needs. The reactor is the transaction's actor. */
export interface MessageReactInput {
  channelId: string;
  messageId: string;
  /** An emoji character or a `:shortcode:` (no spaces, at most 64 characters). */
  emoji: string;
  add: boolean;
}

export interface MessageReacted {
  /** False when the reaction was already there (adding) or not there (removing). */
  changed: boolean;
}

export interface MessageProvider extends ProviderImpl {
  /**
   * Writes the message exactly as the post route does: it rejects with an `Error` that carries `status` (403 not allowed to post, 404 no such
   * channel or thread, 409 the thread's root is a reply or was deleted, 400 an invalid body or meta), and on success emits
   * `channel.message.posted`, pushes it live, counts it unread for the thread's followers and records what it mentions.
   */
  post(tx: PluginTx, input: MessagePostInput): Promise<MessagePosted>;
  /**
   * Replaces the text of a message the transaction's actor wrote, exactly as the edit route does (the earlier text is kept as a version, the
   * `channel.message.edited` event is written, the live push goes out). The mentions and links the message was posted with stay as they were: a name
   * added by an edit is plain text and nobody is notified (PLAN P14-14: a script's edit never wakes anyone). Errors carry `status`: 403 not the
   * author, 404 no such message in the channel, 409 deleted, archived channel, an answer or a poll, 400 an invalid body.
   */
  edit(tx: PluginTx, input: MessageEditInput): Promise<MessageEdited>;
  /** Adds or removes the transaction's actor's own reaction, as the reaction routes do (event and live push included). 404 no such message, 409 deleted or archived. */
  react(tx: PluginTx, input: MessageReactInput): Promise<MessageReacted>;
  /**
   * Makes a team channel exactly as the create-channel route does (a lead or workspace admin of the team; 403 otherwise; the live push to the
   * team), but for a name that may be anything: it is made valid, and unique by a numeric suffix. A private channel gets `memberPersonIds`
   * (those on the team; the others are counted in `membersSkipped`). No per-channel event is raised for the people added: the import run's own
   * events say what happened.
   */
  importChannel(tx: PluginTx, input: ImportChannelInput): Promise<ImportedChannel>;
}
