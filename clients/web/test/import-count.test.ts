import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageCountWords, progressWords } from '../src/screens/import/format';

const screen = readFileSync(join(__dirname, '../src/screens/import/ImportScreen.tsx'), 'utf8');

describe('import table message count', () => {
  it('the imp-count cell says its count through messageCountWords, not a hard-coded "messages"', () => {
    const cell = screen.match(/className="imp-count">([^<]*)<\/span>/);
    expect(cell, 'imp-count cell').not.toBeNull();
    expect(cell?.[1]?.trim()).toBe('{messageCountWords(c.messages)}');
  });

  it('is singular only for exactly one, and keeps the separator at every size', () => {
    expect(messageCountWords(1)).not.toMatch(/messages/);
    expect(messageCountWords(11)).toBe('11 messages');
    expect(messageCountWords(1000)).toBe('1,000 messages');
    expect(messageCountWords(1_000_001)).toBe('1,000,001 messages');
  });

  it('leaves the progress line "N of M messages" as it was', () => {
    const p = { phase: 'messages' as const, messagesDone: 1, messagesTotal: 1, channelsDone: 0, channelsTotal: 0 };
    expect(progressWords({ status: 'running', progress: p })).toBe('Writing messages: 1 of 1 messages.');
  });
});
