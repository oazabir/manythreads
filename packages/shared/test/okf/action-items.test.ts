import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-utils/src/linear.ts';
import { ACTION_ITEMS_MAX, ARCHIVIST_TYPE_VOCABULARY, ArchivistProposals, BotFrontmatter, parseActionItems } from '../../src/index.ts';

describe('parseActionItems', () => {
  it('reads the checkbox line with owner and due', () => {
    expect(parseActionItems('- [ ] Send the revised quote to Acme (owner: Nadia; due: 2026-11-20)')).toEqual([
      { index: 0, what: 'Send the revised quote to Acme', owner: 'Nadia', due: '2026-11-20', done: false },
    ]);
  });

  it('keeps order, ignores other lines, marks done ones', () => {
    const body = ['# Meeting', '', 'Intro text (owner: nobody)', '* [x] Book the room (due: 2026-12-01)', '+ [ ] Call Lena (owner: Omar)', '- not a box', '- [?] odd'].join('\n');
    expect(parseActionItems(body)).toEqual([
      { index: 0, what: 'Book the room', owner: null, due: '2026-12-01', done: true },
      { index: 1, what: 'Call Lena', owner: 'Omar', due: null, done: false },
    ]);
  });

  it('drops a date that is not a calendar day and keeps the words', () => {
    const [a, b, c] = parseActionItems(['- [ ] A (due: 2026-02-30)', '- [ ] B (due: next week)', '- [ ] C (owner: ; due: 2026-02-28)'].join('\n'));
    expect(a).toMatchObject({ what: 'A', due: null });
    expect(b).toMatchObject({ what: 'B', due: null });
    expect(c).toMatchObject({ what: 'C', owner: null, due: '2026-02-28' });
  });

  it('leaves a parenthesis that is not an owner/due group in the words', () => {
    expect(parseActionItems('- [ ] Ship the fix (see ticket 4) soon')[0]?.what).toBe('Ship the fix (see ticket 4) soon');
    expect(parseActionItems('- [ ] Ship the fix (see ticket 4)')[0]?.what).toBe('Ship the fix (see ticket 4)');
  });

  it('skips an empty action and cuts a very long list', () => {
    expect(parseActionItems('- [ ] (owner: Nadia)')).toEqual([]);
    const many = Array.from({ length: ACTION_ITEMS_MAX + 50 }, (_, i) => `- [ ] item ${i}`).join('\n');
    expect(parseActionItems(many)).toHaveLength(ACTION_ITEMS_MAX);
  });

  it.each([
    ['open parentheses', (n: number) => `- [ ] ${'('.repeat(n)})`],
    ['semicolons', (n: number) => `- [ ] x (owner: ${';'.repeat(n)})`],
    ['many short lines', (n: number) => '- [ ] a\n'.repeat(n)],
    ['one long line', (n: number) => `- [ ] ${'a '.repeat(n)}(due: 2026-01-01)`],
  ])('is linear on hostile input: %s', (name, build) => {
    expectLinear(build, (text) => parseActionItems(text), { n: 20_000, label: name });
  });
});

describe('Archivist contract', () => {
  it('names the default type vocabulary', () => {
    expect([...ARCHIVIST_TYPE_VOCABULARY]).toEqual(['Fact', 'Decision', 'Meeting', 'Action Items', 'Playbook', 'Reference']);
  });

  it('accepts a list of proposals and refuses a stray key or too many', () => {
    expect(ArchivistProposals.safeParse([{ path: 'memory/facts/a.md', type: 'Fact', body: 'x' }]).success).toBe(true);
    expect(ArchivistProposals.safeParse([{ path: 'memory/a.md', owner: 'x' }]).success).toBe(false);
    expect(ArchivistProposals.safeParse(Array.from({ length: 21 }, (_, i) => ({ path: `memory/${i}.md` }))).success).toBe(false);
  });

  it('lets BOT.md declare the typed output', () => {
    const parsed = BotFrontmatter.safeParse({
      name: 'Archivist',
      role: 'Files what lands in the inbox.',
      kind: 'agent',
      runtime: 'hermes',
      visibility: 'team',
      triggers: [{ type: 'drop' }],
      contract: { outputs: { proposals: 'okf_proposals' } },
      capabilities: { native: ['inbox.read', 'memory.recall', 'memory.write'] },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
