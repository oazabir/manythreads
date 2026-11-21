// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCard, ChannelMessage } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import { PeopleContext, type People } from '../src/channels/hooks';
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

// pinned call rows show the same small "Pinned" mark as other rows: on the live card, the ended line and the line drawn before the card loads, once per row
describe('a pinned call\'s start message', () => {
  const PINNER = uuid(2);
  const pin = { by: PINNER, at: '2026-11-18T22:20:00.000Z' } as unknown as ChannelMessage['pinned'];
  const named: People = { ...people, byActor: (id: string) => (id === PINNER ? ({ name: 'Nadia' } as ReturnType<People['byActor']>) : undefined) };
  const live: CallCard = {
    ...ended,
    state: 'live',
    endedAt: null,
    durationSeconds: null,
    present: [{ actorId: ME, displayName: 'Omar' }],
    presentCount: 1,
    joinedCount: 1,
  } as unknown as CallCard;
  const answer = (cards: CallCard[] | null): void =>
    setTransport(async (req) => {
      asked.push(req.url);
      // null: the cards never answer, so the row keeps the line drawn before the card loads
      if (cards === null) return new Promise(() => undefined);
      return { status: 200, body: { cards } };
    });
  async function drawWith(m: ChannelMessage, who: People = people): Promise<void> {
    await act(async () => {
      // the shell gives the call card the same roster as the row (`PeopleContext`)
      const row = createElement(MessageRow, { message: m, teamSlug: null, people: who, selfActor: ME, canPost: true, inThread: false, actions });
      root.render(createElement(PeopleContext.Provider, { value: who }, createElement(MemoryRouter, null, row)));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 30))));
  }
  const marks = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="pinned-mark"]')];

  it('marks the ended line once, after its text and before Notes, and not when unpinned', async () => {
    answer([{ ...ended, notesLink: '/notes/1' } as CallCard]);
    await drawWith(message({ pinned: pin }));
    expect(q('call-event')?.dataset['state']).toBe('ended');
    expect(marks()).toHaveLength(1);
    const mark = marks()[0]!;
    expect(mark.closest('[data-testid="call-event"]')).not.toBeNull();
    expect(mark.previousElementSibling?.classList.contains('ev-text')).toBe(true);
    expect(mark.compareDocumentPosition(q('call-event-notes')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark.textContent).toContain('Pinned');
    await drawWith(message());
    expect(marks()).toHaveLength(0);
  });

  // the meta line already wraps at the thread pane's width (smoke round 1), so the mark sits in the header, on the title's line after the title (which
  // ellipsizes), never in the meta line
  it('marks the live card once, on its title line in the header (not in the meta line), and not when unpinned', async () => {
    answer([live]);
    await drawWith(message({ pinned: pin }));
    expect(q('room-card')).not.toBeNull();
    expect(marks()).toHaveLength(1);
    const mark = marks()[0]!;
    expect(mark.parentElement?.classList.contains('room-card-titleline')).toBe(true);
    expect(mark.closest('.room-card-head')).not.toBeNull();
    expect(mark.previousElementSibling?.classList.contains('room-card-title')).toBe(true);
    expect(mark.nextElementSibling).toBeNull();
    expect(mark.closest('.room-card-meta')).toBeNull();
    await drawWith(message());
    expect(q('room-card')).not.toBeNull();
    expect(marks()).toHaveLength(0);
  });

  it('marks the line drawn before the card loads, so the mark never appears late, and not when unpinned', async () => {
    answer(null);
    await drawWith(message({ pinned: pin }));
    expect(q('call-event')?.dataset['state']).toBe('start');
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.previousElementSibling?.classList.contains('ev-text')).toBe(true);
    await drawWith(message());
    expect(marks()).toHaveLength(0);
  });

  it('draws no mark on a deleted row', async () => {
    answer([ended]);
    await drawWith(message({ pinned: pin, deletedAt: '2026-11-18T22:30:00.000Z' }));
    expect(marks()).toHaveLength(0);
  });

  it('names who pinned it in the tooltip, on the ended line', async () => {
    answer([ended]);
    await drawWith(message({ pinned: pin }), named);
    expect(marks()[0]?.title).toBe('Pinned by Nadia');
  });

  it('names who pinned it in the tooltip, on the live card', async () => {
    answer([live]);
    await drawWith(message({ pinned: pin }), named);
    expect(q('room-card')).not.toBeNull();
    expect(marks()[0]?.title).toBe('Pinned by Nadia');
  });

  // Tester round 1: the cases the coder's tests leave open.
  it('names who pinned it in the tooltip, on the line drawn before the card loads', async () => {
    answer(null);
    await drawWith(message({ pinned: pin }), named);
    expect(q('call-event')?.dataset['state']).toBe('start');
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.title).toBe('Pinned by Nadia');
  });

  it('says "Pinned to the channel" when the roster does not know who pinned it', async () => {
    answer([ended]);
    await drawWith(message({ pinned: pin }));
    expect(marks()[0]?.title).toBe('Pinned to the channel');
  });

  it('marks the ended line once in the thread pane too', async () => {
    answer([ended]);
    await act(async () => {
      const row = createElement(MessageRow, { message: message({ pinned: pin }), teamSlug: null, people, selfActor: ME, canPost: true, inThread: true, actions });
      root.render(createElement(PeopleContext.Provider, { value: people }, createElement(MemoryRouter, null, row)));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 30))));
    expect(q('call-event')?.dataset['state']).toBe('ended');
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.closest('[data-testid="call-event"]')).not.toBeNull();
  });

  it('draws the mark when the pin arrives after the row is drawn, on the live card', async () => {
    answer([live]);
    await drawWith(message());
    expect(marks()).toHaveLength(0);
    await drawWith(message({ pinned: pin }));
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.parentElement?.classList.contains('room-card-titleline')).toBe(true);
  });

  it('keeps the mark on one line and unshrunk in a call row (CSS)', () => {
    const css = readFileSync(join(__dirname, '../src/styles/channels.css'), 'utf8');
    const at = css.lastIndexOf('\n.msg-call .msg-pinned {');
    expect(at, 'a rule for .msg-call .msg-pinned').toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toMatch(/flex: none/);
    expect(body).toMatch(/white-space: nowrap/);
    // the shared look (colour, size) also applies to the call row's mark
    expect(css).toMatch(/\.who \.msg-pinned,\s*\n\.msg-call \.msg-pinned \{[^}]*color: var\(--warn-ink\)/);
  });

  // Tester round 2: the live card's mark on the title line (smoke round 1).
  it('leaves the live card\'s meta line the same pinned or not, and keeps the title line unpinned', async () => {
    answer([live]);
    const meta = (): string[] => [...host.querySelectorAll('.room-card-meta > *')].map((e) => e.className);
    await drawWith(message());
    const unpinned = meta();
    expect(host.querySelector('.room-card-titleline > .room-card-title')).not.toBeNull();
    expect(host.querySelectorAll('.room-card-titleline > *')).toHaveLength(1);
    await drawWith(message({ pinned: pin }));
    expect(meta()).toEqual(unpinned);
    expect(host.querySelectorAll('.room-card-titleline > *')).toHaveLength(2);
  });

  it('lets the live card\'s title ellipsize beside the mark on its line (CSS)', () => {
    const css = readFileSync(join(__dirname, '../src/styles/meetings.css'), 'utf8');
    const rule = (sel: string): string => {
      const at = css.indexOf(`\n${sel} {`);
      expect(at, `a rule for ${sel}`).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    const line = rule('.room-card-titleline');
    expect(line).toMatch(/display: flex/);
    expect(line).toMatch(/min-width: 0/);
    const title = rule('.room-card-title');
    for (const decl of [/min-width: 0/, /overflow: hidden/, /text-overflow: ellipsis/, /white-space: nowrap/]) expect(title).toMatch(decl);
  });
});
