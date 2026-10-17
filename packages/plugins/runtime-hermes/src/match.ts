import { parseMarkup, type BotTrigger } from '@manythreads/shared';

/**
 * How many bot-to-bot hops one thread may hold. Orchestrator → coder → tester → orchestrator is three; past that a mention
 * between bots is an ordinary message. Every hop still needs an explicit @mention and the author's `tasks.handoff` grant
 * naming the target, so this is the backstop, not the permission.
 */
export const MAX_DELEGATION_DEPTH = 3;

/** What the router decided: which trigger of one bot fires on one message. */
export type RoutedTrigger = 'conversation' | 'mention' | 'channel_message';

export interface MessageView {
  /** The channel's name, without the `#`. */
  channelName: string;
  /** The channel is the bot's own (its conversation). */
  isBotChannel: boolean;
  /** The lowercased `@handles` the body names. */
  mentions: ReadonlySet<string>;
}

/** The trigger of `bot` that this message fires, or null. Highest priority first; `source.channels` narrows mention and channel_message. */
export function matchTrigger(triggers: readonly BotTrigger[], botSlug: string, view: MessageView): RoutedTrigger | null {
  const inSource = (trigger: BotTrigger): boolean => {
    const source = 'source' in trigger ? trigger.source : undefined;
    return (
      source === undefined || source.channels.some((ref) => ref.slice(1).toLowerCase() === view.channelName.toLowerCase())
    );
  };
  const has = (type: BotTrigger['type']): BotTrigger | undefined => triggers.find((t) => t.type === type);

  // The bot's own conversation channel answers to its `conversation` trigger and to nothing else: a `mention` or `channel_message` rule
  // names channels of the team, and this one is a single person's private thread with the bot.
  if (view.isBotChannel) return has('conversation') ? 'conversation' : null;
  const mention = has('mention');
  if (mention && view.mentions.has(botSlug.toLowerCase()) && inSource(mention)) return 'mention';
  const channelMessage = has('channel_message');
  if (channelMessage && inSource(channelMessage)) return 'channel_message';
  return null;
}

/**
 * The `@handles` a body names, lowercased — read with the composer's own parser, so a handle inside a code span, a fence, a
 * URL or an email names nobody here either, and a mention the composer would link is a mention that routes. A bot's slug
 * (letters, digits, `.`, `_`, `-`) is exactly what that parser accepts.
 */
export function mentionedHandles(body: string): Set<string> {
  return new Set(parseMarkup(body).mentions.map((m) => m.handle.toLowerCase()));
}

/**
 * What the run is asked, in one prompt: who said it, where, and the message itself. The bot's behaviour is SOUL.md's job. A conversation channel
 * has no name (it is the person's own thread with the bot), so there the prompt is the person and the message.
 */
export function buildPrompt(input: { authorName: string; channelName: string; body: string }): string {
  return input.channelName === '' ? `${input.authorName}:\n\n${input.body}` : `${input.authorName} in #${input.channelName}:\n\n${input.body}`;
}

/**
 * The bots the authoring bot may hand work to: the bots loader compiles `handover.mayTag` into the author's
 * `tasks.handoff` grant (`constraints: { mayTag: [...] }`); a target it does not name is not woken. No grant, no names, no handoff.
 */
export function mayTagSlugs(constraints: unknown): Set<string> {
  const raw = (constraints ?? {}) as { mayTag?: unknown };
  return new Set(
    (Array.isArray(raw.mayTag) ? raw.mayTag : []).filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()),
  );
}
