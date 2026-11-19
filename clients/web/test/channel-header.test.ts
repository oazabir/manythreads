// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, meeting, person, summary } from './meetings-fixtures';

// P33: the calmer channel header. The members panel (who is in, who is not, the filter, Add), the voice room card (Join, End room, nothing when not live) and the
// voice icon (start, scroll to the room's message, join straight away). The rules themselves (split, filter, which action) are plain functions; the rest renders the real components.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = id(100);
const OMAR = id(11);
const NADIA = id(12);
const RAFI = id(13);
const SAM = id(14);
const OMAR_ACTOR = id(1);

const h = vi.hoisted(() => {
  const state = {
    guest: false,
    canManage: true,
    archived: false,
    members: [] as { personId: string; displayName: string }[],
    roster: [] as { personId: string; displayName: string; avatar: string | null }[],
    live: undefined as unknown,
    rooms: [] as unknown[],
    call: { phase: 'idle', meeting: null as null | { id: string; channelId: string | null; startedBy: string } },
    selfActor: 'a-omar' as string | null,
    pushed: [] as { type: string; id: string }[],
  };
  return {
    state,
    addChannelMember: vi.fn(),
    endMeeting: vi.fn(),
    refresh: vi.fn(),
    start: vi.fn(),
    joinRoom: vi.fn(),
  };
});

vi.mock('../src/api/endpoints', () => ({
  fetchChannel: () => Promise.resolve({ channel: { id: CHANNEL, name: 'dev', archivedAt: h.state.archived ? '2026-11-01T00:00:00.000Z' : null }, isMember: true, canPost: true, canManage: h.state.canManage }),
  fetchChannelMembers: () => Promise.resolve({ members: h.state.members }),
  fetchRoster: () => Promise.resolve({ members: h.state.roster }),
  addChannelMember: (channelId: string, personId: string) => h.addChannelMember(channelId, personId),
}));
vi.mock('../src/shell/context', () => ({ useShell: () => ({ guest: h.state.guest, team: { slug: 'engineering' } }) }));
vi.mock('../src/channels/hooks', () => ({ usePeople: () => ({ me: { personId: OMAR } }) }));
vi.mock('../src/kernel/panel', () => ({ usePanel: () => ({ push: (e: { type: string; id: string }) => void h.state.pushed.push(e), top: () => null, close: () => undefined }) }));
vi.mock('../src/kernel/panel/sub', () => ({ usePanelTitle: () => undefined }));
vi.mock('../src/presence/PresenceDot', () => ({ PresenceDot: () => null }));
vi.mock('../src/api/setup', () => ({ isMockMode: () => false }));
vi.mock('../src/channels/store', () => ({ channelStore: { get selfActor() { return h.state.selfActor; } } }));
vi.mock('../src/meetings/api', () => ({ endMeeting: (meetingId: string) => h.endMeeting(meetingId) }));
vi.mock('../src/meetings/store', () => ({
  useRoomOfMessage: (messageId: string) => (h.state.live && (h.state.live as { meeting: { threadRootId: string | null } }).meeting.threadRootId === messageId ? h.state.live : undefined),
  useLiveRoom: () => h.state.live,
  useCall: () => h.state.call,
  callController: () => ({ start: h.start, joinRoom: h.joinRoom }),
  liveRooms: () => ({ refresh: h.refresh }),
}));

const { splitMembers, matchesFilter, canAddMembers } = await import('../src/shell/membersModel');
const { roomOfMessage, roomCardFacts, endQuestion, voiceIconAction } = await import('../src/meetings/roomCard');
const { MembersPanel } = await import('../src/shell/MembersPanel');
const { VoiceRoomCard } = await import('../src/meetings/VoiceRoomCard');
const { VoiceButton } = await import('../src/meetings/VoiceButton');

let host: HTMLDivElement;
let root: Root;
const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
const all = (testId: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (!el) throw new Error(`no ${testId}`);
  return el;
};
const settle = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: HTMLElement): void => void act(() => el.click());
const type = (el: HTMLInputElement, value: string): void =>
  void act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const names = (testId: string): string[] => all(testId).map((l) => [...l.querySelectorAll('.mpn-name')].map((n) => n.textContent ?? '')).flat();

