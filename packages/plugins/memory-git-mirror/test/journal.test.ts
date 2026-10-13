import { parseConcept } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { renderJournal } from '../src/bundle.ts';
import { isPastDay, yesterday } from '../src/index.ts';

// The journal as text: counts and source links, nothing else, and a file the bundle's own rules accept.

const NOW = new Date('2026-10-13T02:23:00.000Z');

describe('renderJournal', () => {
  const text = renderJournal({
    date: '2026-10-12',
    now: NOW,
    counts: [
      { kind: 'message', retained: 8, forgotten: 1 },
      { kind: 'run', retained: 3, forgotten: 0 },
    ],
    links: [
      { kind: 'message', at: '2026-10-12T09:14:02.000Z', link: '/t/engineering/c/dev?message=0190a000-0000-7000-8000-000000000001' },
      { kind: 'run', at: '2026-10-12T11:40:00.000Z', link: '/t/engineering/bots/coder' },
    ],
    moreLinks: 9,
  });

  it('is a valid OKF concept of type Journal, written by the journal process', () => {
    const parsed = parseConcept(text);
    expect(parsed).toMatchObject({
      ok: true,
      frontmatter: {
        type: 'Journal',
        title: 'Journal 2026-10-12',
        tags: ['journal'],
        status: 'stable',
        origin: 'journal',
        generated: { by: 'process:journal', at: '2026-10-13T02:23:00.000Z' },
      },
    });
  });

  it('holds totals, a table by source and the links — and no text', () => {
    expect(text).toContain('took in 11 items and took out 1.');
    expect(text).toContain('| message | 8 | 1 |');
    expect(text).toContain('| bot run | 3 | 0 |');
    // what was left out is the retain log's (leads and admins), never a file every member reads
    expect(text).not.toMatch(/left out|withheld/i);
    expect(text).toContain('- 09:14 [message](</t/engineering/c/dev?message=0190a000-0000-7000-8000-000000000001>)');
    expect(text).toContain('- and 9 more');
  });

  it('is the same for the same input (no clock, no randomness beyond `now`)', () => {
    expect(renderJournal({ date: '2026-10-12', now: NOW, counts: [], links: [], moreLinks: 0 })).toBe(renderJournal({ date: '2026-10-12', now: NOW, counts: [], links: [], moreLinks: 0 }));
  });
});

describe('days', () => {
  it('yesterday is the UTC day before', () => {
    expect(yesterday(NOW)).toBe('2026-10-12');
    expect(yesterday(new Date('2026-03-01T00:00:00Z'))).toBe('2026-02-28');
  });

  it('only a real day that is over can be written', () => {
    expect(isPastDay('2026-10-12', '2026-10-13')).toBe(true);
    expect(isPastDay('2026-10-13', '2026-10-13')).toBe(false);
    expect(isPastDay('2026-10-14', '2026-10-13')).toBe(false);
    expect(isPastDay('2026-02-30', '2026-10-13')).toBe(false);
    expect(isPastDay('yesterday', '2026-10-13')).toBe(false);
    expect(isPastDay('../etc/passwd', '2026-10-13')).toBe(false);
  });
});
