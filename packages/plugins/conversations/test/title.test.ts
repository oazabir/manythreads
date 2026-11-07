import { describe, expect, it } from 'vitest';
import { cleanTitle } from '../src/title.ts';

// The model's answer, made into a title (P20-16): one line, no quotes, no closing full stop, within 80 characters, nothing when nothing is left.

describe('cleanTitle', () => {
  it('keeps a plain title as it is', () => {
    expect(cleanTitle('Release notes for 2.4')).toBe('Release notes for 2.4');
  });

  it('takes off quotes, a label and the closing full stop', () => {
    expect(cleanTitle('"Release notes for 2.4."')).toBe('Release notes for 2.4');
    expect(cleanTitle('Title: Planning the move')).toBe('Planning the move');
    expect(cleanTitle('“A new plan”')).toBe('A new plan');
  });

  it('keeps the first line only', () => {
    expect(cleanTitle('\n  Budget review\nThis conversation is about the budget.')).toBe('Budget review');
  });

  it('cuts a long answer at 80 characters with an ellipsis', () => {
    const out = cleanTitle('word '.repeat(40))!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('answers null for nothing or only quotes', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   \n  ')).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });
});
