import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelMessage, ChatThreadState, ConversationListItem } from '@manythreads/shared';
import { crumbsFor } from '../src/shell/breadcrumb';
import { EmptyChat, greetingFor } from '../src/screens/chat/EmptyChat';
import { HistoryRail } from '../src/screens/chat/HistoryRail';
import { ReplyActions } from '../src/screens/chat/ReplyActions';
import { optionFor, pickedAlias } from '../src/screens/chat/models';
import {
  NO_PREVIEW,
  answerStatus,
  applyFrame,
  awaitingAnswer,
  buildRows,
  exportFileName,
  exportMarkdown,
  EARLY_FRAMES,
  frameOf,
  holdEarly,
  neighbourVariant,
  previewLive,
  railGroups,
  railTitle,
  retryOf,
  shortTitle,
  takeEarly,
  variantPosition,
  type ChatRow,
} from '../src/screens/chat/model';

const id = (n: number): string => `0194f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = 'actor-me';
const BOT = 'actor-bot';

const msg = (n: number, authorId: string, body: string, extra: Partial<ChannelMessage> = {}): ChannelMessage =>
  ({ id: id(n), authorId, body, bodyPlain: body, createdAt: `2026-11-06T10:0${String(n)}:00.000Z`, deletedAt: null, meta: {}, reactions: [], replyCount: 0, lastReplyAt: null, ...extra }) as unknown as ChannelMessage;

const item = (n: number, at: string, extra: Partial<ConversationListItem> = {}): ConversationListItem =>
  ({ threadRootId: id(n), title: `Chat ${String(n)}`, pinned: false, lastActivityAt: at, unreadCount: 0, ...extra }) as unknown as ConversationListItem;

describe('railGroups', () => {
  const now = new Date(2026, 10, 6, 15, 0, 0);
  it('puts pinned first and groups the rest by the day of the last activity', () => {
    const groups = railGroups(
      [
        item(1, new Date(2026, 10, 6, 9, 0).toISOString()),
        item(2, new Date(2026, 10, 5, 23, 0).toISOString()),
        item(3, new Date(2026, 10, 1, 8, 0).toISOString()),
        item(4, new Date(2026, 9, 1, 8, 0).toISOString()),
        item(5, new Date(2026, 9, 1, 8, 0).toISOString(), { pinned: true }),
      ],
      now,
    );
    expect(groups.map((g) => [g.id, g.items.map((i) => i.title)])).toEqual([
      ['pinned', ['Chat 5']],
      ['today', ['Chat 1']],
      ['yesterday', ['Chat 2']],
      ['week', ['Chat 3']],
      ['older', ['Chat 4']],
    ]);
  });
  it('leaves out a group with nothing in it', () => {
    expect(railGroups([item(1, new Date(2026, 10, 6, 9, 0).toISOString())], now).map((g) => g.id)).toEqual(['today']);
    expect(railGroups([], now)).toEqual([]);
  });
  it('names a chat with no title by a plain placeholder', () => {
    expect(railTitle({ title: '  ' })).toBe('New chat');
    expect(railTitle({ title: ' Plan ' })).toBe('Plan');
  });
  it('shows one short line: whitespace folded, cut at a word with an ellipsis', () => {
    expect(railTitle({ title: 'Plan\n\nthe   launch' })).toBe('Plan the launch');
    expect(shortTitle('Plan the launch')).toBe('Plan the launch');
    const long = 'Write a plan for moving the whole team to the new release process before the end of the quarter, with owners';
    const cut = shortTitle(long);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long.charAt(cut.length - 1)).toBe(' ');
    expect(shortTitle('x'.repeat(100))).toBe(`${'x'.repeat(59)}…`);
  });
});

describe('buildRows', () => {
  const root = msg(1, ME, 'What changed?');
  const a1 = msg(2, BOT, 'First answer');
  const a2 = msg(3, BOT, 'Second answer');
  const turn = (chosen: 1 | 2): ChatThreadState =>
    ({
      turns: [
        {
          turnMessageId: root.id,
          variants: [
            { messageId: a1.id, variantNo: 1, chosen: chosen === 1, modelAlias: null, stopped: false, runId: null },
            { messageId: a2.id, variantNo: 2, chosen: chosen === 2, modelAlias: null, stopped: false, runId: null },
          ],
        },
      ],
    }) as unknown as ChatThreadState;

  it('shows only the chosen answer of a turn, with its place among the answers', () => {
    const rows = buildRows(root, [a1, a2], turn(2), ME);
    expect(rows.map((r) => r.message.body)).toEqual(['What changed?', 'Second answer']);
    const bot = rows[1] as Extract<ChatRow, { kind: 'bot' }>;
    expect(variantPosition(bot)).toEqual({ at: 2, of: 2 });
    expect(neighbourVariant(bot, -1)).toBe(a1.id);
    expect(neighbourVariant(bot, 1)).toBeNull();
  });
  it('shows an answer the server has not recorded yet, without the control', () => {
    const rows = buildRows(root, [a1], null, ME);
    const bot = rows[1] as Extract<ChatRow, { kind: 'bot' }>;
    expect(bot.kind).toBe('bot');
    expect(variantPosition(bot)).toBeNull();
  });
  it('draws a deleted message nowhere and a second question of the person as a turn of its own', () => {
    const q2 = msg(4, ME, 'And then?');
    const gone = msg(5, BOT, 'oops', { deletedAt: '2026-11-06T10:09:00.000Z' });
    const rows = buildRows(root, [a1, q2, gone], null, ME);
    expect(rows.map((r) => r.kind)).toEqual(['person', 'bot', 'person']);
    expect(awaitingAnswer(rows)).toBe(true);
    expect(awaitingAnswer(rows.slice(0, 2))).toBe(false);
  });
  it('offers Try again only on the notice a failed run left, for the turn of the message before it', () => {
    const notice = msg(6, BOT, 'I could not answer this one. Try again in a moment.', { meta: { runFailure: 'runtime' } as never });
    const failed = buildRows(root, [notice], null, ME);
    expect(retryOf(failed)).toEqual({ messageId: notice.id, turnId: root.id });
    // an answer the server has not recorded yet, a person's own message, and a notice that is not the last row are not offered
    expect(retryOf(buildRows(root, [a1], null, ME))).toBeNull();
    expect(retryOf(buildRows(root, [], null, ME))).toBeNull();
    const later = buildRows(root, [notice, msg(7, ME, 'Again?')], null, ME);
    expect(retryOf(later)).toBeNull();
  });
});

describe('the live preview', () => {
  const thread = id(1);
  const run = id(90);
  const delta = (offset: number, text: string, runId = run) => ({ type: 'delta' as const, push: { runId, channelId: id(50), threadRootId: thread, offset, text } }) as never;
  it('appends pieces in order and drops a repeat', () => {
    let p = applyFrame(NO_PREVIEW, delta(0, 'Hel'), thread);
    p = applyFrame(p, delta(3, 'lo'), thread);
    p = applyFrame(p, delta(3, 'lo'), thread);
    p = applyFrame(p, delta(2, 'llo wor'), thread);
    expect(p.text).toBe('Hello wor');
    expect(previewLive(p)).toBe(true);
  });
  it('gives up its words at a gap rather than show text with a hole in it, and keeps waiting for the end', () => {
    let p = applyFrame(applyFrame(NO_PREVIEW, delta(0, 'ab'), thread), delta(10, 'cd'), thread);
    expect(p).toMatchObject({ text: '', partial: true });
    p = applyFrame(p, delta(12, 'ef'), thread);
    expect(p.text).toBe('');
    expect(previewLive(p)).toBe(true);
  });
  it('does the same for a page opened in the middle of an answer: the first piece it sees does not start at 0', () => {
    const p = applyFrame(NO_PREVIEW, delta(240, 'and so on'), thread);
    expect(p).toMatchObject({ text: '', partial: true, runId: run });
  });
  it('tells a screen reader one short sentence at the start and at the end, never the words', () => {
    expect(answerStatus(true, null, 'Brain')).toBe('Brain is writing an answer.');
    expect(answerStatus(false, 'done', 'Brain')).toBe('Brain answered.');
    expect(answerStatus(false, 'stopped', 'Brain')).toBe('');
    expect(answerStatus(false, null, 'Brain')).toBe('');
  });
  it('keeps the frames that come before a new chat has its thread, and gives them to that thread only', () => {
    let held: ReturnType<typeof holdEarly> = [];
    held = holdEarly(held, { type: 'delta', push: { runId: run, channelId: id(50), threadRootId: thread, offset: 0, text: 'Hi' } } as never);
    held = holdEarly(held, { type: 'delta', push: { runId: id(92), channelId: id(50), threadRootId: id(2), offset: 0, text: 'other' } } as never);
    held = holdEarly(held, { type: 'delta', push: { runId: run, channelId: id(50), threadRootId: thread, offset: 2, text: ' there' } } as never);
    const mine = takeEarly(held, thread);
    expect(mine).toHaveLength(2);
    expect(mine.reduce((p, f) => applyFrame(p, f, thread), NO_PREVIEW).text).toBe('Hi there');
    for (let i = 0; i < EARLY_FRAMES * 2; i += 1) held = holdEarly(held, { type: 'looking', push: { runId: run, channelId: id(50), threadRootId: thread, label: 'x', tool: 'x' } } as never);
    expect(held).toHaveLength(EARLY_FRAMES);
  });
  it('ignores another conversation, and starts again for another run', () => {
    const p = applyFrame(NO_PREVIEW, delta(0, 'abc'), thread);
    expect(applyFrame(p, { type: 'delta', push: { runId: run, channelId: id(50), threadRootId: id(2), offset: 3, text: 'x' } } as never, thread)).toBe(p);
    expect(applyFrame(p, delta(0, 'new', id(91)), thread).text).toBe('new');
  });
  it('lists what the bot looked at once each and ends with the run', () => {
    const looking = (label: string) => ({ type: 'looking' as const, push: { runId: run, channelId: id(50), threadRootId: thread, label, tool: 'x' } }) as never;
    let p = applyFrame(NO_PREVIEW, looking('Searching memory'), thread);
    p = applyFrame(p, looking('Searching memory'), thread);
    p = applyFrame(p, looking('3 knowledge hits'), thread);
    expect(p.looking).toEqual(['Searching memory', '3 knowledge hits']);
    p = applyFrame(p, { type: 'ended', push: { runId: run, channelId: id(50), threadRootId: thread, status: 'stopped' } } as never, thread);
    expect(p.ended).toBe('stopped');
    expect(previewLive(p)).toBe(false);
  });
  it('reads a push of the contract and nothing else', () => {
    expect(frameOf({ type: 'run.delta', payload: { runId: run, channelId: id(50), threadRootId: thread, offset: 0, text: 'hi' } })?.type).toBe('delta');
    expect(frameOf({ type: 'run.delta', payload: { text: 'hi' } })).toBeNull();
    expect(frameOf({ type: 'message.posted', payload: {} })).toBeNull();
  });
});

describe('export', () => {
  it('writes the title and each message under who wrote it', () => {
    const rows = buildRows(msg(1, ME, 'Hi'), [msg(2, BOT, 'Hello')], null, ME);
    expect(exportMarkdown('Greeting', rows, { you: 'Nadia', bot: 'Brain' })).toBe('# Greeting\n\n**Nadia**\n\nHi\n\n**Brain**\n\nHello\n');
  });
  it('makes a plain file name', () => {
    expect(exportFileName('Q3 plan: what next?')).toBe('q3-plan-what-next.md');
    expect(exportFileName('???')).toBe('chat.md');
  });
});

describe('the model menu and the greeting', () => {
  const options = [
    { alias: 'smart', label: 'Smart', hint: '', available: true, reason: null, isDefault: true },
    { alias: 'fast', label: 'Fast', hint: '', available: true, reason: null, isDefault: false },
  ];
  it('uses the pick, then the conversation, then the first alias, and never one that is not on the menu', () => {
    expect(pickedAlias(options, 'fast', 'smart')).toBe('fast');
    expect(pickedAlias(options, null, 'fast')).toBe('fast');
    expect(pickedAlias(options, 'gone', null)).toBe('smart');
    expect(pickedAlias([], null, null)).toBeNull();
    expect(optionFor(options, 'fast')?.label).toBe('Fast');
  });
  it('greets by the part of the day with the first name', () => {
    expect(greetingFor('Nadia Hassan', 9)).toBe('Good morning, Nadia');
    expect(greetingFor('Nadia', 14)).toBe('Good afternoon, Nadia');
    expect(greetingFor('Nadia', 20)).toBe('Good evening, Nadia');
    expect(greetingFor('', 9)).toBe('Good morning');
  });
});

describe('the pieces of the screen', () => {
  const noop = (): void => undefined;
  it('draws the history with its groups, the unread dot and a menu button named for the chat', () => {
    const groups = railGroups([item(1, new Date().toISOString(), { unreadCount: 2 }), item(2, new Date().toISOString(), { pinned: true })]);
    const html = renderToStaticMarkup(
      createElement(HistoryRail, {
        groups, selected: id(1), query: '', onQuery: noop, status: 'ok', onRetry: noop, more: true, loadingMore: false, onMore: noop, onNew: noop, drawer: null, onClose: noop,
        searchRef: createRef<HTMLInputElement>(), actions: { onOpen: noop, onRename: noop, onPin: noop, onExport: noop, onDelete: noop },
      }),
    );
    expect(html).toContain('data-testid="chat-group-pinned"');
    expect(html).toContain('data-testid="chat-group-today"');
    // a row holds buttons, so it is a plain list item with the open chat marked "current" (an option may not contain a button)
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('data-testid="chat-row-unread"');
    expect(html).toContain('aria-label="Options for Chat 1"');
    expect(html).toContain('data-testid="chat-older"');
    expect(html).not.toContain('inert');
  });
  it('closes the drawer for the keyboard when the rail is a drawer that is shut', () => {
    const html = renderToStaticMarkup(
      createElement(HistoryRail, {
        groups: [], selected: null, query: '', onQuery: noop, status: 'ok', onRetry: noop, more: false, loadingMore: false, onMore: noop, onNew: noop, drawer: false, onClose: noop,
        searchRef: createRef<HTMLInputElement>(), actions: { onOpen: noop, onRename: noop, onPin: noop, onExport: noop, onDelete: noop },
      }),
    );
    expect(html).toContain('inert');
    expect(html).toContain('data-testid="chat-history-empty"');
  });
  it('shows the ‹ 2 / 3 › control only when there is more than one answer, and the thumbs as pressed buttons', () => {
    const base = { vote: null, reason: '', canRegenerate: true, onCopy: noop, onRegenerate: noop, onPrevious: null, onNext: noop, onVote: noop } as const;
    const one = renderToStaticMarkup(createElement(ReplyActions, { ...base, position: null }));
    expect(one).not.toContain('chat-variants');
    const many = renderToStaticMarkup(createElement(ReplyActions, { ...base, position: { at: 2, of: 3 }, vote: 'up' }));
    expect(many).toContain('2 / 3');
    expect(many).toContain('aria-label="Previous answer"');
    expect(many).toMatch(/data-testid="chat-thumb-up"/);
    expect(many).toMatch(/aria-pressed="true"[^>]*title="Good answer"/);
  });
  it('offers at most four things to ask and says why nobody can ask when the bot is off', () => {
    const chips = renderToStaticMarkup(createElement(EmptyChat, { name: 'Nadia', botName: 'Brain', prompts: ['a', 'b', 'c', 'd', 'e'], disabled: false, onPick: noop, blocked: null, children: 'BOX' }));
    expect(chips.match(/data-testid="chat-prompt"/g)).toHaveLength(4);
    expect(chips).toContain('BOX');
    const off = renderToStaticMarkup(createElement(EmptyChat, { name: 'Nadia', botName: 'Brain', prompts: ['a'], disabled: true, onPick: noop, blocked: 'Brain is turned off.', children: 'BOX' }));
    expect(off).toContain('Brain is turned off.');
    expect(off).not.toContain('chat-prompt');
  });
  it('names the Chat page in the trail, and a link to one chat under Bots', () => {
    expect(crumbsFor('/t/eng/chat', 'Engineering').map((c) => c.label)).toEqual(['Engineering', 'Chat']);
    expect(crumbsFor('/t/eng/chat/0194f0a0', 'Engineering', 'Brain').map((c) => c.label)).toEqual(['Engineering', 'Bots', 'Brain']);
  });
});
