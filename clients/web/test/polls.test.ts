import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelMessage, PollView } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import {
  EMPTY_FORM,
  canAddOption,
  canRemoveOption,
  closedByClock,
  closesAtOf,
  closesIn,
  filledOptions,
  formFromPrefill,
  oneLine,
  optionPercent,
  pollFailureText,
  pollStatus,
  requestOf,
  toggled,
  withServerPoll,
  withTotals,
  withVote,
} from '../src/channels/polls';
import { ChannelStore, channelKey } from '../src/channels/store';
import { planSlash, type SlashWho } from '../src/channels/slash';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CH = uuid(900);
const WS = uuid(901);
const ME = uuid(1);
const THEM = uuid(2);
const NOW = new Date('2026-11-01T10:00:00.000Z');

function poll(over: Partial<PollView> = {}): PollView {
  return {
    id: uuid(500),
    question: 'Lunch?',
    options: [{ text: 'Pizza', votes: 2 }, { text: 'Sushi', votes: 1 }, { text: 'Soup', votes: 0 }],
    anonymous: false,
    multiple: false,
    closesAt: null,
    closed: false,
    closedAt: null,
    voters: 3,
    version: 5,
    mine: [],
    resultMessageId: null,
    ...over,
  } as PollView;
}
function pollMessage(over: Partial<PollView> = {}): ChannelMessage {
  return {
    id: uuid(501),
    workspaceId: WS,
    channelId: CH,
    authorId: THEM,
    body: 'Poll: Lunch?',
    bodyPlain: 'Poll: Lunch?',
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt: '2026-11-01T09:00:00.000Z',
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    poll: poll(over),
  } as unknown as ChannelMessage;
}

