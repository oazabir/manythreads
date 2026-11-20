// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P34-05 (owner decision e, 2026-11-19): on a phone the channel header is the name and the bell; the other tools are items of the channel details menu that do
// what their hidden buttons do. These render the real details menu with the real Members and voice buttons beside it (as the channel screen draws them).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = '00000000-0000-7000-8000-000000000100';

const h = vi.hoisted(() => ({
  state: {
    members: [] as { personId: string; displayName: string }[],
    pushed: [] as { type: string; id: string }[],
    live: undefined as unknown,
    call: { phase: 'idle', meeting: null as null | { id: string; channelId: string | null } },
  },
  start: vi.fn(),
  joinRoom: vi.fn(),
}));

vi.mock('../src/api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchChannelMembers: () => Promise.resolve({ members: h.state.members }),
  leaveChannel: () => Promise.resolve(),
}));
vi.mock('../src/api/setup', () => ({ isMockMode: () => false }));
vi.mock('../src/shell/context', () => ({ useShell: () => ({ guest: false, team: { slug: 'engineering' } }) }));
vi.mock('../src/shell/sidebarPrefsStore', () => ({ useSidebarPrefs: () => ({ status: 'loading' }), sidebarPrefsStore: {} }));
vi.mock('../src/notifications/ChannelBell', () => ({ ChannelLevelOptions: () => null }));
vi.mock('../src/webhooks/WebhooksDialog', () => ({ WebhooksDialog: () => null }));
vi.mock('../src/meetings/schedule/ScheduleRoomDialog', () => ({ ScheduleRoomDialog: () => null }));
vi.mock('../src/kernel/panel', () => ({
  usePanel: () => ({ push: (e: { type: string; id: string }) => void h.state.pushed.push(e), entries: [], close: () => undefined, back: () => undefined }),
}));
vi.mock('../src/meetings/store', () => ({
  useLiveRoom: () => h.state.live,
  useCall: () => h.state.call,
  callController: () => ({ start: h.start, joinRoom: h.joinRoom }),
}));

const { ChannelDetails } = await import('../src/shell/ChannelDetails');
const { MembersButton } = await import('../src/shell/MembersButton');
const { VoiceButton } = await import('../src/meetings/VoiceButton');
const { MEMBERS_PANEL } = await import('../src/shell/membersModel');

let host: HTMLDivElement;
let root: Root;
const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (!el) throw new Error(`no ${testId}`);
  return el;
};
const settle = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: HTMLElement): void => void act(() => el.click());

function draw(): void {
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          Fragment,
          null,
          createElement(ChannelDetails, { channelId: CHANNEL, name: 'dev', teamSlug: 'engineering', dm: false, canManage: false, label: '#dev' }),
          createElement(VoiceButton, { channelId: CHANNEL, dm: false }),
          createElement(MembersButton, { channelId: CHANNEL }),
        ),
      ),
    ),
  );
}

beforeEach(() => {
  h.state.members = [
    { personId: 'p1', displayName: 'Omar' },
    { personId: 'p2', displayName: 'Nadia' },
  ];
  h.state.pushed = [];
  h.state.live = undefined;
  h.state.call = { phase: 'idle', meeting: null };
  h.start.mockReset().mockResolvedValue(undefined);
  h.joinRoom.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the channel details menu on a phone', () => {
  it('starts with the header tools in the header order, named as their buttons are, before Notifications', async () => {
    draw();
    await settle();
    click(must('channel-details-button'));
    const items = [...must('channel-details').querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.dataset.testid);
    expect(items.slice(0, 3)).toEqual(['details-voice', 'details-members-open', 'details-notifications']);
    expect(must('details-voice').textContent).toContain('Start a voice room');
    expect(must('details-members-open').textContent).toContain('Members (2)');
    expect(must('details-members-open').classList.contains('chd-head-tool')).toBe(true);
    // the list view of Members steps aside on a phone (its twin above opens the panel), but stays for a desktop
    expect(must('details-members').classList.contains('chd-head-twin')).toBe(true);
  });

  it('opens the Members panel from its item, closes the menu and gives the keyboard back to the channel name', async () => {
    draw();
    await settle();
    click(must('channel-details-button'));
    click(must('details-members-open'));
    expect(h.state.pushed).toEqual([{ type: MEMBERS_PANEL, id: CHANNEL }]);
    expect(q('channel-details')).toBeNull();
    expect(document.activeElement).toBe(must('channel-details-button'));
  });

  it('starts the voice room from its item, and joins a live room the same way the icon does', async () => {
    draw();
    await settle();
    click(must('channel-details-button'));
    click(must('details-voice'));
    expect(h.start).toHaveBeenCalledWith(CHANNEL);
    h.state.live = { meeting: { id: 'm1', threadRootId: null }, present: [] };
    draw();
    click(must('channel-details-button'));
    expect(must('details-voice').textContent).toContain('Join the voice room');
    click(must('details-voice'));
    expect(h.joinRoom).toHaveBeenCalledWith('m1', CHANNEL);
  });

  it('shows "In the voice room" as a state, not a thing to press, while the reader is in it', async () => {
    h.state.call = { phase: 'connected', meeting: { id: 'm1', channelId: CHANNEL } };
    draw();
    await settle();
    click(must('channel-details-button'));
    const item = must('details-voice') as HTMLButtonElement;
    expect(item.textContent).toContain('In the voice room');
    expect(item.disabled).toBe(true);
    // the keyboard starts on the first item that can be pressed
    expect(document.activeElement).toBe(must('details-members-open'));
  });

  it('takes a tool out of the menu when its button goes', async () => {
    draw();
    await settle();
    act(() => root.render(createElement(MemoryRouter, null, createElement(ChannelDetails, { channelId: CHANNEL, name: 'dev', teamSlug: 'engineering', dm: false, canManage: false, label: '#dev' }))));
    click(must('channel-details-button'));
    expect(q('details-voice')).toBeNull();
    expect(q('details-members-open')).toBeNull();
    expect(must('details-members').classList.contains('chd-head-twin')).toBe(false);
  });
});
