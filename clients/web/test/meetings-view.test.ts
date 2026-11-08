import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { MeetingTranscriptLine, SearchMeetingHit } from '@manythreads/shared';
import { Message } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { NotesBody } from '../src/screens/meetings/NotesCard';
import { TranscriptLines } from '../src/screens/meetings/TranscriptView';
import { MeetingHitRow, meetingHitHref, meetingHitWhere } from '../src/search/MeetingHitRow';
import { id } from './meetings-fixtures';

// P15-20 / P15-13: the notes and the transcript as a reader sees them, drawn from data the server would send (no browser, no server).

const noop = (): void => undefined;
const act = (over: Record<string, unknown> = {}) => ({ kind: 'action' as const, text: 'Send the budget', ownerName: 'Rafi' as string | null, ownerId: null, due: '2026-11-12' as string | null, atMs: 724_000, ...over });

const notesHtml = (notes: Parameters<typeof NotesBody>[0]['notes'], slug: string | null = 'eng', added: Record<string, string> = {}): string =>
  renderToStaticMarkup(createElement(NotesBody, { notes, meetingId: id(1), meetingTitle: 'Stand-up', slug, added, onAdded: noop, onJump: noop, teamSlug: slug }));

describe('the notes of a meeting', () => {
  const notes = {
    summary: 'We agreed the release date.',
    notesMd: '# Stand-up',
    items: [{ kind: 'decision' as const, text: 'Ship on Friday', ownerName: null, ownerId: null, due: null, atMs: 61_000 }, act(), act({ text: 'Write it up', ownerName: null, due: null, atMs: 900_000 }), { kind: 'question' as const, text: 'Who pays?', ownerName: null, ownerId: null, due: null, atMs: 1_200_000 }],
  };

  it('shows the summary and a heading with a count for decisions and for action items', () => {
    const html = notesHtml(notes);
    expect(html).toContain('We agreed the release date.');
    expect(html).toContain('Decisions 1');
    expect(html).toContain('Action items 2');
    expect(html).toContain('Open questions 1');
  });

  it('writes "No owner" for an action nobody owns, and the owner and day for one that has them', () => {
    const html = notesHtml(notes);
    expect(html).toContain('Rafi, by 12 Nov 2026');
    expect(html).toContain('No owner');
  });

  it('gives every action an Add to board button when the meeting has a team, with the time as a link to the transcript', () => {
    const html = notesHtml(notes);
    expect(html.match(/data-testid="action-to-board"/g)).toHaveLength(2);
    expect(html).toContain('12:04');
    expect(html.match(/data-testid="note-at"/g)).toHaveLength(4);
  });

  it('has no Add to board in a call that belongs to no team', () => {
    expect(notesHtml(notes, null)).not.toContain('action-to-board');
  });

  it('says which board an action was added to instead of offering the button again', () => {
    const key = `724000:Send the budget`;
    const html = notesHtml(notes, 'eng', { [key]: 'Delivery' });
    expect(html).toContain('Added to Delivery');
    expect(html.match(/data-testid="action-to-board"/g)).toHaveLength(1);
  });

  it('says so when no decisions or actions were noted', () => {
    const html = notesHtml({ summary: 'Short.', notesMd: '', items: [] });
    expect(html).toContain('Decisions 0');
    expect(html).toContain('No decisions were noted.');
    expect(html).toContain('No action items were noted.');
  });

  it('draws the notes file itself when it holds no list', () => {
    const html = notesHtml({ summary: '', notesMd: '## What we said\n\nA person wrote these notes.', items: [] });
    expect(html).toContain('data-testid="notes-markdown"');
    expect(html).toContain('A person wrote these notes.');
    expect(html).not.toContain('Decisions 0');
  });

  it('escapes the words of a note instead of drawing markup', () => {
    const html = notesHtml({ summary: '<img src=x onerror=alert(1)>', notesMd: '', items: [act({ text: '<script>alert(1)</script>' })] });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
});

describe('the transcript of a meeting', () => {
  const line = (over: Record<string, unknown> = {}): MeetingTranscriptLine =>
    ({ segmentId: id(10), speakerId: id(2), speakerName: 'Nadia', startMs: 1000, endMs: 4000, text: 'Good morning.', transcribed: true, editable: false, ...over }) as MeetingTranscriptLine;
  const lines = [
    line(),
    line({ segmentId: id(11), startMs: 5000, endMs: 9000, text: 'Shall we start?' }),
    line({ segmentId: null, speakerId: id(3), speakerName: 'Rafi', startMs: 10_000, endMs: 12_000, text: 'Rafi spoke (not transcribed)', transcribed: false }),
    line({ segmentId: id(12), speakerId: id(2), startMs: 3_723_000, endMs: 3_725_000, text: 'Last word.', editable: true }),
  ];
  const html = (mark: number | null): string => renderToStaticMarkup(createElement(TranscriptLines, { lines, mark, onMark: noop, meetingId: id(1) }));

  it('shows each speaker once above a run of their lines', () => {
    const out = html(null);
    expect(out.match(/data-testid="transcript-speaker"/g)).toHaveLength(3);
    expect(out).toContain('Good morning.');
    expect(out).toContain('Shall we start?');
  });

  it('shows the time of each line on the meeting clock', () => {
    const out = html(null);
    expect(out).toContain('>0:01<');
    expect(out).toContain('>1:02:03<');
  });

  it('draws a person who was not transcribed as a quiet line, with the server’s words', () => {
    const out = html(null);
    expect(out).toContain('Rafi spoke (not transcribed)');
    expect(out).toContain('mv-line  quiet');
  });

  it('marks the line the time falls in, and only that one', () => {
    const out = html(6000);
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toMatch(/mv-line hit[^>]*data-start-ms="5000"/);
    expect(html(null)).not.toContain('aria-current');
  });

  it('marks the first line for a time before the first one', () => {
    expect(html(0)).toMatch(/mv-line hit[^>]*data-start-ms="1000"/);
  });

  it('offers Edit only on a line the reader may still correct', () => {
    expect(html(null).match(/data-testid="line-edit-open"/g)).toHaveLength(1);
  });

  it('lets each line and speaker name choose their own direction, so Arabic and Bangla read right to left or as written', () => {
    const out = renderToStaticMarkup(createElement(TranscriptLines, { lines: [line({ speakerName: 'ندى', text: 'صباح الخير' }), line({ speakerName: 'রাফি', text: 'শুরু করি' })], mark: null, onMark: noop, meetingId: id(1) }));
    expect(out.match(/class="mv-line-text" dir="auto"/g)).toHaveLength(2);
    expect(out).toContain('data-testid="transcript-speaker" dir="auto"');
  });

  it('never draws markup from spoken words', () => {
    const hostile = renderToStaticMarkup(createElement(TranscriptLines, { lines: [line({ text: '<script>alert(1)</script> **bold**' })], mark: null, onMark: noop, meetingId: id(1) }));
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&lt;script&gt;');
  });
});

describe('a meeting in search results', () => {
  const hit = (over: Partial<SearchMeetingHit> = {}): SearchMeetingHit => ({
    meetingId: id(1) as SearchMeetingHit['meetingId'],
    title: 'Stand-up',
    channel: { id: id(5) as never, name: 'dev', kind: 'channel', teamId: id(8) as never },
    atMs: 724_000,
    speakerId: id(2) as never,
    speakerName: 'Nadia',
    snippet: 'we agreed the budget for the release',
    where: 'transcript',
    score: 0.8,
    startedAt: '2026-11-03T10:00:00.000Z',
    ...over,
  });

  it('opens the meeting at the line', () => {
    expect(meetingHitHref(hit())).toBe(`/meetings/${id(1)}?t=724000`);
  });
  it('opens the top of the meeting for a hit in the notes or at the very start', () => {
    expect(meetingHitHref(hit({ where: 'notes', atMs: 0 }))).toBe(`/meetings/${id(1)}`);
    expect(meetingHitHref(hit({ atMs: 0 }))).toBe(`/meetings/${id(1)}`);
  });
  it('says who spoke and when, or that the words are in the notes', () => {
    expect(meetingHitWhere(hit())).toBe('Nadia at 12:04');
    expect(meetingHitWhere(hit({ speakerName: null }))).toBe('Someone at 12:04');
    expect(meetingHitWhere(hit({ where: 'notes' }))).toBe('In the notes');
  });
  it('draws the channel, the title, who said it and the marked words', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MeetingHitRow, { hit: hit(), words: 'budget' })));
    expect(html).toContain('#dev');
    expect(html).toContain('Stand-up');
    expect(html).toContain('Nadia at 12:04');
    expect(html).toContain('<mark>budget</mark>');
  });
  it('calls a meeting with no channel by its own name', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MeetingHitRow, { hit: hit({ channel: null }), words: 'budget' })));
    expect(html).toContain('>Meeting<');
  });
});

describe('the note-taker’s message', () => {
  const base = { id: id(1), workspaceId: id(2), channelId: id(3), authorId: id(4), body: 'Your notes are ready.', bodyPlain: 'Your notes are ready.', threadRootId: null, editedAt: null, deletedAt: null, createdAt: '2026-11-03T10:00:00.000Z' };
  it('keeps meta.meetingNotes so the card can be drawn', () => {
    const m = Message.parse({ ...base, meta: { meetingNotes: { meetingId: id(200) } } });
    expect(m.meta.meetingNotes?.meetingId).toBe(id(200));
  });
  it('drops a meetingNotes value that does not read, never the message', () => {
    const m = Message.parse({ ...base, meta: { meetingNotes: { meetingId: 'not-an-id' } } });
    expect(m.meta.meetingNotes).toBeUndefined();
    expect(m.body).toBe('Your notes are ready.');
  });
  it('is absent on an ordinary message, so no card is drawn', () => {
    expect(Message.parse({ ...base, meta: {} }).meta.meetingNotes).toBeUndefined();
  });
});