describe('the poll form', () => {
  it('turns "closes in N unit" into an exact moment, or never', () => {
    expect(closesAtOf({ closeUnit: 'never', closeAmount: '5' }, NOW)).toEqual({ ok: true, at: null });
    expect(closesAtOf({ closeUnit: 'minutes', closeAmount: '30' }, NOW)).toEqual({ ok: true, at: '2026-11-01T10:30:15.000Z' });
    expect(closesAtOf({ closeUnit: 'hours', closeAmount: '2' }, NOW)).toEqual({ ok: true, at: '2026-11-01T12:00:15.000Z' });
    expect(closesAtOf({ closeUnit: 'days', closeAmount: '1' }, NOW)).toEqual({ ok: true, at: '2026-11-02T10:00:15.000Z' });
  });
  it('refuses an amount that is not a whole number of at least 1, and more than a year', () => {
    for (const amount of ['', '0', '-3', '1.5', 'abc', '12345678']) expect(closesAtOf({ closeUnit: 'hours', closeAmount: amount }, NOW)).toMatchObject({ ok: false });
    expect(closesAtOf({ closeUnit: 'days', closeAmount: '400' }, NOW)).toMatchObject({ ok: false, reason: 'A poll can stay open at most a year.' });
  });
  it('drops empty option boxes and trims the rest; builds the request or says what to fix', () => {
    expect(filledOptions([' Pizza ', '', '  ', 'Sushi'])).toEqual(['Pizza', 'Sushi']);
    const ok = requestOf({ ...EMPTY_FORM, question: ' Lunch? ', options: ['Pizza', '', 'Sushi'], multiple: true, anonymous: true, closeUnit: 'hours', closeAmount: '1' }, NOW, uuid(7));
    expect(ok).toMatchObject({ ok: true, request: { question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: true, anonymous: true, closesAt: '2026-11-01T11:00:15.000Z', threadRootId: uuid(7) } });
    expect(requestOf({ ...EMPTY_FORM, question: '', options: ['A', 'B'] }, NOW, null)).toMatchObject({ ok: false, reason: 'Write the question' });
    expect(requestOf({ ...EMPTY_FORM, question: 'Q', options: ['A', ''] }, NOW, null)).toMatchObject({ ok: false, reason: 'A poll needs at least 2 options' });
    expect(requestOf({ ...EMPTY_FORM, question: 'Q', options: ['A', 'a'] }, NOW, null)).toMatchObject({ ok: false, reason: 'Two options are the same' });
    expect(requestOf({ ...EMPTY_FORM, question: 'Q', options: ['A', 'B'], closeUnit: 'minutes', closeAmount: 'x' }, NOW, null)).toMatchObject({ ok: false });
  });
  it('one minute is still a minute away when the request arrives; the server wants at least one', () => {
    const r = closesAtOf({ closeUnit: 'minutes', closeAmount: '1' }, NOW);
    expect(r).toMatchObject({ ok: true });
    expect(Date.parse((r as { at: string }).at) - NOW.getTime()).toBeGreaterThanOrEqual(60_000);
  });
  it('line breaks and control characters become spaces before anything is sent; the schema refuses what is left', () => {
    expect(oneLine('  Where\n do   we\teat?  ')).toBe('Where do we eat?');
    const ok = requestOf({ ...EMPTY_FORM, question: 'Where\nto eat?', options: ['Pizza\n2', 'Sushi'] }, NOW, null);
    expect(ok).toMatchObject({ ok: true, request: { question: 'Where to eat?', options: ['Pizza 2', 'Sushi'] } });
    expect(requestOf({ ...EMPTY_FORM, question: 'Q', options: ['A\u0007', 'B'] }, NOW, null)).toMatchObject({ ok: true, request: { options: ['A', 'B'] } });
  });
  it('two options that differ only in spaces or capitals are the same, like the database says', () => {
    expect(requestOf({ ...EMPTY_FORM, question: 'Q', options: ['Pizza  slice', 'pizza slice'] }, NOW, null)).toMatchObject({ ok: false, reason: 'Two options are the same' });
  });
  it('a half-typed /poll opens the form with what was typed, topped up to two boxes', () => {
    expect(formFromPrefill({ question: 'Lunch?', options: [] })).toEqual({ question: 'Lunch?', options: ['', ''] });
    expect(formFromPrefill({ question: 'Lunch?', options: ['Pizza'] })).toEqual({ question: 'Lunch?', options: ['Pizza', ''] });
  });
  it('keeps two to ten boxes', () => {
    expect(canRemoveOption(['', ''])).toBe(false);
    expect(canRemoveOption(['', '', ''])).toBe(true);
    expect(canAddOption(Array.from({ length: 9 }, () => ''))).toBe(true);
    expect(canAddOption(Array.from({ length: 10 }, () => ''))).toBe(false);
  });
});

