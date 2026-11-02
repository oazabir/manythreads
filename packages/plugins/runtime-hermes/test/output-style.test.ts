import { describe, expect, it } from 'vitest';
import { OUTPUT_STYLE, withOutputStyle } from '../src/output-style.ts';

describe('the output style every bot gets', () => {
  it('follows the bot’s own instructions and leaves them as written', () => {
    const out = withOutputStyle('  # Coder\nYou own a task.  \n');
    expect(out.startsWith('# Coder\nYou own a task.\n\n')).toBe(true);
    expect(out.endsWith(OUTPUT_STYLE)).toBe(true);
  });
  it('is added to an empty body too', () => {
    expect(withOutputStyle('  \n')).toBe(OUTPUT_STYLE);
  });
  it('names the rules in plain words', () => {
    expect(OUTPUT_STYLE).toMatch(/file name and path in backticks/);
    expect(OUTPUT_STYLE).toMatch(/fenced code block, with the language/);
    expect(OUTPUT_STYLE).toMatch(/- \[ \]/);
    expect(OUTPUT_STYLE).toMatch(/edit the same list/);
    expect(OUTPUT_STYLE).toMatch(/one heading level/);
  });
});
