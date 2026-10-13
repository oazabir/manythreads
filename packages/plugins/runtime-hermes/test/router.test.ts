import { parseBotMd, type BotTrigger } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { buildPrompt, matchTrigger, mentionedHandles, type MessageView } from '../src/router.ts';

// Which posted message wakes which bot (PLAN P5-10). The three triggers this phase routes, decided purely: the view is what
// the router read about the message, and the triggers are the ones the loader compiled onto the row.

const triggers = (...list: string[]): BotTrigger[] => {
  const parsed = parseBotMd(`---\nname: Coder\nrole: r\nkind: agent\nruntime: hermes\ntriggers:\n${list.map((t) => `  - ${t}\n`).join('')}---\n`);
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.frontmatter.triggers ?? [];
};

const view = (overrides: Partial<MessageView> = {}): MessageView => ({
  channelName: 'dev',
  isBotChannel: false,
  mentions: new Set(),
  ...overrides,
});

describe('matchTrigger', () => {
  it('fires conversation only in the bot’s own channel, and it wins over a mention', () => {
    const list = triggers('{ type: conversation }', '{ type: mention }');
    expect(matchTrigger(list, 'coder', view({ isBotChannel: true, mentions: new Set(['coder']) }))).toBe('conversation');
    expect(matchTrigger(list, 'coder', view({ isBotChannel: false }))).toBeNull();
  });

  it('the bot’s own conversation channel answers to the conversation trigger and to nothing else', () => {
    // a mention or a channel rule names channels of the team: neither wakes a bot inside one person's private thread with it
    const rules = triggers('{ type: mention }', '{ type: channel_message }');
    expect(matchTrigger(rules, 'coder', view({ channelName: '', isBotChannel: true, mentions: new Set(['coder']) }))).toBeNull();
    expect(matchTrigger(triggers('{ type: channel_message }'), 'coder', view({ channelName: '', isBotChannel: true }))).toBeNull();
    expect(matchTrigger(triggers('{ type: conversation }'), 'coder', view({ channelName: '', isBotChannel: true }))).toBe('conversation');
  });

  it('fires mention when the body names the bot, and only in the channels the trigger lists', () => {
    const scoped = triggers('{ type: mention, source: { channels: ["#dev"] } }');
    expect(matchTrigger(scoped, 'coder', view({ mentions: new Set(['coder']) }))).toBe('mention');
    expect(matchTrigger(scoped, 'coder', view({ channelName: 'releases', mentions: new Set(['coder']) }))).toBeNull();
    expect(matchTrigger(scoped, 'coder', view({ mentions: new Set(['rafi']) }))).toBeNull();
    // A bot whose slug is not named is never woken by somebody else's name.
    expect(matchTrigger(triggers('{ type: mention }'), 'builder', view({ mentions: new Set(['coder']) }))).toBeNull();
  });

  it('fires channel_message for every message of the team when the trigger names no channel', () => {
    const any = triggers('{ type: channel_message }');
    expect(matchTrigger(any, 'coder', view())).toBe('channel_message');
    expect(matchTrigger(any, 'coder', view({ channelName: 'releases' }))).toBe('channel_message');
    const scoped = triggers('{ type: channel_message, source: { channels: ["#incidents"] } }');
    expect(matchTrigger(scoped, 'coder', view({ channelName: 'dev' }))).toBeNull();
    expect(matchTrigger(scoped, 'coder', view({ channelName: 'incidents' }))).toBe('channel_message');
  });

  it('is case-insensitive on the channel name and the mention', () => {
    const list = triggers('{ type: mention, source: { channels: ["#dev"] } }');
    expect(matchTrigger(list, 'coder', view({ channelName: 'DEV', mentions: new Set(['coder']) }))).toBe('mention');
  });

  it('a bot with no triggers of its own never runs', () => {
    expect(matchTrigger([], 'coder', view({ isBotChannel: true, mentions: new Set(['coder']) }))).toBeNull();
    // A trigger this phase does not route (a routine, a task assignment) is not a message trigger.
    expect(matchTrigger(triggers('{ type: routine }'), 'coder', view({ isBotChannel: true }))).toBeNull();
  });
});

describe('mentionedHandles', () => {
  it('reads the handles a body names, lowercased, and keeps the ones a bot slug needs', () => {
    expect([...mentionedHandles('hey @coder and @Builder-2 take a look')].sort()).toEqual(['builder-2', 'coder']);
    expect([...mentionedHandles('mail nadia@example.com')]).toEqual([]);
  });

  it('does not read a handle inside a URL or an inline code span', () => {
    expect([...mentionedHandles('see https://example.com/@coder')]).toEqual([]);
    expect([...mentionedHandles('write `@coder` to wake it')]).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('a conversation channel has no name: the prompt is the person and the message', () => {
    expect(buildPrompt({ authorName: 'Nadia', channelName: '', body: 'What is blocking the release?' })).toBe(
      'Nadia:\n\nWhat is blocking the release?',
    );
  });

  it('names the author, the channel and the message', () => {
    expect(buildPrompt({ authorName: 'Nadia', channelName: 'dev', body: '@coder what changed?' })).toBe(
      'Nadia in #dev:\n\n@coder what changed?',
    );
  });
});