beforeEach(() => {
  h.state.guest = false;
  h.state.canManage = true;
  h.state.archived = false;
  h.state.members = [
    { personId: OMAR, displayName: 'Omar' },
    { personId: NADIA, displayName: 'Nadia' },
  ];
  h.state.roster = [
    { personId: OMAR, displayName: 'Omar', avatar: null },
    { personId: NADIA, displayName: 'Nadia', avatar: null },
    { personId: RAFI, displayName: 'Rafi', avatar: null },
    { personId: SAM, displayName: 'Sam Lee', avatar: null },
  ];
  h.state.live = undefined;
  h.state.call = { phase: 'idle', meeting: null };
  h.state.selfActor = 'a-omar';
  h.state.pushed = [];
  h.addChannelMember.mockReset().mockResolvedValue({ added: true });
  h.endMeeting.mockReset().mockResolvedValue({ meeting: {} });
  h.refresh.mockReset().mockResolvedValue(undefined);
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

describe('the members rules', () => {
  const m = [{ personId: OMAR, displayName: 'Omar' }, { personId: NADIA, displayName: 'Nadia' }];
  const r = [...m, { personId: RAFI, displayName: 'Rafi' }, { personId: SAM, displayName: 'Sam Lee' }];
  it('splits the team into the channel and the rest, the reader first', () => {
    const s = splitMembers(m, r, '', OMAR);
    expect(s.inChannel.map((p) => p.displayName)).toEqual(['Omar', 'Nadia']);
    expect(s.others.map((p) => p.displayName)).toEqual(['Rafi', 'Sam Lee']);
  });
  it('filters both lists by words of the name, in any order, ignoring case and accents', () => {
    expect(splitMembers(m, r, 'NAD', OMAR)).toMatchObject({ inChannel: [{ displayName: 'Nadia' }], others: [] });
    expect(splitMembers(m, r, 'lee sam', OMAR).others.map((p) => p.displayName)).toEqual(['Sam Lee']);
    expect(matchesFilter('José Álvarez', 'jose alv')).toBe(true);
    expect(matchesFilter('Omar', '')).toBe(true);
  });
  it('counts a person added in the panel as a member at once', () => {
    const s = splitMembers(m, r, '', OMAR, [{ personId: RAFI, displayName: 'Rafi' }]);
    expect(s.inChannel.map((p) => p.displayName)).toEqual(['Omar', 'Nadia', 'Rafi']);
    expect(s.others.map((p) => p.displayName)).toEqual(['Sam Lee']);
  });
  it('offers Add to a manager only: never a guest, never in an archived channel', () => {
    expect(canAddMembers({ canManage: true, guest: false, archived: false })).toBe(true);
    expect(canAddMembers({ canManage: false, guest: false, archived: false })).toBe(false);
    expect(canAddMembers({ canManage: true, guest: true, archived: false })).toBe(false);
    expect(canAddMembers({ canManage: true, guest: false, archived: true })).toBe(false);
  });
});

describe('the Members panel', () => {
  const mount = async (): Promise<void> => {
    act(() => root.render(createElement(MembersPanel, { entry: { type: 'members', id: CHANNEL } })));
    await settle();
    await settle();
  };

  it('lists the channel and the team members who are not in it, each under its own heading with its count', async () => {
    await mount();
    expect(must('members-in-head').textContent).toBe('In this channel (2)');
    expect(must('members-out-head').textContent).toBe('Not in this channel (2)');
    expect(names('members-in')).toEqual(['Omar', 'Nadia']);
    expect(names('members-out')).toEqual(['Rafi', 'Sam Lee']);
    expect(must('members-in').textContent).toContain('(you)');
  });

  it('filters both lists as the reader types', async () => {
    await mount();
    type(must('members-filter') as HTMLInputElement, 'sa');
    expect(names('members-in')).toEqual([]);
    expect(names('members-out')).toEqual(['Sam Lee']);
    expect(must('members-in-head').textContent).toBe('In this channel (0)');
    expect(must('members-out-head').textContent).toBe('Not in this channel (1)');
  });

  it('has an Add on every person outside for a lead; pressing it adds them, moves the row up and says so', async () => {
    await mount();
    const rafi = all('member-row').find((r) => r.dataset['personId'] === RAFI)!;
    expect(all('member-add')).toHaveLength(2);
    click(rafi.querySelector<HTMLElement>('[data-testid="member-add"]')!);
    await settle();
    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, RAFI);
    expect(names('members-in')).toEqual(['Omar', 'Nadia', 'Rafi']);
    expect(names('members-out')).toEqual(['Sam Lee']);
    expect(must('members-said').textContent).toBe('Added Rafi to #dev');
    expect(all('member-add')).toHaveLength(1);
  });

  it('keeps the row outside and says so when the add fails', async () => {
    h.addChannelMember.mockRejectedValueOnce(new Error('no'));
    await mount();
    click(all('member-add')[0]!);
    await settle();
    expect(names('members-out')).toEqual(['Rafi', 'Sam Lee']);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not add Rafi. Try again.');
  });

  it('has no Add without the right to manage, and says who can add', async () => {
    h.state.canManage = false;
    await mount();
    expect(all('member-add')).toHaveLength(0);
    expect(must('members-no-add').textContent).toBe('A team lead can add people to this channel.');
    expect(names('members-out')).toEqual(['Rafi', 'Sam Lee']);
  });

  it('never offers Add to a guest, and shows a guest only the channel', async () => {
    h.state.guest = true;
    await mount();
    expect(all('member-add')).toHaveLength(0);
    expect(q('members-out-head')).toBeNull();
    expect(names('members-in')).toEqual(['Omar', 'Nadia']);
  });

  it('offers no Add in an archived channel', async () => {
    h.state.archived = true;
    await mount();
    expect(all('member-add')).toHaveLength(0);
  });

  it('opens a person in the panel when their row is pressed', async () => {
    await mount();
    click(all('member-row')[1]!.querySelector<HTMLElement>('.mpn-who')!);
    expect(h.state.pushed).toEqual([{ type: 'member', id: NADIA }]);
  });
});

describe('the voice room card', () => {
  const THREAD = id(300);
  const live = (startedBy = OMAR_ACTOR) => summary([person(id(1), 'Omar'), person(id(2), 'Nadia')], { startedBy: startedBy as never, channelId: CHANNEL as never });
  const mount = (messageId = THREAD): void => void act(() => root.render(createElement(VoiceRoomCard, { messageId, channelId: CHANNEL })));

  it('picks the live room a message started, and nothing for another message or an ended room', () => {
    const room = live();
    expect(roomOfMessage([room], THREAD)).toBe(room);
    expect(roomOfMessage([room], id(301))).toBeUndefined();
    expect(roomOfMessage([{ ...room, meeting: meeting({ state: 'ended' }) }], THREAD)).toBeUndefined();
    expect(roomOfMessage([{ ...room, meeting: meeting({ threadRootId: null }) }], THREAD)).toBeUndefined();
  });

  it('says who is in the room and who may end it', () => {
    const room = live(id(2));
    expect(roomCardFacts(room, id(2), null)).toMatchObject({ countText: '2 in the room', canEnd: true, inRoom: false });
    expect(roomCardFacts(room, id(1), null).canEnd).toBe(false);
    expect(roomCardFacts(room, id(2), room.meeting.id).inRoom).toBe(true);
    expect(endQuestion(3)).toBe('End the voice room for everyone? The 3 people in it will leave.');
  });

  it('shows Join while the room is live, and joining goes to that room', () => {
    h.state.live = live('someone-else');
    mount();
    expect(must('room-card').textContent).toContain('Voice room · 10:00');
    expect(must('room-card-count').textContent).toContain('2 in the room');
    click(must('room-card-join'));
    expect(h.joinRoom).toHaveBeenCalledWith(meeting().id, CHANNEL);
  });

  it('shows End room to the person who started it only', () => {
    h.state.live = live('someone-else');
    mount();
    expect(q('room-card-end')).toBeNull();
    h.state.live = live('a-omar');
    mount();
    expect(q('room-card-end')).not.toBeNull();
    expect(q('room-card-join')).not.toBeNull();
  });

  it('draws nothing when no room is live, or for a message that started none', () => {
    mount();
    expect(q('room-card')).toBeNull();
    h.state.live = live('a-omar');
    mount(id(999));
    expect(q('room-card')).toBeNull();
    expect(host.innerHTML).toBe('');
  });

  it('says "You are in this room" instead of offering Join when the reader is in it', () => {
    h.state.live = live('a-omar');
    h.state.call = { phase: 'connected', meeting: { id: meeting().id, channelId: CHANNEL, startedBy: 'a-omar' } };
    mount();
    expect(must('room-card-in').textContent).toContain('You are in this room');
    expect(q('room-card-join')).toBeNull();
  });

  it('asks once before ending, and calls the end route only on the second press', async () => {
    h.state.live = live('a-omar');
    mount();
    click(must('room-card-end'));
    expect(h.endMeeting).not.toHaveBeenCalled();
    expect(must('room-end-confirm').textContent).toContain('End the voice room for everyone? The 2 people in it will leave.');
    expect(q('room-card-join')).toBeNull();
    click(must('room-end-confirm-yes'));
    await settle();
    expect(h.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.endMeeting).toHaveBeenCalledWith(meeting().id);
    expect(h.refresh).toHaveBeenCalled();
  });

  it('Cancel puts the buttons back and ends nothing', () => {
    h.state.live = live('a-omar');
    mount();
    click(must('room-card-end'));
    click(must('room-end-confirm-no'));
    expect(h.endMeeting).not.toHaveBeenCalled();
    expect(q('room-end-confirm')).toBeNull();
    expect(q('room-card-end')).not.toBeNull();
  });
});

describe('the voice icon', () => {
  const THREAD = id(300);
  const room = (): unknown => summary([person(id(2), 'Nadia')], { channelId: CHANNEL as never });
  const mount = (props: { dm?: boolean; loaded?: boolean }): { shown: string[] } => {
    const shown: string[] = [];
    act(() =>
      root.render(createElement(VoiceButton, { channelId: CHANNEL, dm: props.dm ?? false, messageLoaded: () => props.loaded ?? true, showMessage: (m: string) => void shown.push(m) })),
    );
    return { shown };
  };

  it('picks its action from the room and where the message is', () => {
    expect(voiceIconAction({ live: false, dm: false, messageLoaded: true })).toBe('start');
    expect(voiceIconAction({ live: true, dm: false, messageLoaded: true })).toBe('show-message');
    expect(voiceIconAction({ live: true, dm: false, messageLoaded: false })).toBe('join');
    expect(voiceIconAction({ live: true, dm: true, messageLoaded: true })).toBe('join');
  });

  it('starts a room when none is live, and has no live dot', () => {
    const { shown } = mount({});
    const btn = must('call-start');
    expect(btn.getAttribute('aria-label')).toBe('Start a voice room');
    expect(btn.querySelector('.chv-live-dot')).toBeNull();
    click(btn);
    expect(h.start).toHaveBeenCalledWith(CHANNEL);
    expect(shown).toEqual([]);
  });

  it('scrolls to the start message when a room is live in a channel, and does not join', () => {
    h.state.live = room();
    const { shown } = mount({});
    const btn = must('call-start');
    expect(btn.getAttribute('aria-label')).toBe('A voice room is live: join it from its message');
    expect(btn.querySelector('.chv-live-dot')).not.toBeNull();
    click(btn);
    expect(shown).toEqual([THREAD]);
    expect(h.joinRoom).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('joins directly when the start message is not in the list', () => {
    h.state.live = room();
    const { shown } = mount({ loaded: false });
    expect(must('call-start').getAttribute('aria-label')).toBe('Join the voice room');
    click(must('call-start'));
    expect(h.joinRoom).toHaveBeenCalledWith(meeting().id, CHANNEL);
    expect(shown).toEqual([]);
  });

  it('joins directly in a direct message, with no message to hunt for', () => {
    h.state.live = room();
    const { shown } = mount({ dm: true });
    expect(must('call-start').getAttribute('aria-label')).toBe('Join the call');
    click(must('call-start'));
    expect(h.joinRoom).toHaveBeenCalledWith(meeting().id, CHANNEL);
    expect(shown).toEqual([]);
  });

  it('is a state, not a button, while the reader is in the room', () => {
    h.state.live = room();
    h.state.call = { phase: 'connected', meeting: { id: meeting().id, channelId: CHANNEL, startedBy: 'a-omar' } };
    mount({});
    expect(q('call-start')).toBeNull();
    expect(must('call-in-here').textContent).toContain('In the voice room');
  });
});
