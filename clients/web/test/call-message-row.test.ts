// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCard, ChannelMessage } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import type { People } from '../src/channels/hooks';
import { EDIT_EVENT, MessageRow, type RowActions } from '../src/channels/MessageRow';
import { lastEditableOwn } from '../src/channels/messageActions';
import { CARD_BATCH_MS, callCards } from '../src/meetings/callCards';

// P15-26: a call's start message (stamped `meta.meeting`) in a real message row: the card or the event line in place of the text, no picture and no author
// line, no Edit, and the same in the thread pane (correction 8).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = uuid(1);
const CALL = uuid(200);

const people: People = {
  loaded: true,
  settled: true,
  list: [],
  bots: [],
  byActor: () => undefined,
  byPerson: () => undefined,
  botAvatar: () => undefined,
  botAvatarBySlug: () => undefined,
  isBotHandle: () => false,
  me: undefined,
  canModerate: false,
};
const actions: RowActions = { react: () => undefined, edit: () => Promise.resolve(), remove: () => Promise.resolve() };

const ended: CallCard = {
  meetingId: CALL,
  kind: 'audio',
  title: 'Call · #dev · 22:14',
  state: 'ended',
  startedBy: ME,
  starterName: 'Omar',
  startedAt: '2026-11-18T22:14:00.000Z',
  endedAt: '2026-11-18T22:28:00.000Z',
  durationSeconds: 840,
  present: [],
  presentCount: 0,
  joinedCount: 3,
  invited: { count: 0, names: [] },
  notetaker: null,
  you: { joined: false, canEnd: false, canInvite: false },
  notesLink: null,
} as unknown as CallCard;

function message(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(700),
    workspaceId: uuid(901),
    channelId: uuid(900),
    authorId: ME,
    author: { actorId: ME, kind: 'person', displayName: 'Omar' },
    body: 'Started a call: Call · #dev · 22:14',
    bodyPlain: 'Started a call: Call · #dev · 22:14',
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: { meeting: { meetingId: CALL } },
    attachments: [],
    createdAt: '2026-11-18T22:14:00.000Z',
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as unknown as ChannelMessage;
}

let host: HTMLDivElement;
let root: Root;
const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  callCards().reset();
  setTransport(async (req) => {
    asked.push(req.url);
    return { status: 200, body: { cards: [ended] } };
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);

async function draw(m: ChannelMessage, inThread = false): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(MessageRow, { message: m, teamSlug: null, people, selfActor: ME, canPost: true, inThread, actions })));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 30))));
}

describe('a call\'s start message in a row', () => {
  it('draws the event line in place of the stored text, with no picture and no author line', async () => {
    await draw(message());
    expect(asked).toEqual([`/api/meetings/cards?ids=${encodeURIComponent(CALL)}`]);
    expect(q('call-event')?.dataset['state']).toBe('ended');
    expect(q('call-event')?.textContent).toContain('Omar started a call');
    expect(host.textContent).not.toContain('Started a call:');
    const row = host.querySelector('.msg');
    expect(row?.classList.contains('msg-call')).toBe(true);
    expect(host.querySelector('.msg > .av, .msg > .av-wrap, .msg .who')).toBeNull();
  });

  it('draws the same in the thread pane (the root of the call\'s chat)', async () => {
    await draw(message(), true);
    expect(q('call-event')?.dataset['state']).toBe('ended');
    expect(host.textContent).not.toContain('Started a call:');
  });

  it('offers no Edit, from the menu, the E key or the composer\'s Up arrow', async () => {
    await draw(message());
    const row = host.querySelector<HTMLElement>('.msg')!;
    await act(async () => row.focus());
    await act(async () => host.querySelector<HTMLElement>('[aria-label="More actions"]')!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
    expect(items.some((t) => t.startsWith('Copy text'))).toBe(true);
    expect(items.some((t) => t.startsWith('Edit'))).toBe(false);
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })));
    await act(async () => void window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: uuid(700) })));
    expect(host.querySelector('textarea[aria-label="Edit message"]')).toBeNull();
    expect(lastEditableOwn([message()], ME)).toBeNull();
  });
});
