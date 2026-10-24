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
   * which is how the runtime knows it already said so; it needs `runId`). Any other key is refused. The provider checks
   * them against the transaction: `runId` must be the run the transaction acts for, and an `answer` must name that run and the posting bot in
   * `answeredFor` and carry the message's own text as its `body` (403 for another run or bot, 400 for another text).
   */
  meta?: { answer?: unknown; runId?: string; runFailure?: string };
  /**
   * The answer this message is a masked copy of (P5-17): the id of an Answer in the caller's OWN bot conversation. Given, the provider accepts an
   * `answer` posted by a person (no run), after checking it against that stored answer: the same run, bot and asker, the caller is the asker, the
   * text is the original's with whole sentences taken out (a subsequence), every citation is one of the original's by number (kept as it was
   * but for a re-read label, or masked), and nothing is added (no chips; "Sources reached" and the lineage are subsets). Nothing about the original
   * is stored on the copy. 403 for an answer that is not the caller's, 400 for a copy that is not one.
   */
  copyOf?: string;
}

export interface MessagePosted {
  id: string;
  channelId: string;
  threadRootId: string | null;
  createdAt: string;
}

export interface MessageProvider extends ProviderImpl {
  /**
   * Writes the message exactly as the post route does: it rejects with an `Error` that carries `status` (403 not allowed to post, 404 no such
   * channel or thread, 409 the thread's root is a reply or was deleted, 400 an invalid body or meta), and on success emits
   * `channel.message.posted`, pushes it live, counts it unread for the thread's followers and records what it mentions.
   */
  post(tx: PluginTx, input: MessagePostInput): Promise<MessagePosted>;
}
