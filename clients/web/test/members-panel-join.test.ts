// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id } from './meetings-fixtures';

// The Members panel when the reader is not in the channel: their own row outside offers Join (label "Join #<channel>", Joining… while it runs); everyone
// else's row keeps Add. Both call addChannelMember with that row's person. Mocks follow the Members panel suite in channel-header.test.ts.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = id(100);
const OMAR = id(11);
const NADIA = id(12);
const RAFI = id(13);

const h = vi.hoisted(() => {
  const state = {
    guest: false,
    canManage: true,
    archived: false,
    members: [] as { personId: string; displayName: string }[],
    roster: [] as { personId: string; displayName: string; avatar: string | null }[],
    pushed: [] as { type: string; id: string }[],
    entries: [] as { type: string; id: string }[],
  };
  return { state, addChannelMember: vi.fn(), back: vi.fn(), close: vi.fn() };
});

vi.mock('../src/api/endpoints', () => ({
  fetchChannel: () => Promise.resolve({ channel: { id: CHANNEL, name: 'dev', archivedAt: h.state.archived ? '2026-11-01T00:00:00.000Z' : null }, isMember: false, canPost: true, canManage: h.state.canManage }),
  fetchChannelMembers: () => Promise.resolve({ members: h.state.members }),
  fetchRoster: () => Promise.resolve({ members: h.state.roster }),
  addChannelMember: (channelId: string, personId: string) => h.addChannelMember(channelId, personId),
}));
vi.mock('../src/shell/context', () => ({ useShell: () => ({ guest: h.state.guest, team: { slug: 'engineering' } }) }));
vi.mock('../src/channels/hooks', () => ({ usePeople: () => ({ me: { personId: OMAR, actorId: 'a-omar' }, byActor: () => undefined }) }));
vi.mock('../src/kernel/panel', () => ({
  usePanel: () => ({ push: (e: { type: string; id: string }) => void h.state.pushed.push(e), top: () => h.state.entries.at(-1) ?? null, entries: h.state.entries, close: h.close, back: h.back }),
}));
vi.mock('../src/kernel/panel/sub', () => ({ usePanelTitle: () => undefined }));
vi.mock('../src/presence/PresenceDot', () => ({ PresenceDot: () => null }));
vi.mock('../src/api/setup', () => ({ isMockMode: () => false }));

const { MembersPanel } = await import('../src/shell/MembersPanel');

let host: HTMLDivElement;
let root: Root;
const all = (testId: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const settle = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: HTMLElement): void => void act(() => el.click());
const buttonOf = (personId: string): HTMLButtonElement | null =>
  all('member-row').find((r) => r.dataset['personId'] === personId)?.querySelector<HTMLButtonElement>('[data-testid="member-add"]') ?? null;
const mount = async (): Promise<void> => {
  act(() => root.render(createElement(MembersPanel, { entry: { type: 'members', id: CHANNEL } })));
  await settle();
  await settle();
};

beforeEach(() => {
  h.state.guest = false;
  h.state.canManage = true;
  h.state.archived = false;
  // the reader (Omar) is not in the channel
  h.state.members = [{ personId: NADIA, displayName: 'Nadia' }];
  h.state.roster = [
    { personId: OMAR, displayName: 'Omar', avatar: null },
    { personId: NADIA, displayName: 'Nadia', avatar: null },
    { personId: RAFI, displayName: 'Rafi', avatar: null },
  ];
  h.state.pushed = [];
  h.state.entries = [];
  h.back.mockReset();
  h.close.mockReset();
  h.addChannelMember.mockReset().mockResolvedValue({ added: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Members panel, own row outside the channel', () => {
  it('shows Join on the reader\'s own row, labelled "Join #dev"', async () => {
    await mount();
    const mine = buttonOf(OMAR)!;
    expect(mine.textContent).toBe('Join');
    expect(mine.getAttribute('aria-label')).toBe('Join #dev');
    expect(mine.classList.contains('mpn-add')).toBe(true);
  });

  it('shows Joining… and is disabled while the request runs', async () => {
    let done: (v: unknown) => void = () => undefined;
    h.addChannelMember.mockReturnValueOnce(new Promise((r) => (done = r)));
    await mount();
    const mine = buttonOf(OMAR)!;
    click(mine);
    expect(mine.textContent).toBe('Joining…');
    expect(mine.disabled).toBe(true);
    expect(mine.getAttribute('aria-label')).toBe('Join #dev');
    await act(async () => done({ added: true }));
    await settle();
  });

  it('calls addChannelMember with the reader\'s own id', async () => {
    await mount();
    click(buttonOf(OMAR)!);
    await settle();
    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, OMAR);
    expect(buttonOf(OMAR)).toBeNull();
  });

  it('keeps Add, labelled "Add Rafi to #dev", on another person\'s row', async () => {
    await mount();
    const rafi = buttonOf(RAFI)!;
    expect(rafi.textContent).toBe('Add');
    expect(rafi.getAttribute('aria-label')).toBe('Add Rafi to #dev');
    let done: (v: unknown) => void = () => undefined;
    h.addChannelMember.mockReturnValueOnce(new Promise((r) => (done = r)));
    click(rafi);
    expect(rafi.textContent).toBe('Adding…');
    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, RAFI);
    await act(async () => done({ added: true }));
    await settle();
  });

  it('has no button on anyone\'s row without the right to manage', async () => {
    h.state.canManage = false;
    await mount();
    expect(all('member-add')).toHaveLength(0);
  });
});