describe('a vote on the page', () => {
  it('single choice: the vote moves from one option to another and the voter count stays', () => {
    const first = withVote(poll(), [0]);
    expect(first).toMatchObject({ mine: [0], voters: 4 });
    expect(first.options.map((o) => o.votes)).toEqual([3, 1, 0]);
    const moved = withVote(first, [1]);
    expect(moved).toMatchObject({ mine: [1], voters: 4 });
    expect(moved.options.map((o) => o.votes)).toEqual([2, 2, 0]);
    const gone = withVote(moved, []);
    expect(gone).toMatchObject({ mine: [], voters: 3 });
    expect(gone.options.map((o) => o.votes)).toEqual([2, 1, 0]);
  });
  it('single choice never counts two options; several choices count each once', () => {
    expect(withVote(poll(), [0, 1]).mine).toEqual([0]);
    const many = withVote(poll({ multiple: true }), [2, 0, 0]);
    expect(many.mine).toEqual([0, 2]);
    expect(many.voters).toBe(4);
    expect(many.options.map((o) => o.votes)).toEqual([3, 1, 1]);
  });
  it('an option that does not exist is ignored; counts never go below zero', () => {
    expect(withVote(poll(), [7]).mine).toEqual([]);
    expect(withVote(poll({ options: [{ text: 'A', votes: 0 }, { text: 'B', votes: 0 }], voters: 0, mine: [0] }), []).options.map((o) => o.votes)).toEqual([0, 0]);
  });
  it('pressing an option: single choice picks it; several choices flip it', () => {
    expect(toggled({ multiple: false, mine: [1] }, 2)).toEqual([2]);
    expect(toggled({ multiple: true, mine: [1] }, 2)).toEqual([1, 2]);
    expect(toggled({ multiple: true, mine: [1, 2] }, 1)).toEqual([2]);
    expect(toggled({ multiple: true, mine: [2] }, 2)).toEqual([]);
  });
  it('a push of totals keeps the reader’s own vote and the question', () => {
    const next = withTotals(poll({ mine: [1] }), { votes: [5, 4], voters: 9, version: 6, closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(9) as PollView['resultMessageId'] });
    expect(next.mine).toEqual([1]);
    expect(next.options.map((o) => o.votes)).toEqual([5, 4, 0]);
    expect(next).toMatchObject({ voters: 9, version: 6, closed: true, question: 'Lunch?' });
  });
  it('a push older than the poll held changes nothing; an equal or newer one is taken', () => {
    const totals = { votes: [9, 9, 9], voters: 27, closed: false, closedAt: null, resultMessageId: null };
    const held = poll({ version: 5 });
    expect(withTotals(held, { ...totals, version: 4 })).toBe(held);
    expect(withTotals(held, { ...totals, version: 5 })).toMatchObject({ voters: 27, version: 5 });
    expect(withTotals(held, { ...totals, version: 8 })).toMatchObject({ voters: 27, version: 8 });
  });
  it('a late closed:false push never reopens a closed poll', () => {
    const closed = poll({ closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(9) as PollView['resultMessageId'], version: 5 });
    const after = withTotals(closed, { votes: [2, 1, 0], voters: 3, version: 6, closed: false, closedAt: null, resultMessageId: null });
    expect(after).toMatchObject({ closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(9) });
    expect(withServerPoll(closed, poll({ closed: false, version: 7 }))).toMatchObject({ closed: true, version: 7 });
  });
  it('an answer older than the poll held is not taken either', () => {
    const held = poll({ version: 7, voters: 10 });
    expect(withServerPoll(held, poll({ version: 6, voters: 1 }))).toBe(held);
    expect(withServerPoll(held, poll({ version: 7, voters: 11 })).voters).toBe(11);
  });
  it('the clock closes a poll at its closing time, before the server records it', () => {
    const timed = poll({ closesAt: '2026-11-01T10:05:00.000Z' });
    expect(closedByClock(timed, new Date('2026-11-01T10:04:59.000Z')).closed).toBe(false);
    expect(closedByClock(timed, new Date('2026-11-01T10:05:00.000Z')).closed).toBe(true);
    expect(closedByClock(poll(), new Date('2030-01-01T00:00:00.000Z')).closed).toBe(false);
  });
  it('shares are whole percents of the voters; words for status and distance', () => {
    expect(optionPercent(poll(), 1)).toBe(33);
    expect(optionPercent(poll({ voters: 0 }), 0)).toBe(0);
    expect(pollStatus(poll({ anonymous: true, multiple: true }), NOW)).toBe('Anonymous · choose one or more');
    expect(pollStatus(poll({ closed: true }), NOW)).toBe('Public votes · choose one · closed');
    expect(pollStatus(poll({ closesAt: '2026-11-01T12:00:00.000Z' }), NOW)).toBe('Public votes · choose one · closes in 2 hours');
    expect(closesIn('2026-11-01T10:00:20.000Z', NOW)).toBe('in under a minute');
    expect(closesIn('2026-11-01T10:05:00.000Z', NOW)).toBe('in 5 minutes');
    expect(closesIn('2026-11-04T10:00:00.000Z', NOW)).toBe('in 3 days');
  });
  it('says why a vote was refused in plain words', () => {
    expect(pollFailureText(409, 'This poll is closed')).toBe('This poll is closed');
    expect(pollFailureText(404, undefined)).toContain('could not be found');
    expect(pollFailureText(500, 'boom')).toBe('That did not go through. Try again in a moment.');
  });
});

