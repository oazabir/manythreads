import { describe, expect, it } from 'vitest';
import { TITLE_CHARS, titleOf } from '../src/wrows.ts';

// The title of a Workshop conversation is the first words the person wrote: whole words, with an ellipsis when it was cut.
describe('titleOf', () => {
  it('keeps a short first message as it is, on one line', () => {
    expect(titleOf('  Tell   me\nwhat went wrong ')).toBe('Tell me what went wrong');
  });

  it('cuts a long message after a whole word and ends with an ellipsis', () => {
    const text = 'The release notes for the new billing page say that invoices are sent on the first of the month, then create a reminder for the account owner';
    const title = titleOf(text);
    expect(title.endsWith('…')).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(TITLE_CHARS);
    expect(title).toBe('The release notes for the new billing page say that invoices are sent on the…');
  });

  it('never ends in the middle of a word, wherever the limit falls', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
    for (let start = 0; start < words.length; start += 1) {
      const text = Array.from({ length: 40 }, (_, i) => words[(start + i) % words.length]).join(' ');
      const title = titleOf(text);
      expect(title.endsWith('…')).toBe(true);
      expect([...title].length).toBeLessThanOrEqual(TITLE_CHARS);
      for (const w of title.slice(0, -1).split(' ')) expect(words).toContain(w);
    }
  });

  it('a short first word followed by one very long word cuts after the short word, not inside the long one', () => {
    expect(titleOf(`Hi ${'a'.repeat(300)}`)).toBe('Hi…');
    expect(titleOf(`${'b'.repeat(15)} ${'a'.repeat(300)}`)).toBe(`${'b'.repeat(15)}…`);
  });

  it('cuts one very long word at the limit, with an ellipsis', () => {
    const t = titleOf('a'.repeat(300));
    expect([...t].length).toBe(TITLE_CHARS);
    expect(t.endsWith('…')).toBe(true);
  });
});
