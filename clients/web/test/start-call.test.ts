// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCard, CallStartOptionsResponse } from '@manythreads/shared';
import { ApiError, setTransport, type TransportRequest } from '../src/api/client';

// P15-25 / P15-27 (calls-card plan, step S6): the start dialog, the people checklist both dialogs share (with the schedule dialog), Invite more on the live
// card, the invitation's line in the inbox. The rules are plain functions; the dialogs render for real against a stand-in server (the transport).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CHANNEL = uuid(100);
const CALL = uuid(200);
const OMAR = uuid(11);
const NADIA = uuid(12);
const RAFI = uuid(13);
const SAM = uuid(14);
const BOT = uuid(50);
const BOT2 = uuid(51);

const h = vi.hoisted(() => ({
  startFromDialog: vi.fn(),
  joinRoom: vi.fn(),
  call: { phase: 'idle', meeting: null as null | { id: string } },
}));

vi.mock('../src/api/setup', () => ({ isMockMode: () => false }));
vi.mock('../src/channels/hooks', () => ({ usePeople: () => ({ me: { personId: OMAR, actorId: uuid(1) }, byActor: () => undefined }) }));
vi.mock('../src/meetings/store', () => ({
  callController: () => ({ startFromDialog: h.startFromDialog, joinRoom: h.joinRoom, endForAll: vi.fn() }),
  liveRooms: () => ({ refresh: () => Promise.resolve(), snapshot: () => ({ rooms: [] }) }),
  useCall: () => h.call,
  useRoomOfMessage: () => undefined,
}));

const { filterPeople, matchLine, capLine, selectShown, selectAllLabel, togglePerson, tooManyLine } = await import('../src/meetings/people');
const { CallBusyError } = await import('../src/meetings/controller');
const { buildStartBody, callButtonWords, checklistPeople, dialogFailure, invitedLine, isNotetakerRefusal, notetakerChoice } = await import('../src/meetings/startCall');
const { PeopleChecklist } = await import('../src/meetings/PeopleChecklist');
const { StartCallDialog } = await import('../src/meetings/StartCallDialog');
const { CallCardBody } = await import('../src/meetings/VoiceRoomCard');
const { callCardFacts } = await import('../src/meetings/roomCard');
const { callCards } = await import('../src/meetings/callCards');
const { notificationTitle } = await import('../src/notifications/store');
const { inviteTarget, isLiveCall } = await import('../src/notifications/model');
const { messageLocation } = await import('../src/shell/messageLink');

const bot = (botId: string, name: string) => ({ botId, slug: name.toLowerCase(), name, role: 'Note-taker', avatar: null }) as unknown as CallStartOptionsResponse['notetaker']['bots'][number];

function options(over: Record<string, unknown> = {}): CallStartOptionsResponse {
  return {
    canStart: true,
    reason: null,
    directMessage: false,
    defaultTitle: 'Call · #dev · 14:02',
    live: null,
    people: [
      { personId: OMAR, displayName: 'Omar', you: true },
      { personId: NADIA, displayName: 'Nadia', you: false },
      { personId: RAFI, displayName: 'Rafi', you: false },
      { personId: SAM, displayName: 'Sam Lee', you: false },
    ],
    peopleTotal: 4,
    notetaker: { bots: [bot(BOT, 'Scribe')], defaultBotId: BOT, available: true, reason: null },
    guestLinks: { available: false, reason: 'Guest links are not available yet' },
    ...over,
  } as unknown as CallStartOptionsResponse;
}

let host: HTMLDivElement;
let root: Root;
let asked: TransportRequest[] = [];
let answer: (req: TransportRequest) => { status: number; body: unknown } = () => ({ status: 200, body: options() });