describe('/poll in the composer', () => {
  const who: SlashWho = { guest: false, teamMember: true, teamArchived: false, bots: [], selfName: 'Omar' };
  it('alone opens the form; with pieces asks the poll; a mistake stays in the box with a sentence', () => {
    expect(planSlash('/poll', who)).toEqual({ do: 'poll', question: null, options: [] });
    expect(planSlash('/poll "Lunch?" "Pizza" "Sushi"', who)).toEqual({ do: 'poll', question: 'Lunch?', options: ['Pizza', 'Sushi'] });
    expect(planSlash('/poll Lunch? Pizza', who)).toMatchObject({ do: 'say' });
    expect(planSlash('/poll "Q" "A" "a"', who)).toMatchObject({ do: 'say', message: 'Two options are the same.' });
  });
  it('a question with fewer than two options opens the form with those pieces filled in (nothing is lost, nothing is posted)', () => {
    expect(planSlash('/poll "Lunch?" "Pizza"', who)).toEqual({ do: 'poll', question: null, options: [], prefill: { question: 'Lunch?', options: ['Pizza'] } });
    expect(planSlash('/poll "Lunch?"', who)).toMatchObject({ do: 'poll', prefill: { question: 'Lunch?', options: [] } });
  });
  it('is open to a guest, and does not run with files attached', () => {
    expect(planSlash('/poll', { ...who, guest: true, teamMember: false })).toMatchObject({ do: 'poll' });
    expect(planSlash('/poll "Q" "A" "B"', who, true)).toMatchObject({ do: 'say', message: expect.stringContaining('/poll') });
  });
});

type Handler = (req: TransportRequest) => { status: number; body: unknown };
function serve(handler: Handler): TransportRequest[] {
  const seen: TransportRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    return handler(req);
  });
  return seen;
}

