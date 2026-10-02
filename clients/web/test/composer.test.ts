import { describe, expect, it } from 'vitest';
import { detectTrigger } from '../src/channels/Composer';
import { estimateMessageHeight, dayLabel, ago, fileSize, fileKind } from '../src/channels/format';

describe('composer pickers', () => {
  it('opens on an @ or # that starts a word, at the caret', () => {
    expect(detectTrigger('hello @na', 9)).toEqual({ char: '@', query: 'na', start: 6 });
    expect(detectTrigger('@', 1)).toEqual({ char: '@', query: '', start: 0 });
    expect(detectTrigger('see #dev-ops', 12)).toEqual({ char: '#', query: 'dev-ops', start: 4 });
    expect(detectTrigger('(@omar', 6)).toEqual({ char: '@', query: 'omar', start: 1 });
    expect(detectTrigger('line one\n@ra', 12)).toEqual({ char: '@', query: 'ra', start: 9 });
  });

  it('does not open inside an address, after the caret, or once the word is over', () => {
    expect(detectTrigger('mail a@b.example', 16)).toBeNull();
    expect(detectTrigger('issue#12', 8)).toBeNull();
    expect(detectTrigger('hello @na there', 15)).toBeNull();
    expect(detectTrigger('hello @na', 3)).toBeNull();
    expect(detectTrigger('plain text', 10)).toBeNull();
  });
});

describe('formatting', () => {
  it('labels days, ages and sizes', () => {
    const now = new Date('2026-09-08T12:00:00');
    expect(dayLabel('2026-09-08T08:00:00', now)).toBe('Today');
    expect(dayLabel('2026-09-07T23:00:00', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-04T08:00:00', now)).toBe('Friday 4 September');
    expect(dayLabel('2025-12-31T08:00:00', now)).toBe('Wednesday 31 December 2025');
    expect(ago('2026-09-08T11:58:00', now)).toBe('2m');
    expect(ago('2026-09-08T11:00:00', now)).toBe('1h');
    expect(ago('2026-09-08T11:59:50', now)).toBe('now');
    expect(fileSize(412 * 1024)).toBe('412 KB');
    expect(fileSize(2.1 * 1024 * 1024)).toBe('2.1 MB');
    expect(fileKind('qa.pdf', 'application/pdf')).toEqual({ label: 'PDF', tone: 'pdf' });
    expect(fileKind('notes.md', 'text/markdown').label).toBe('MD');
  });

  it('guesses a taller row for longer text, reactions, replies and files', () => {
    const base = { body: 'short', reactions: [], replyCount: 0 };
    expect(estimateMessageHeight({ ...base, body: 'x'.repeat(400) })).toBeGreaterThan(estimateMessageHeight(base));
    expect(estimateMessageHeight({ ...base, replyCount: 2 })).toBeGreaterThan(estimateMessageHeight(base));
    expect(estimateMessageHeight({ ...base, attachments: [1] })).toBeGreaterThan(estimateMessageHeight(base));
  });
});
