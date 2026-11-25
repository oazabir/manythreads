import { describe, expect, it } from 'vitest';
import { CARRY_MAX, CARRY_TEXT_MAX, agendaDue, mergeCarried, noteActionItems, openActionItems, renderAgenda, renderReadme, ruleLabel } from '../src/series-agenda.ts';

// P17-05: the agenda page of a meeting series, without a database. What is carried into the next agenda is exactly the boxes left unticked under the two
// action-item headings, each once; the page the platform writes reads back to the same items; the parse stays linear on hostile input.

const agenda = [
  '# Weekly sync · Tuesday 1 December 2026',
  '',
  '## Agenda',
  '- [ ] An agenda point written as a box is not an action item',
  '',
  '## Open action items from the last meeting',
  '- [ ] Send the draft to legal — Priya',
  '- [x] Book the room',
  '',
  '## Action items',
  '* [ ] Check the numbers — Omar',
  '  - [ ] An item under another, indented',
  '+ [X] Done already',
  '- [ ] send the draft to legal — priya.',
  '- [ ] ',
  '```',
  '- [ ] inside a code fence',
  '```',
  '',
  '## Notes',
  '- [ ] A box in the notes is not carried',
].join('\n');

describe('the open action items of an agenda', () => {
  it('are the unticked boxes under the two headings, in order, each once; ticked, empty, fenced and other boxes stay', () => {
    expect(openActionItems(agenda)).toEqual(['Send the draft to legal — Priya', 'Check the numbers — Omar', 'An item under another, indented']);
  });

  it('read back from the page the platform writes, with Windows line ends too', () => {
    const page = renderAgenda({ title: 'Weekly sync', dateLabel: 'Tuesday 8 December 2026', carried: ['Send the draft to legal — Priya'], agendaLine: 'Plans' });
    expect(page).toContain('## Open action items from the last meeting\n- [ ] Send the draft to legal — Priya');
    expect(page).toContain("Items not ticked are copied into the next meeting's agenda.");
    expect(openActionItems(page)).toEqual(['Send the draft to legal — Priya']);
    expect(openActionItems(page.replace(/\n/g, '\r\n'))).toEqual(['Send the draft to legal — Priya']);
    expect(renderAgenda({ title: 'x', dateLabel: 'd', carried: [], agendaLine: '' })).toContain('*Nothing was left open.*');
  });

  it('are at most fifty, one line of at most three hundred characters each, without control characters', () => {
    const many = ['## Action items', ...Array.from({ length: 80 }, (_, i) => `- [ ] item ${i}`)].join('\n');
    expect(openActionItems(many)).toHaveLength(CARRY_MAX);
    const long = openActionItems(`## Action items\n- [ ] ${'a'.repeat(1000)}\u202e\u0007`)[0]!;
    expect([...long].length).toBeLessThanOrEqual(CARRY_TEXT_MAX);
    expect(long.includes(String.fromCharCode(7)) || long.includes(String.fromCharCode(0x202e))).toBe(false);
  });

  it('stays linear on hostile input', () => {
    const hostile = `## Action items\n${'- [ '.repeat(50_000)}\n${'#'.repeat(50_000)}\n${'`'.repeat(50_000)}`;
    const t = performance.now();
    openActionItems(hostile);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('carrying action items from notes', () => {
  it('takes the action items only, with their owner, Markdown escaped, and adds those the agenda does not already have', () => {
    const notes = noteActionItems([
      { kind: 'action', text: 'Send the *draft* to legal', ownerName: 'Priya', ownerId: null, due: null, atMs: 0 },
      { kind: 'decision', text: 'We ship on Friday', ownerName: null, ownerId: null, due: null, atMs: 0 },
      { kind: 'action', text: 'Write the [release](javascript:alert(1)) notes', ownerName: null, ownerId: null, due: null, atMs: 0 },
    ]);
    expect(notes).toEqual(['Send the \\*draft\\* to legal — Priya', 'Write the \\[release\\](javascript:alert(1)) notes']);
    expect(mergeCarried(['Send the *draft* to legal — Priya'], notes)).toEqual(['Send the *draft* to legal — Priya', 'Write the \\[release\\](javascript:alert(1)) notes']);
  });
});

describe('the rest of the page', () => {
  it('names the rule, and the README says what the folder is', () => {
    expect(ruleLabel('weekly', null)).toBe('Every week');
    expect(ruleLabel('biweekly', '2027-03-31')).toBe('Every 2 weeks until 2027-03-31');
    expect(renderReadme({ title: 'Weekly # sync', teamName: 'Engineering', frequency: 'monthly', untilDate: null })).toMatch(/^# Weekly # sync\n\nA meeting series of Engineering: every month\./);
  });

  it('an agenda is due at once for the first meeting, an hour after the one before it ended with its call over, and an hour before it starts', () => {
    const now = new Date('2030-01-15T12:00:00Z');
    const at = (h: number): Date => new Date(now.getTime() + h * 3600_000);
    expect(agendaDue({ previousEndsAt: null, startsAt: at(24 * 30), now, callLive: false })).toBe(true);
    expect(agendaDue({ previousEndsAt: at(-0.5), startsAt: at(24 * 7), now, callLive: false })).toBe(false);
    expect(agendaDue({ previousEndsAt: at(-1), startsAt: at(24 * 7), now, callLive: false })).toBe(true);
    expect(agendaDue({ previousEndsAt: at(-3), startsAt: at(24 * 7), now, callLive: true })).toBe(false);
    expect(agendaDue({ previousEndsAt: at(-0.1), startsAt: at(0.5), now, callLive: true })).toBe(true);
  });
});
