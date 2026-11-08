import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  actionFailure,
  actionsOf,
  boardCardOf,
  channelChoices,
  clockWords,
  decisionsOf,
  dueWords,
  granteeWords,
  headingWithCount,
  isConflict,
  itemKey,
  lengthWords,
  lineAt,
  liveShares,
  meetingFolderPath,
  ownerLine,
  parseJump,
  tabFor,
  peopleWords,
  personChoices,
  questionsOf,
  readFailure,
  readsOrganizerCopy,
  runsOf,
  showsMarkdownOnly,
} from '../src/screens/meetings/words';

// P15-20 / P15-22 / P15-23: the plain rules of the meeting page, with no browser.

const err = (status: number, message: string, code: ApiError['code'] = 'conflict') => new ApiError({ code, status, message });
const item = (over: Partial<Parameters<typeof ownerLine>[0] & { kind: 'decision' | 'action' | 'question'; text: string; atMs: number; ownerId: null }> = {}) => ({
  kind: 'action' as const,
  text: 'Send the budget',
  ownerName: 'Rafi' as string | null,
  ownerId: null,
  due: '2026-11-12' as string | null,
  atMs: 724_000,
  ...over,
});

describe('times and lengths', () => {
  it('reads the meeting clock as minutes and seconds, and hours once past one', () => {
    expect(clockWords(0)).toBe('0:00');
    expect(clockWords(724_000)).toBe('12:04');
    expect(clockWords(3_723_000)).toBe('1:02:03');
    expect(clockWords(-5)).toBe('0:00');
  });
  it('says how long a meeting ran', () => {
    expect(lengthWords(null)).toBe('Still going');
    expect(lengthWords(20)).toBe('Under a minute');
    expect(lengthWords(25 * 60)).toBe('25 min');
    expect(lengthWords(60 * 60)).toBe('1 h');
    expect(lengthWords(95 * 60)).toBe('1 h 35 min');
  });
  it('counts people', () => {
    expect(peopleWords(1)).toBe('1 person');
    expect(peopleWords(4)).toBe('4 people');
  });
});

describe('the jump to a line (?t=)', () => {
  it('takes a whole number of milliseconds and nothing else', () => {
    expect(parseJump('0')).toBe(0);
    expect(parseJump('724000')).toBe(724_000);
    expect(parseJump(null)).toBeNull();
    for (const bad of ['', '-1', '1.5', '12s', '1e3', 'abc', '99999999999999']) expect(parseJump(bad)).toBeNull();
  });
  it('shows the transcript when the address points at a moment, also when it changes while the page is open', () => {
    expect(tabFor(null, 'notes')).toBe('notes');
    expect(tabFor(null, 'transcript')).toBe('transcript');
    expect(tabFor(0, 'notes')).toBe('transcript');
    expect(tabFor(724_000, 'notes')).toBe('transcript');
  });

  it('lands on the last line that starts at or before the time, or the first line', () => {
    const lines = [{ startMs: 1000 }, { startMs: 5000 }, { startMs: 9000 }];
    expect(lineAt(lines, 5000)).toBe(1);
    expect(lineAt(lines, 8999)).toBe(1);
    expect(lineAt(lines, 99_999)).toBe(2);
    expect(lineAt(lines, 0)).toBe(0);
    expect(lineAt([], 5)).toBe(-1);
  });
  it('keeps a speaker’s consecutive lines in one block', () => {
    const lines = [{ speakerId: 'a' }, { speakerId: 'a' }, { speakerId: 'b' }, { speakerId: 'a' }];
    const runs = runsOf(lines);
    expect(runs.map((r) => [r.speakerId, r.lines.map((l) => l.index)])).toEqual([['a', [0, 1]], ['b', [2]], ['a', [3]]]);
    expect(runsOf([])).toEqual([]);
  });
});

