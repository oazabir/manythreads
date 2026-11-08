import type { MeetingNoteItem, MeetingNotesDraft } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { readAutoMemory, renderMemoryItem, sendWarning } from '../src/memory.ts';
import { actionOwnerIds, buildNoteItems, escapeMarkdown, ownerDirectory, renderNotesMarkdown, threadBody, transcriptForModel } from '../src/notes.ts';

// The checks the platform makes on the Scribe's answer (PLAN P15-10, decision C7), and the text it writes from it. No database: the whole run is in notes.test.ts.

const NADIA = '00000000-0000-7000-8000-0000000d0002';
const RAFI = '00000000-0000-7000-8000-0000000d0003';
const OMAR = '00000000-0000-7000-8000-0000000d0001';
const person = (actorId: string, displayName: string, consent: 'yes' | 'no' | 'unset' = 'yes') => ({ actorId, displayName, consent }) as never;
const lines = [
  { startMs: 0, endMs: 2000, transcribed: true },
  { startMs: 5000, endMs: 7000, transcribed: true },
  { startMs: 9000, endMs: 9500, transcribed: false },
];
const directory = ownerDirectory(
  [
    { actorId: NADIA, displayName: 'Nadia' },
    { actorId: RAFI, displayName: 'Rafi' },
    { actorId: OMAR, displayName: 'Omar' },
  ],
  [person(NADIA, 'Nadia'), person(RAFI, 'Rafi'), person(OMAR, 'Omar', 'no')],
);
const draft = (patch: Partial<MeetingNotesDraft>): MeetingNotesDraft => ({ summary: 'S', decisions: [], actionItems: [], questions: [], ...patch });

describe('the items made from the Scribe\'s answer', () => {
  it('keeps an item whose time is inside a transcribed line and moves it to the start of that line', () => {
    const items = buildNoteItems(draft({ decisions: [{ text: 'Ship Thursday', atMs: 6500 }], questions: [{ text: 'Who pays?', atMs: 0 }] }), lines, directory);
    expect(items.map((i) => [i.kind, i.atMs])).toEqual([['decision', 5000], ['question', 0]]);
  });

  it('drops an item whose time is not a line: invented, past the end, between lines, or in a line nobody agreed to have written down', () => {
    const items = buildNoteItems(
      draft({
        decisions: [{ text: 'Made up', atMs: 987654 }, { text: 'Between', atMs: 3000 }, { text: 'Placeholder', atMs: 9100 }],
        actionItems: [{ text: 'Invented', owner: null, due: null, atMs: 50000 }],
      }),
      lines,
      directory,
    );
    expect(items).toEqual([]);
  });

  it('gives an action to a team member by exact display name, in any case', () => {
    const [item] = buildNoteItems(draft({ actionItems: [{ text: 'Write the note', owner: 'rafi', due: '2026-11-06', atMs: 0 }] }), lines, directory);
    expect(item).toMatchObject({ kind: 'action', ownerName: 'rafi', ownerId: RAFI, due: '2026-11-06' });
  });

  it('writes no owner when the model named nobody', () => {
    const [item] = buildNoteItems(draft({ actionItems: [{ text: 'Update the page', owner: null, due: null, atMs: 0 }] }), lines, directory);
    expect(item).toMatchObject({ ownerName: null, ownerId: null });
  });

  it('attributes nothing to a person who did not say yes, whatever the model wrote', () => {
    const [item] = buildNoteItems(draft({ actionItems: [{ text: 'Own the export', owner: 'Omar', due: null, atMs: 0 }] }), lines, directory);
    expect(item).toMatchObject({ ownerName: null, ownerId: null });
    expect(actionOwnerIds([item!])).toEqual([]);
  });

  it('keeps the name but gives no id for somebody who is not on the team, and none for a name two members share', () => {
    const twins = ownerDirectory([{ actorId: NADIA, displayName: 'Sam' }, { actorId: RAFI, displayName: 'sam' }], []);
    const items = buildNoteItems(draft({ actionItems: [{ text: 'A', owner: 'Priya Guest', due: null, atMs: 0 }, { text: 'B', owner: 'Sam', due: null, atMs: 5000 }] }), lines, twins);
    expect(items.map((i) => [i.ownerName, i.ownerId])).toEqual([['Priya Guest', null], ['Sam', null]]);
  });

  it('removes a duplicate and strips control and bidi characters from the text', () => {
    const items = buildNoteItems(draft({ decisions: [{ text: 'Ship', atMs: 0 }, { text: 'SHIP', atMs: 5000 }, { text: 'Evil‮text', atMs: 5000 }] }), lines, directory);
    expect(items.map((i) => i.text)).toEqual(['Ship', 'Eviltext']);
  });

  it('lists the people who were given actions once each', () => {
    const items = buildNoteItems(
      draft({ actionItems: [{ text: 'A', owner: 'Nadia', due: null, atMs: 0 }, { text: 'B', owner: 'Nadia', due: null, atMs: 5000 }, { text: 'C', owner: 'Rafi', due: null, atMs: 5000 }] }),
      lines,
      directory,
    );
    expect(actionOwnerIds(items)).toEqual([NADIA, RAFI]);
  });
});

