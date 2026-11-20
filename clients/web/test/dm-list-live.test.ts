// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelMessage, DirectMessageSummary } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { channelStore } from '../src/channels/store';
import { refreshDms, useDms } from '../src/dms/store';

// P34-05 (correction 9): the Messages list keeps each conversation's last line while it is open. The real channel store hears the message (pushed, or the
// answer to the reader's own POST); the DM list's store changes the row and moves it to the top; a deleted last line asks the list again.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ids are branded strings: a fixture id fits any of them
const uuid = (n: number): never => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as never;
const SELF = uuid(10);
const NADIA = uuid(12);
const NADIA_ACTOR = uuid(13);
const RAFI = uuid(14);

function dm(n: number, preview: string, at: string, other: { personId: string; displayName: string }): DirectMessageSummary {
  return {
    channel: { id: uuid(500 + n), workspaceId: uuid(900), teamId: null, groupId: null, name: `dm-${n}`, kind: 'dm', private: true, purpose: '', dmKey: `k${n}`, botId: null, position: 0, archivedAt: null, createdAt: '2026-11-01T08:00:00.000Z' },
    participants: [{ personId: SELF, displayName: 'Omar Haddad' }, other],
    lastMessage: { id: uuid(700 + n), authorId: NADIA_ACTOR, preview, createdAt: at },
    unreadCount: 0,
  } as unknown as DirectMessageSummary;
}

function msg(n: number, channelId: string, text: string, createdAt: string): ChannelMessage {
  return {
    id: uuid(800 + n),
    workspaceId: uuid(900),
    channelId,
    authorId: NADIA_ACTOR,
    body: text,
    bodyPlain: text,
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
  } as unknown as ChannelMessage;
}

let items: DirectMessageSummary[] = [];
let asked = 0;
function serve(): void {
  setTransport(async (req: TransportRequest) => {
    if (req.url.startsWith('/api/dms')) {
      asked += 1;
      return { status: 200, body: { items, nextCursor: null } };
    }
    return { status: 404, body: { error: { code: 'not_found', message: 'no' } } };
  });
}

let host: HTMLDivElement;
let root: Root;
function Probe() {
  const feed = useDms();
  return createElement('ol', null, ...feed.items.map((d) => createElement('li', { key: d.channel.id, 'data-id': d.channel.id }, d.lastMessage?.preview ?? '')));
}
const rows = (): { id: string; line: string }[] => [...host.querySelectorAll('li')].map((li) => ({ id: li.dataset.id ?? '', line: li.textContent ?? '' }));
const settle = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const nadia = dm(1, 'See you at ten', '2026-11-20T09:00:00.000Z', { personId: NADIA, displayName: 'Nadia Karim' });
const rafi = dm(2, 'Deploy is green', '2026-11-20T10:00:00.000Z', { personId: RAFI, displayName: 'Rafi Aziz' });

beforeEach(async () => {
  items = [rafi, nadia];
  asked = 0;
  serve();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  await act(async () => refreshDms());
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Messages list while it is open', () => {
  it('shows a message that arrives as its conversation\'s last line and moves the conversation to the top', async () => {
    expect(rows()).toEqual([{ id: rafi.channel.id, line: 'Deploy is green' }, { id: nadia.channel.id, line: 'See you at ten' }]);
    act(() => channelStore.applyPosted(msg(1, nadia.channel.id, 'Are you free for five minutes?', '2026-11-20T11:00:00.000Z')));
    expect(rows()).toEqual([{ id: nadia.channel.id, line: 'Are you free for five minutes?' }, { id: rafi.channel.id, line: 'Deploy is green' }]);
  });

  it('follows an edit of the last line, and asks the server again when the last line is deleted', async () => {
    const m = msg(2, rafi.channel.id, 'Deploy is red', '2026-11-20T11:30:00.000Z');
    act(() => channelStore.applyPosted(m));
    act(() => channelStore.handlePush({ type: 'message.edited', payload: { channelId: rafi.channel.id, messageId: m.id, threadRootId: null, message: { ...m, body: 'Deploy is red again', bodyPlain: 'Deploy is red again', editedAt: '2026-11-20T11:31:00.000Z' } } } as never));
    await settle();
    expect(rows()[0]).toEqual({ id: rafi.channel.id, line: 'Deploy is red again' });
    const before = asked;
    act(() => channelStore.handlePush({ type: 'message.deleted', payload: { channelId: rafi.channel.id, messageId: m.id, threadRootId: null } } as never));
    await settle();
    expect(asked).toBe(before + 1);
    expect(rows()[0]).toEqual({ id: rafi.channel.id, line: 'Deploy is green' });
  });
});
