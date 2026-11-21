// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id } from './meetings-fixtures';

// Acceptance cases for the Join button on the reader's own row in the Members panel that members-panel-join.test.ts does not cover:
// people already in the channel get no button (the reader included), the guest and archived gates, the other rows while Join runs,
// and the button coming back after a failed join. Mocks follow members-panel-join.test.ts.

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
  };
  return { state, addChannelMember: vi.fn() };
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
  usePanel: () => ({ push: () => undefined, top: () => null, entries: [], close: () => undefined, back: () => undefined }),
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
const rowOf = (personId: string): HTMLElement | undefined => all('member-row').find((r) => r.dataset['personId'] === personId);
const buttonOf = (personId: string): HTMLButtonElement | null => rowOf(personId)?.querySelector<HTMLButtonElement>('[data-testid="member-add"]') ?? null;
const mount = async (): Promise<void> => {
  act(() => root.render(createElement(MembersPanel, { entry: { type: 'members', id: CHANNEL } })));
  await settle();
  await settle();
};

beforeEach(() => {
  h.state.guest = false;
  h.state.canManage = true;
  h.state.archived = false;
  h.state.members = [{ personId: NADIA, displayName: 'Nadia' }];
  h.state.roster = [
    { personId: OMAR, displayName: 'Omar', avatar: null },
    { personId: NADIA, displayName: 'Nadia', avatar: null },
    { personId: RAFI, displayName: 'Rafi', avatar: null },
  ];
  h.addChannelMember.mockReset().mockResolvedValue({ added: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Members panel Join button, acceptance', () => {
  it('gives no button to a person already in the channel', async () => {
    await mount();
    expect(rowOf(NADIA)).toBeDefined();
    expect(buttonOf(NADIA)).toBeNull();
    expect(all('member-add')).toHaveLength(2);
  });

  it('gives the reader no Join button once they are in the channel; others keep Add', async () => {
    h.state.members = [{ personId: OMAR, displayName: 'Omar' }, { personId: NADIA, displayName: 'Nadia' }];
    await mount();
    expect(rowOf(OMAR)).toBeDefined();
    expect(buttonOf(OMAR)).toBeNull();
    expect(all('member-add').map((b) => b.textContent)).toEqual(['Add']);
    expect(all('member-add').some((b) => b.textContent === 'Join')).toBe(false);
  });

  it('gives no Join button to a guest, even one who could manage', async () => {
    h.state.guest = true;
    await mount();
    expect(all('member-add')).toHaveLength(0);
  });

  it('gives no Join button in an archived channel', async () => {
    h.state.archived = true;
    await mount();
    expect(all('member-add')).toHaveLength(0);
  });

  it('while Join runs, Rafi keeps Add, is aria-disabled and a click on it sends nothing', async () => {
    let done: (v: unknown) => void = () => undefined;
    h.addChannelMember.mockReturnValueOnce(new Promise((r) => (done = r)));
    await mount();
    click(buttonOf(OMAR)!);
    const rafi = buttonOf(RAFI)!;
    expect(rafi.textContent).toBe('Add');
    expect(rafi.getAttribute('aria-label')).toBe('Add Rafi to #dev');
    expect(rafi.getAttribute('aria-disabled')).toBe('true');
    click(rafi);
    expect(h.addChannelMember).toHaveBeenCalledTimes(1);
    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, OMAR);
    await act(async () => done({ added: true }));
    await settle();
  });

  it('while Rafi is being added, the reader\'s own row still says Join, aria-disabled', async () => {
    let done: (v: unknown) => void = () => undefined;
    h.addChannelMember.mockReturnValueOnce(new Promise((r) => (done = r)));
    await mount();
    click(buttonOf(RAFI)!);
    const mine = buttonOf(OMAR)!;
    expect(mine.textContent).toBe('Join');
    expect(mine.getAttribute('aria-label')).toBe('Join #dev');
    expect(mine.getAttribute('aria-disabled')).toBe('true');
    expect(buttonOf(RAFI)!.disabled).toBe(true);
    await act(async () => done({ added: true }));
    await settle();
  });

  it('after a failed join the row shows Join again, enabled, and stays outside the channel', async () => {
    h.addChannelMember.mockRejectedValueOnce(new Error('boom'));
    await mount();
    click(buttonOf(OMAR)!);
    await settle();
    const mine = buttonOf(OMAR)!;
    expect(mine).not.toBeNull();
    expect(mine.textContent).toBe('Join');
    expect(mine.disabled).toBe(false);
    expect(mine.getAttribute('aria-label')).toBe('Join #dev');
  });
});
