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
   * (the bot run that wrote the message, which is how the runtime knows the run already answered). Any other key is refused. The provider checks
   * them against the transaction: `runId` must be the run the transaction acts for, and an `answer` must name that run and the posting bot in
   * `answeredFor` and carry the message's own text as its `body` (403 for another run or bot, 400 for another text).
   */
  meta?: { answer?: unknown; runId?: string };
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