describe('polls in the channel store', () => {
  let store: ChannelStore;
  beforeEach(() => {
    store = new ChannelStore();
    store.setSelf(ME);
  });
  const load = async (m: ChannelMessage): Promise<void> => {
    serve(() => ({ status: 200, body: { items: [m], nextCursor: null } }));
    await store.loadChannel(CH);
  };
  const held = (): PollView | undefined => store.get(channelKey(CH)).items[0]?.poll;

  it('a poll.changed push moves the counts and keeps the reader’s own vote', async () => {
    const m = pollMessage({ mine: [0] });
    await load(m);
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { channelId: CH, messageId: m.id, pollId: m.poll!.id, votes: [4, 2, 1], voters: 7, version: 6, closed: false, closedAt: null, resultMessageId: null } });
    expect(held()).toMatchObject({ voters: 7, mine: [0] });
    expect(held()?.options.map((o) => o.votes)).toEqual([4, 2, 1]);
  });
  it('a push for another poll, or with a junk payload, changes nothing', async () => {
    const m = pollMessage();
    await load(m);
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { channelId: CH, messageId: m.id, pollId: uuid(777), votes: [9, 9, 9], voters: 9, version: 6, closed: false, closedAt: null, resultMessageId: null } });
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { nonsense: true } });
    expect(held()?.voters).toBe(3);
  });
  it('a closing push shows the closed state with the result message', async () => {
    const m = pollMessage();
    await load(m);
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { channelId: CH, messageId: m.id, pollId: m.poll!.id, votes: [2, 1, 0], voters: 3, version: 6, closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(600) } });
    expect(held()).toMatchObject({ closed: true, resultMessageId: uuid(600) });
  });
  it('voting shows the vote at once and settles with the server’s answer', async () => {
    const m = pollMessage();
    await load(m);
    const settled = poll({ mine: [1], voters: 4, options: [{ text: 'Pizza', votes: 2 }, { text: 'Sushi', votes: 2 }, { text: 'Soup', votes: 0 }] });
    const seen = serve(() => ({ status: 200, body: { poll: settled } }));
    const pending = store.vote(CH, null, m.id, m.poll!, [1]);
    expect(held()).toMatchObject({ mine: [1], voters: 4 });
    await pending;
    expect(seen[0]).toMatchObject({ method: 'PUT' });
    expect(seen[0]?.url).toBe(`/api/channels/${CH}/polls/${m.poll!.id}/vote`);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ options: [1] });
    expect(held()).toEqual(settled);
  });
  it('an empty choice withdraws the vote (DELETE)', async () => {
    const m = pollMessage({ mine: [1], voters: 3 });
    await load(m);
    const seen = serve(() => ({ status: 200, body: { poll: poll({ voters: 2 }) } }));
    await store.vote(CH, null, m.id, m.poll!, []);
    expect(seen[0]).toMatchObject({ method: 'DELETE' });
    expect(held()).toMatchObject({ mine: [], voters: 2 });
  });
  it('a refused vote puts the poll back and tells the caller', async () => {
    const m = pollMessage();
    await load(m);
    serve(() => ({ status: 409, body: { error: { code: 'conflict', message: 'This poll is closed' } } }));
    await expect(store.vote(CH, null, m.id, m.poll!, [0])).rejects.toMatchObject({ status: 409 });
    expect(held()).toEqual(m.poll);
  });
  it('a refused vote reads the poll again instead of restoring an old copy (a push moved the totals meanwhile)', async () => {
    const m = pollMessage();
    await load(m);
    const now = poll({ version: 9, voters: 8, options: [{ text: 'Pizza', votes: 5 }, { text: 'Sushi', votes: 3 }, { text: 'Soup', votes: 0 }] });
    const seen = serve((req) =>
      req.method === 'PUT'
        ? { status: 409, body: { error: { code: 'conflict', message: 'This poll is closed' } } }
        : { status: 200, body: { poll: now, voters: [] } },
    );
    await expect(store.vote(CH, null, m.id, m.poll!, [0])).rejects.toMatchObject({ status: 409 });
    expect(seen.map((r) => r.method)).toEqual(['PUT', 'GET']);
    expect(held()).toEqual(now);
  });
  it('pushes that arrive out of order: the older one is dropped, the newer stays', async () => {
    const m = pollMessage({ version: 5 });
    await load(m);
    const push = (version: number, votes: number[], voters: number) =>
      store.handlePush({ type: 'poll.changed', id: 'p', payload: { channelId: CH, messageId: m.id, pollId: m.poll!.id, votes, voters, version, closed: false, closedAt: null, resultMessageId: null } });
    push(8, [6, 2, 0], 8);
    push(7, [5, 2, 0], 7);
    push(6, [3, 1, 0], 4);
    expect(held()).toMatchObject({ voters: 8, version: 8 });
    expect(held()?.options.map((o) => o.votes)).toEqual([6, 2, 0]);
  });
  it('a stale open push after the close push does not reopen the poll', async () => {
    const m = pollMessage({ version: 5 });
    await load(m);
    const base = { channelId: CH, messageId: m.id, pollId: m.poll!.id, votes: [2, 1, 0], voters: 3, resultMessageId: null };
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { ...base, version: 7, closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(600) } });
    store.handlePush({ type: 'poll.changed', id: 'p', payload: { ...base, version: 6, closed: false, closedAt: null } });
    expect(held()).toMatchObject({ closed: true, version: 7, resultMessageId: uuid(600) });
  });
  it('closing early takes the closed poll from the answer', async () => {
    const m = pollMessage();
    await load(m);
    const closed = poll({ closed: true, closedAt: '2026-11-01T10:00:00.000Z', resultMessageId: uuid(601) as PollView['resultMessageId'] });
    const seen = serve(() => ({ status: 200, body: { poll: closed } }));
    await store.closePoll(CH, null, m.id, m.poll!.id);
    expect(seen[0]?.url).toBe(`/api/channels/${CH}/polls/${m.poll!.id}/close`);
    expect(held()).toEqual(closed);
  });
  it('creating a poll puts the new message, with its poll, in the channel once even when its push also arrives', async () => {
    serve(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    await store.loadChannel(CH);
    const created = pollMessage({ mine: [] });
    serve(() => ({ status: 201, body: created }));
    await store.createPoll(CH, { question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: false, anonymous: false });
    store.handlePush({ type: 'message.posted', id: 'x', payload: { channelId: CH, messageId: created.id, threadRootId: null } });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get(channelKey(CH)).items.map((m) => m.id)).toEqual([created.id]);
    expect(held()?.question).toBe('Lunch?');
  });
});