describe('which transcript a person reads', () => {
  const you = (isOrganizer: boolean) => ({ isOrganizer, canManage: false, canReadNotes: true });
  it('a person the notes were shared with reads the organizer’s copy of a note-taker meeting', () => {
    expect(readsOrganizerCopy({ location: 'personal', you: you(false) })).toBe(true);
  });
  it('the organizer and every other place read the room’s own transcript', () => {
    expect(readsOrganizerCopy({ location: 'personal', you: you(true) })).toBe(false);
    expect(readsOrganizerCopy({ location: 'repo', you: you(false) })).toBe(false);
    expect(readsOrganizerCopy({ location: 'channel_files', you: you(false) })).toBe(false);
    expect(readsOrganizerCopy({ location: null, you: you(false) })).toBe(false);
  });
});

describe('notes: items, owners and cards', () => {
  const all = [item({ kind: 'decision', text: 'Ship on Friday', ownerName: null, due: null }), item(), item({ text: 'Write it up', ownerName: null, due: null }), item({ kind: 'question', text: 'Who pays?' })];
  it('sorts items by kind and counts them in the heading', () => {
    expect(decisionsOf(all)).toHaveLength(1);
    expect(actionsOf(all)).toHaveLength(2);
    expect(questionsOf(all)).toHaveLength(1);
    expect(headingWithCount('Action items', 2)).toBe('Action items 2');
  });
  it('says who an action is for, and writes "No owner" when nobody was named', () => {
    expect(ownerLine({ ownerName: 'Rafi', due: '2026-11-12' })).toBe('Rafi, by 12 Nov 2026');
    expect(ownerLine({ ownerName: 'Rafi', due: null })).toBe('Rafi');
    expect(ownerLine({ ownerName: null, due: null })).toBe('No owner');
    expect(ownerLine({ ownerName: null, due: '2026-01-05' })).toBe('No owner, by 5 Jan 2026');
    expect(dueWords('nonsense')).toBe('nonsense');
  });
  it('prefills a board card with the words, where it came from, the owner and the day', () => {
    const card = boardCardOf(item(), 'Stand-up');
    expect(card.title).toBe('Send the budget');
    expect(card.description).toContain('“Stand-up”');
    expect(card.description).toContain('12:04');
    expect(card.description).toContain('Owner: Rafi');
    expect(card.description).toContain('Due: 2026-11-12');
    const bare = boardCardOf(item({ ownerName: null, due: null }), 'Stand-up');
    expect(bare.description).toContain('Owner: no owner');
    expect(bare.description).not.toContain('Due:');
  });
  it('cuts a long title to what a card may hold', () => {
    expect(boardCardOf(item({ text: 'x'.repeat(500) }), 't').title).toHaveLength(200);
  });
  it('tells apart two items by their words and their time', () => {
    expect(itemKey(item())).not.toBe(itemKey(item({ atMs: 1 })));
    expect(itemKey(item())).not.toBe(itemKey(item({ text: 'Other' })));
  });
  it('draws the markdown file only when it holds no list', () => {
    expect(showsMarkdownOnly({ summary: '', items: [], notesMd: '# Notes' })).toBe(true);
    expect(showsMarkdownOnly({ summary: 'Short', items: [], notesMd: '# Notes' })).toBe(false);
    expect(showsMarkdownOnly({ summary: '', items: [item()], notesMd: '# Notes' })).toBe(false);
    expect(showsMarkdownOnly({ summary: '', items: [], notesMd: '  ' })).toBe(false);
  });
});

describe('plain failures', () => {
  it('a missing or forbidden meeting reads the same way to the reader', () => {
    expect(readFailure(err(404, 'x', 'not_found'))).toMatch(/not available/);
    expect(readFailure(err(403, 'x', 'forbidden'))).toMatch(/do not have access/);
    expect(readFailure(err(0, 'x', 'network'))).toMatch(/Could not reach the server/);
    expect(readFailure(err(501, 'Not built yet', 'internal'))).toMatch(/not available on this server yet/);
    expect(readFailure(new Error('boom'))).toMatch(/Try again/);
  });
  it('an action failure keeps the server’s own sentence for a refusal and a plain fallback otherwise', () => {
    expect(actionFailure(err(409, 'Already saved.'), 'fallback')).toBe('Already saved.');
    expect(actionFailure(err(403, 'x', 'forbidden'), 'fallback')).toMatch(/permission/);
    expect(actionFailure(err(500, 'stack trace', 'internal'), 'fallback')).toBe('fallback');
    expect(actionFailure(new Error('boom'), 'fallback')).toBe('fallback');
  });
  it('knows a conflict', () => {
    expect(isConflict(err(409, 'x'))).toBe(true);
    expect(isConflict(err(404, 'x', 'not_found'))).toBe(false);
    expect(isConflict(new Error('x'))).toBe(false);
  });
});