describe('the notes text', () => {
  const items: MeetingNoteItem[] = [
    { kind: 'decision', text: 'Ship Thursday', ownerName: null, ownerId: null, due: null, atMs: 5000 },
    { kind: 'action', text: 'Write the note', ownerName: 'Rafi', ownerId: RAFI as never, due: '2026-11-06', atMs: 0 },
    { kind: 'action', text: 'Update the page', ownerName: null, ownerId: null, due: null, atMs: 5000 },
  ];
  const file = { title: 'Sprint review', startedAt: new Date('2026-11-02T09:30:00Z'), meetingId: '00000000-0000-7000-8000-000000000001', summary: 'They moved the release.', items };

  it('is deterministic and points every item at a line of the transcript beside it', () => {
    const md = renderNotesMarkdown(file);
    expect(renderNotesMarkdown(file)).toBe(md);
    expect(md).toContain('type: "Meeting Notes"');
    expect(md).toContain('- Ship Thursday ([00:00:05](transcript.md))');
    expect(md).toContain('- [ ] Write the note — owner: Rafi, due 2026-11-06 ([00:00:00](transcript.md))');
    expect(md).toContain('- [ ] Update the page — no owner ([00:00:05](transcript.md))');
    expect(md).toContain('## Open questions\n\n*None.*');
  });

  it('cannot be turned into a heading, a link, an image or a tag by what the model wrote', () => {
    const md = renderNotesMarkdown({ ...file, summary: '# Heading [x](http://evil) ![i](u) <b>', items: [] });
    expect(md).not.toMatch(/^# Heading/m);
    expect(md).toContain('\\# Heading \\[x\\]');
    expect(md).toContain('\\<b\\>');
    expect(escapeMarkdown('1. first')).toBe('\\1. first');
  });

  it('gives the thread the summary, the counts and the way to the notes', () => {
    const body = threadBody('Sprint review', file.meetingId, file.summary, items);
    expect(body).toContain('**Notes from Sprint review**');
    expect(body).toContain('1 decision · 2 action items · 0 open questions');
    expect(body).toContain('(/meetings/00000000-0000-7000-8000-000000000001)');
  });

  it('shows the model only the words of people who said yes', () => {
    const text = transcriptForModel(
      { title: 'Review', started_at: new Date('2026-11-02T09:30:00Z') },
      [
        { startMs: 0, endMs: 1000, speakerName: 'Nadia', text: 'Hello | there: friend', transcribed: true },
        { startMs: 3000, endMs: 4000, speakerName: 'Omar', text: 'secret', transcribed: false },
      ] as never,
    );
    expect(text).toContain('@0 | 00:00:00 | Nadia: Hello | there: friend');
    expect(text).not.toContain('Omar');
    expect(text).not.toContain('secret');
  });
});

describe('the memory item and its switches', () => {
  it('reads autoMemory from TEAM.md: on unless it says off, and off when it cannot be read', () => {
    expect(readAutoMemory(null)).toBe(true);
    expect(readAutoMemory('# Team')).toBe(true);
    expect(readAutoMemory('---\nname: Eng\n---\n')).toBe(true);
    expect(readAutoMemory('---\nmeetings:\n  autoMemory: true\n---\n')).toBe(true);
    expect(readAutoMemory('---\nmeetings:\n  autoMemory: false\n---\n')).toBe(false);
    expect(readAutoMemory('---\nmeetings:\n  autoMemory: nope\n---\n')).toBe(false);
    expect(readAutoMemory('---\nmeetings: 3\n---\n')).toBe(false);
    expect(readAutoMemory('---\n: : [\n---\n')).toBe(false);
  });

  it('carries the transcript path and the time of each line, and only the lines it is given', () => {
    const text = renderMemoryItem({
      title: 'Sprint review',
      date: '2026-11-02',
      speakers: ['Nadia'],
      transcriptPath: 'meetings/2026/11/02-0930-sprint-review/transcript.md',
      notesPath: 'meetings/2026/11/02-0930-sprint-review/notes.md',
      notesMd: '---\ntype: "Meeting Notes"\n---\n\n# Sprint review\n\n## Summary\n\nThey moved it.\n',
      lines: [{ startMs: 65000, speakerName: 'Nadia', text: 'Ship Thursday' }],
    });
    expect(text).toContain('`meetings/2026/11/02-0930-sprint-review/transcript.md`');
    expect(text).toContain('[00:01:05] Nadia: Ship Thursday');
    expect(text).toContain('They moved it.');
    expect(text).not.toContain('type: "Meeting Notes"');
  });

  it('warns that the whole team will see what is sent, and that a guest needs a lead\'s approval', () => {
    expect(sendWarning('Engineering', true, false)).toContain('private channel');
    expect(sendWarning('Engineering', true, false)).toContain('everyone in Engineering will see');
    expect(sendWarning('Engineering', false, false)).not.toContain('guest');
    expect(sendWarning('Engineering', true, true)).toContain('A guest was in the call');
  });
});