beforeEach(() => {
  asked = [];
  answer = () => ({ status: 200, body: options() });
  setTransport(async (req) => {
    asked.push(req);
    return answer(req);
  });
  callCards().reset();
  h.startFromDialog.mockReset().mockResolvedValue({ created: true });
  h.joinRoom.mockReset().mockResolvedValue(undefined);
  h.call = { phase: 'idle', meeting: null };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
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
const boxOf = (list: string, name: string): HTMLInputElement => {
  const label = [...must(list).querySelectorAll('label')].find((l) => l.textContent?.includes(name));
  if (!label) throw new Error(`no ${name} in ${list}`);
  return label.querySelector('input')!;
};
const names = (list: string): string[] => [...must(list).querySelectorAll('label')].map((l) => l.textContent ?? '');

describe('the people checklist rules', () => {
  const people = [{ personId: OMAR, displayName: 'Omar (you)', locked: true }, { personId: NADIA, displayName: 'Nadia' }, { personId: RAFI, displayName: 'Rafi' }];

  it('filters by the name in any case and says how many match', () => {
    expect(filterPeople(people, 'NAD').map((p) => p.personId)).toEqual([NADIA]);
    expect(filterPeople(people, '  ')).toHaveLength(3);
    expect(matchLine('', 3, 3)).toBeNull();
    expect(matchLine('a', 2, 12)).toBe('2 of 12 match');
    expect(matchLine('zz', 0, 12)).toBe('Nobody matches');
    expect(matchLine('a', 1200, 1240)).toBe('1,200 of 1,240 match');
  });

  it('says when the server cut the list short', () => {
    expect(capLine(200, 1240)).toBe('Showing 200 of 1,240 — type to search');
    expect(capLine(12, 12)).toBeNull();
  });

  it('selects all the shown people, and clears them when all are ticked, never changing a locked one', () => {
    expect(selectShown([OMAR], people).next).toEqual([OMAR, NADIA, RAFI]);
    expect(selectShown([OMAR, NADIA, RAFI], people).next).toEqual([OMAR]);
    expect(selectShown([], [people[1]!]).next).toEqual([NADIA]);
  });

  it('ticks only as many as fit under the limit, and says some were left out', () => {
    const lots = Array.from({ length: 5 }, (_, i) => ({ personId: uuid(600 + i), displayName: `P${i}` }));
    expect(selectShown([uuid(600)], lots, 3)).toEqual({ next: [uuid(600), uuid(601), uuid(602)], capped: true });
    expect(selectShown([], lots, 10)).toEqual({ next: lots.map((p) => p.personId), capped: false });
    expect(tooManyLine(100)).toBe('At most 100 people can be invited to one call');
    expect(selectAllLabel([], people)).toBe('Select all');
    expect(selectAllLabel([NADIA, RAFI], people)).toBe('Clear all');
    expect(selectAllLabel([], [people[0]!, people[1]!])).toBeNull();
    expect(togglePerson([], people[0]!)).toEqual([]);
    expect(togglePerson([], people[1]!)).toEqual([NADIA]);
    expect(togglePerson([NADIA], people[1]!)).toEqual([]);
  });
});

describe('the start dialog rules', () => {
  it('names the header button "Audio call", "Join call" while live, and explains why a guest cannot start one', () => {
    expect(callButtonWords({ live: false, guest: false, dm: false })).toEqual({ label: 'Audio call', title: 'Audio call: start a call here', blocked: null });
    expect(callButtonWords({ live: true, guest: true, dm: false }).label).toBe('Join call');
    expect(callButtonWords({ live: false, guest: true, dm: false }).blocked).toBe('Guests cannot start a call here');
  });

  it('puts the caller first, ticked and locked', () => {
    expect(checklistPeople(options().people)[0]).toEqual({ personId: OMAR, displayName: 'Omar (you)', locked: true });
    expect(checklistPeople(options().people)[1]).toEqual({ personId: NADIA, displayName: 'Nadia' });
  });

  it('builds the start body: the typed title, invitees but never the caller and never in a direct message, the note-taker only when on', () => {
    expect(buildStartBody({ title: '  ', picked: [], lockedIds: [OMAR], dm: false, notetakerBotId: null })).toEqual({});
    expect(buildStartBody({ title: ' Design review ', picked: [OMAR, NADIA], lockedIds: [OMAR], dm: false, notetakerBotId: BOT })).toEqual({ title: 'Design review', inviteeIds: [NADIA], notetakerBotId: BOT });
    expect(buildStartBody({ title: 'x', picked: [NADIA], lockedIds: [], dm: true, notetakerBotId: null })).toEqual({ title: 'x' });
    expect(buildStartBody({ title: 'a'.repeat(200), picked: [], lockedIds: [], dm: false, notetakerBotId: null }).title).toHaveLength(120);
  });

  it('offers the note-taker only when one may come, with the server\'s reason otherwise', () => {
    expect(notetakerChoice(options().notetaker)).toEqual({ offered: true, defaultBotId: BOT, reason: null });
    expect(notetakerChoice({ bots: [bot(BOT, 'Scribe')], defaultBotId: null, available: false, reason: 'The note-taker is busy, try again in a minute.' } as never)).toEqual({ offered: false, defaultBotId: null, reason: 'The note-taker is busy, try again in a minute.' });
    expect(notetakerChoice({ bots: [], defaultBotId: null, available: true, reason: null }).offered).toBe(false);
  });

  it('knows a note-taker refusal from another one, and words a failure', () => {
    expect(isNotetakerRefusal('Note-takers are switched off for this team. A team lead can allow them in the team’s TEAM.md.')).toBe(true);
    expect(isNotetakerRefusal('Transcription on the server is not set up. Ask a workspace admin to connect a speech model.')).toBe(true);
    expect(isNotetakerRefusal('You cannot invite these people to this call.')).toBe(false);
    expect(dialogFailure(new ApiError({ code: 'forbidden', status: 403, message: 'You cannot invite these people to this call.' }), 'x')).toBe('You cannot invite these people to this call.');
    expect(dialogFailure(new ApiError({ code: 'network', status: 0, message: 'boom' }), 'x')).toBe('Could not reach the server. Check your connection and try again.');
    expect(dialogFailure(new Error('boom'), 'Try again.')).toBe('Try again.');
    expect(dialogFailure(new CallBusyError('A call is still connecting. Wait for it, then try again.'), 'x')).toBe('A call is still connecting. Wait for it, then try again.');
    const local = dialogFailure(new ApiError({ code: 'validation_failed', status: 0, message: 'Too big: expected array to have <=100 items' }), 'The call could not start. Try again.');
    expect(local).toContain('could not be sent');
    expect(local).not.toContain('Try again');
  });

  it('writes the invited names of a card, the first three and a count', () => {
    expect(invitedLine({ count: 0, names: [] })).toBeNull();
    expect(invitedLine({ count: 2, names: ['Nadia', 'Rafi'] })).toBe('Invited: Nadia, Rafi');
    expect(invitedLine({ count: 5, names: ['Nadia', 'Rafi', 'Sam', 'Lena', 'Omar'] })).toBe('Invited: Nadia, Rafi, Sam +2');
  });
});

describe('the people checklist', () => {
  function Host({ people, server }: { people: Parameters<typeof PeopleChecklist>[0]['people']; server?: { matching: number; total: number } }) {
    const [picked, setPicked] = useState<string[]>([]);
    const [find, setFind] = useState('');
    return createElement(PeopleChecklist, { label: 'Invite people', people, picked, onChange: setPicked, find, onFind: setFind, server, emptyText: 'Nobody', testId: 'ppl', findTestId: 'ppl-find' });
  }
  const many = Array.from({ length: 8 }, (_, i) => ({ personId: uuid(500 + i), displayName: i % 2 === 0 ? `Nadia ${i}` : `Rafi ${i}` }));

  it('filters as the reader types and says "4 of 9 match" in a status line', () => {
    act(() => root.render(createElement(Host, { people: [{ personId: OMAR, displayName: 'Omar (you)', locked: true }, ...many] })));
    const status = must('ppl-count');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    type(must('ppl-find') as HTMLInputElement, 'nadia');
    expect(names('ppl')).toEqual(['Nadia 0', 'Nadia 2', 'Nadia 4', 'Nadia 6']);
    expect(status.textContent).toBe('4 of 9 match');
  });

  it('keeps the caller ticked and not changeable', () => {
    act(() => root.render(createElement(Host, { people: [{ personId: OMAR, displayName: 'Omar (you)', locked: true }, { personId: NADIA, displayName: 'Nadia' }] })));
    const me = boxOf('ppl', 'Omar');
    expect(me.checked).toBe(true);
    expect(me.disabled).toBe(true);
    // two rows, one of them locked: nothing for Select all to do
    expect(q('ppl-all')).toBeNull();
  });

  it('selects all the people shown (only those the filter shows), then clears them', () => {
    act(() => root.render(createElement(Host, { people: many })));
    type(must('ppl-find') as HTMLInputElement, 'rafi');
    expect(must('ppl-all').textContent).toBe('Select all');
    click(must('ppl-all'));
    expect([...must('ppl').querySelectorAll('input')].every((i) => i.checked)).toBe(true);
    expect(must('ppl-all').textContent).toBe('Clear all');
    type(must('ppl-find') as HTMLInputElement, '');
    expect(boxOf('ppl', 'Nadia 0').checked).toBe(false);
    expect(boxOf('ppl', 'Rafi 1').checked).toBe(true);
  });

  it('says when the server sent only part of the list, and counts what the server matched', () => {
    act(() => root.render(createElement(Host, { people: many, server: { matching: 1240, total: 1240 } })));
    expect(must('ppl-cap').textContent).toBe('Showing 8 of 1,240 — type to search');
    type(must('ppl-find') as HTMLInputElement, 'zzz');
    // the list is what the server sent: it is not filtered again here
    expect(names('ppl')).toHaveLength(8);
    expect(must('ppl-count').textContent).toBe('1,240 of 1,240 match');
  });
});

describe('the start dialog', () => {
  const open = async (): Promise<{ closed: number }> => {
    const out = { closed: 0 };
    act(() => root.render(createElement(StartCallDialog, { channelId: CHANNEL, onClose: () => void (out.closed += 1) })));
    await settle();
    await settle();
    return out;
  };

  it('opens on the title, filled in with the server\'s default, the caller ticked and locked, the note-taker on naming the bot', async () => {
    await open();
    expect(asked[0]?.url).toBe(`/api/channels/${CHANNEL}/calls/options`);
    const title = must('call-start-title') as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect(title.value).toBe('Call · #dev · 14:02');
    expect(title.maxLength).toBe(120);
    expect(boxOf('call-start-people', 'Omar (you)').disabled).toBe(true);
    expect(must('call-start-notetaker').getAttribute('aria-checked')).toBe('true');
    expect(must('call-start-notetaker-name').textContent).toBe('Note-taker: Scribe');
    expect(must('call-start-dialog').textContent).toContain('Everyone is asked before their voice is written down');
    const guests = must('call-start-guests');
    expect(guests.getAttribute('aria-checked')).toBe('false');
    expect(guests.getAttribute('aria-disabled')).toBe('true');
    expect(must('call-start-dialog').textContent).toContain('Guest links are not available yet');
    expect(must('call-start-dialog').classList.contains('sheet')).toBe(true);
  });

  it('starts the call with the title, the people ticked and the note-taker, and closes', async () => {
    const out = await open();
    type(must('call-start-title') as HTMLInputElement, 'Design review');
    click(boxOf('call-start-people', 'Nadia'));
    click(boxOf('call-start-people', 'Rafi'));
    expect(must('call-start-asking').textContent).toBe('2 invited. They get a notification.');
    click(must('call-start-submit'));
    await settle();
    expect(h.startFromDialog).toHaveBeenCalledWith(CHANNEL, { title: 'Design review', inviteeIds: [NADIA, RAFI], notetakerBotId: BOT });
    expect(out.closed).toBe(1);
  });

  it('sends no note-taker when its switch is turned off, and picks among several bots', async () => {
    answer = () => ({ status: 200, body: options({ notetaker: { bots: [bot(BOT, 'Scribe'), bot(BOT2, 'Archivist')], defaultBotId: BOT, available: true, reason: null } }) });
    await open();
    const select = must('call-start-notetaker-bot') as HTMLSelectElement;
    act(() => {
      select.value = BOT2;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(must('call-start-submit'));
    await settle();
    expect(h.startFromDialog).toHaveBeenLastCalledWith(CHANNEL, { title: 'Call · #dev · 14:02', notetakerBotId: BOT2 });
    h.startFromDialog.mockResolvedValue(null);
    click(must('call-start-notetaker'));
    click(must('call-start-submit'));
    await settle();
    expect(h.startFromDialog).toHaveBeenLastCalledWith(CHANNEL, { title: 'Call · #dev · 14:02' });
  });

  it('keeps a refusal inside the dialog; one about the note-taker turns its switch off with the reason', async () => {
    const out = await open();
    h.startFromDialog.mockRejectedValueOnce(new ApiError({ code: 'conflict', status: 409, message: 'The note-taker is busy, try again in a minute.' }));
    click(must('call-start-submit'));
    await settle();
    expect(out.closed).toBe(0);
    expect(must('call-start-error').textContent).toBe('The note-taker is busy, try again in a minute.');
    expect(must('call-start-notetaker').getAttribute('aria-checked')).toBe('false');
    expect(must('call-start-notetaker').getAttribute('aria-disabled')).toBe('true');
    h.startFromDialog.mockRejectedValueOnce(new ApiError({ code: 'forbidden', status: 403, message: 'You cannot invite these people to this call.' }));
    click(must('call-start-submit'));
    await settle();
    expect(h.startFromDialog).toHaveBeenLastCalledWith(CHANNEL, { title: 'Call · #dev · 14:02' });
    expect(must('call-start-error').textContent).toBe('You cannot invite these people to this call.');
  });

  it('has the note-taker off with the server\'s reason when none may come', async () => {
    answer = () => ({ status: 200, body: options({ notetaker: { bots: [bot(BOT, 'Scribe')], defaultBotId: BOT, available: false, reason: 'Note-takers are switched off for this workspace. A workspace admin can allow them.' } }) });
    await open();
    expect(must('call-start-notetaker').getAttribute('aria-checked')).toBe('false');
    expect(must('call-start-dialog').textContent).toContain('Note-takers are switched off for this workspace.');
    click(must('call-start-notetaker'));
    expect(must('call-start-notetaker').getAttribute('aria-checked')).toBe('false');
  });

  it('lists nobody in a direct message: everyone in it is rung', async () => {
    answer = () => ({ status: 200, body: options({ directMessage: true, defaultTitle: 'Call · 14:02' }) });
    await open();
    expect(must('call-start-dm').textContent).toBe('Everyone in this conversation is rung');
    expect(q('call-start-people')).toBeNull();
    click(must('call-start-submit'));
    await settle();
    expect(h.startFromDialog).toHaveBeenCalledWith(CHANNEL, { title: 'Call · 14:02', notetakerBotId: BOT });
  });

  it('says why a person cannot start a call, with only Close', async () => {
    answer = () => ({ status: 200, body: options({ canStart: false, reason: 'Guests cannot start a call here', people: [] }) });
    await open();
    expect(must('call-start-blocked').textContent).toBe('Guests cannot start a call here');
    expect(q('call-start-submit')).toBeNull();
    expect(document.activeElement).toBe(must('call-start-close'));
  });

  it('says so when a call was already going and the start joined it', async () => {
    h.startFromDialog.mockResolvedValue({ created: false });
    const out = await open();
    click(must('call-start-submit'));
    await settle();
    expect(out.closed).toBe(0);
    expect(must('call-start-joined').textContent).toContain('A call was already going: you joined it. Nobody was invited — use Invite more on its card.');
    expect(must('call-start-joined').textContent).toContain('The note-taker choice was not used.');
    expect(document.activeElement).toBe(must('call-start-close'));
  });

  it('asks the server for the people that match once the list was cut short, after a pause', async () => {
    const lots = options({ people: [{ personId: OMAR, displayName: 'Omar', you: true }, { personId: NADIA, displayName: 'Nadia', you: false }], peopleTotal: 1240 });
    answer = (req) =>
      req.url.includes('q=')
        ? { status: 200, body: options({ people: [{ personId: OMAR, displayName: 'Omar', you: true }, { personId: RAFI, displayName: 'Rafi', you: false }], peopleTotal: 3 }) }
        : { status: 200, body: lots };
    await open();
    expect(must('call-start-people-cap').textContent).toBe('Showing 2 of 1,240 — type to search');
    type(must('call-start-find') as HTMLInputElement, 'ra');
    type(must('call-start-find') as HTMLInputElement, 'raf');
    await act(async () => void (await new Promise((r) => setTimeout(r, 320))));
    const searches = asked.filter((r) => r.url.includes('q='));
    expect(searches.map((r) => r.url)).toEqual([`/api/channels/${CHANNEL}/calls/options?q=raf`]);
    expect(names('call-start-people')).toEqual(['Omar (you)', 'Rafi']);
    expect(must('call-start-people-count').textContent).toBe('3 of 1,240 match');
  });

  it('shows "Searching…" and nobody while the server search for what is typed is out, then a plain failure that the next key retries', async () => {
    const lots = options({ people: [{ personId: OMAR, displayName: 'Omar', you: true }, { personId: NADIA, displayName: 'Nadia', you: false }], peopleTotal: 1240 });
    let fail = true;
    answer = (req) =>
      req.url.includes('q=')
        ? fail
          ? { status: 429, body: { error: { code: 'rate_limited', message: 'Slow down' } } }
          : { status: 200, body: options({ people: [{ personId: OMAR, displayName: 'Omar', you: true }, { personId: RAFI, displayName: 'Rafi', you: false }], peopleTotal: 2 }) }
        : { status: 200, body: lots };
    await open();
    type(must('call-start-find') as HTMLInputElement, 'raf');
    // before the answer: the earlier list is not shown, and Select all waits
    expect(names('call-start-people')).toEqual([]);
    expect(must('call-start-people-count').textContent).toBe('Searching…');
    await act(async () => void (await new Promise((r) => setTimeout(r, 320))));
    expect(names('call-start-people')).toEqual([]);
    expect(must('call-start-people-count').textContent).toBe('Too many searches in a short time. Wait a moment, then type again to retry.');
    fail = false;
    type(must('call-start-find') as HTMLInputElement, 'rafi');
    await act(async () => void (await new Promise((r) => setTimeout(r, 320))));
    expect(names('call-start-people')).toEqual(['Omar (you)', 'Rafi']);
  });

  it('never asks more than 100 people: Select all stops there and says why', async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({ personId: uuid(1000 + i), displayName: `Person ${i}`, you: false }));
    answer = () => ({ status: 200, body: options({ people: [{ personId: OMAR, displayName: 'Omar', you: true }, ...many], peopleTotal: 106 }) });
    await open();
    click(must('call-start-people-all'));
    expect(must('call-start-people-max').textContent).toBe('At most 100 people can be invited to one call');
    expect(must('call-start-asking').textContent).toBe('100 invited. They get a notification.');
    expect((must('call-start-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Start call with the reason when more than 100 are ticked by hand', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ personId: uuid(1000 + i), displayName: `Person ${i}`, you: false }));
    answer = () => ({ status: 200, body: options({ people: many, peopleTotal: 101 }) });
    await open();
    for (const box of [...must('call-start-people').querySelectorAll<HTMLInputElement>('input')]) click(box);
    const submit = must('call-start-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe('At most 100 people can be invited to one call');
    expect(must('call-start-people-max')).toBeTruthy();
  });

  it('shows a busy refusal from the call in the dialog instead of closing', async () => {
    const out = await open();
    h.startFromDialog.mockRejectedValueOnce(new CallBusyError('A call is still connecting. Wait for it, then try again.'));
    click(must('call-start-submit'));
    await settle();
    expect(out.closed).toBe(0);
    expect(must('call-start-error').textContent).toBe('A call is still connecting. Wait for it, then try again.');
  });

  it('puts the keyboard on Join call when the options say a call is already going', async () => {
    answer = () => ({ status: 200, body: options({ live: { meetingId: CALL, title: 'Design review' } }) });
    await open();
    expect(must('call-start-live').textContent).toContain('Design review');
    expect(document.activeElement).toBe(must('call-start-join'));
    click(must('call-start-join'));
    expect(h.joinRoom).toHaveBeenCalledWith(CALL, CHANNEL);
  });

  it('says so when the person is in another call, which is left only once this one opens', async () => {
    h.call = { phase: 'connected', meeting: { id: uuid(900), channelId: uuid(901) } as never };
    await open();
    expect(must('call-start-elsewhere').textContent).toBe('You are in another call. You leave it once this one has opened.');
  });

  it('cancels with Esc and starts nothing', async () => {
    const out = await open();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(out.closed).toBe(1);
    expect(h.startFromDialog).not.toHaveBeenCalled();
  });
});

describe('Invite more on a live call card', () => {
  const live: CallCard = {
    meetingId: CALL,
    kind: 'audio',
    title: 'Design review',
    state: 'live',
    startedBy: uuid(2),
    starterName: 'Nadia',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    durationSeconds: null,
    present: [],
    presentCount: 0,
    joinedCount: 1,
    invited: { count: 4, names: ['Nadia', 'Rafi', 'Sam', 'Lena'] },
    notetaker: null,
    you: { joined: false, canEnd: false, canInvite: true },
    notesLink: null,
  } as unknown as CallCard;
  const draw = (card: CallCard): void =>
    act(() => root.render(createElement(MemoryRouter, null, createElement(CallCardBody, { card, channelId: CHANNEL, freshen: () => Promise.resolve(), endedHere: () => undefined }))));

  it('shows who was invited and offers Invite more to whoever may post', () => {
    draw(live);
    expect(must('room-card-invited').textContent).toBe('Invited: Nadia, Rafi, Sam +1');
    expect(must('room-card-invite').textContent).toBe('Invite more');
    expect(callCardFacts(live, { selfActor: null, joinedMeetingId: null }).canInvite).toBe(true);
    expect(callCardFacts({ ...live, state: 'ended' } as CallCard, { selfActor: null, joinedMeetingId: null }).canInvite).toBe(false);
  });

  it('offers no Invite more to a reader who may not post, and no line when nobody was invited', () => {
    draw({ ...live, invited: { count: 0, names: [] }, you: { joined: false, canEnd: false, canInvite: false } } as CallCard);
    expect(q('room-card-invite')).toBeNull();
    expect(q('room-card-invited')).toBeNull();
  });

  it('asks the people ticked, the caller left out, then asks for the card again; the click never joins the call', async () => {
    answer = (req) => {
      if (req.url.endsWith('/invites')) return { status: 200, body: { invited: [SAM] } };
      if (req.url.startsWith('/api/meetings/cards')) return { status: 200, body: { cards: [live] } };
      return { status: 200, body: options() };
    };
    draw(live);
    const btn = must('room-card-invite');
    act(() => btn.focus());
    click(btn);
    await settle();
    expect(must('call-invite-dialog')).toBeTruthy();
    expect(names('call-invite-people')).toEqual(['Nadia', 'Rafi', 'Sam Lee']);
    expect((must('call-invite-submit') as HTMLButtonElement).disabled).toBe(true);
    click(boxOf('call-invite-people', 'Sam'));
    expect(h.joinRoom).not.toHaveBeenCalled();
    click(must('call-invite-submit'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
    const post = asked.find((r) => r.url.endsWith('/invites'));
    expect(post?.url).toBe(`/api/meetings/${CALL}/invites`);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ personIds: [SAM] });
    expect(asked.some((r) => r.url.startsWith('/api/meetings/cards'))).toBe(true);
    expect(q('call-invite-dialog')).toBeNull();
    expect(document.activeElement).toBe(must('room-card-invite'));
    expect(h.joinRoom).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the reason when the server refuses', async () => {
    answer = (req) => (req.url.endsWith('/invites') ? { status: 403, body: { error: { code: 'forbidden', message: 'You cannot invite these people to this call.' } } } : { status: 200, body: options() });
    draw(live);
    click(must('room-card-invite'));
    await settle();
    click(boxOf('call-invite-people', 'Rafi'));
    click(must('call-invite-submit'));
    await settle();
    expect(must('call-invite-error').textContent).toBe('You cannot invite these people to this call.');
  });
});

describe('an invitation in the inbox', () => {
  it('says who invited the person, and opens the start message rather than the call id', () => {
    expect(notificationTitle({ kind: 'meeting_invite', actorName: 'Nadia', channelName: 'dev' })).toBe('Nadia invited you to a call in #dev');
    expect(notificationTitle({ kind: 'meeting_invite', actorName: 'Nadia', channelName: null })).toBe('Nadia invited you to a call');
    const root = uuid(700);
    expect(inviteTarget({ kind: 'meeting_invite', refType: 'meeting_invite', threadRootId: root as never })).toBe(root);
    expect(inviteTarget({ kind: 'mention', refType: 'message', threadRootId: root as never })).toBeNull();
  });

  it('offers Join only for a call still in the live list, and opens the channel when the invitation names no start message', () => {
    expect(isLiveCall([{ meeting: { id: CALL, state: 'live' } }], CALL)).toBe(true);
    expect(isLiveCall([{ meeting: { id: CALL, state: 'ended' } }], CALL)).toBe(false);
    expect(isLiveCall([], CALL)).toBe(false);
    expect(messageLocation('engineering', { channelId: CHANNEL, channelKind: 'channel', channelName: 'dev', messageId: '', threadRootId: null, channelOnly: true })).toEqual({ pathname: '/t/engineering/c/dev', search: '', state: null });
  });
});