describe('the Files hook: which folders may belong to a meeting', () => {
  it('a team repo meeting folder is meetings/<year>/<month>/<folder>, or a file in it', () => {
    expect(meetingFolderPath('meetings/2026/11/08-1402-stand-up', false)).toBe('meetings/2026/11/08-1402-stand-up');
    expect(meetingFolderPath('meetings/2026/11/08-1402-stand-up/notes.md', false)).toBe('meetings/2026/11/08-1402-stand-up/notes.md');
    expect(meetingFolderPath('meetings', false)).toBeNull();
    expect(meetingFolderPath('meetings/2026', false)).toBeNull();
    expect(meetingFolderPath('meetings/2026/11', false)).toBeNull();
  });
  it('a private channel keeps its meetings under channels/<name>/meetings/', () => {
    expect(meetingFolderPath('channels/secret/meetings/08-1402-stand-up', false)).not.toBeNull();
    expect(meetingFolderPath('channels/secret/meetings', false)).toBeNull();
    expect(meetingFolderPath('channels/secret/notes/08-1402-stand-up/x', false)).toBeNull();
  });
  it('a Personal meeting folder is Meetings/<folder>', () => {
    expect(meetingFolderPath('Meetings/2026-11-08-1402-stand-up', true)).toBe('Meetings/2026-11-08-1402-stand-up');
    expect(meetingFolderPath('Meetings/2026-11-08-1402-stand-up/transcript.md', true)).not.toBeNull();
    expect(meetingFolderPath('Meetings', true)).toBeNull();
    expect(meetingFolderPath('Meetings/2026-11-08-1402-stand-up', false)).toBeNull();
    expect(meetingFolderPath('pages/Meetings/x', true)).toBeNull();
  });
  it('a path that is no place for a meeting asks nothing', () => {
    for (const p of ['', 'pages/notes.md', 'bots/scribe/BOT.md', 'inbox']) {
      expect(meetingFolderPath(p, false)).toBeNull();
      expect(meetingFolderPath(p, true)).toBeNull();
    }
  });
});

describe('sharing', () => {
  const person = (id: string, name: string, revokedAt: string | null = null) => ({ id: `s-${id}`, revokedAt, grantee: { kind: 'person' as const, personId: id, displayName: name } });
  const channel = (id: string, name: string | null, revokedAt: string | null = null) => ({ id: `s-${id}`, revokedAt, grantee: { kind: 'channel' as const, channelId: id, channelName: name } });
  it('shows only the shares still in force', () => {
    expect(liveShares([person('a', 'Ana'), person('b', 'Bo', '2026-11-01T00:00:00Z')]).map((s) => s.id)).toEqual(['s-a']);
  });
  it('names who a share is for', () => {
    expect(granteeWords(person('a', 'Ana').grantee)).toBe('Ana');
    expect(granteeWords(channel('c', 'dev').grantee)).toBe('# dev');
    expect(granteeWords(channel('c', null).grantee)).toBe('A channel');
  });
  it('offers nobody twice, and never the person sharing', () => {
    const everyone = [{ personId: 'me' }, { personId: 'a' }, { personId: 'b' }];
    expect(personChoices(everyone, [person('a', 'Ana')], 'me').map((p) => p.personId)).toEqual(['b']);
    // a taken-back share frees the person to be picked again
    expect(personChoices(everyone, [person('a', 'Ana', '2026-11-01T00:00:00Z')], 'me').map((p) => p.personId)).toEqual(['a', 'b']);
  });
  it('offers a channel once', () => {
    expect(channelChoices([{ id: 'c1' }, { id: 'c2' }], [channel('c1', 'dev')]).map((c) => c.id)).toEqual(['c2']);
  });
});
