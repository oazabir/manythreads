import { describe, expect, it } from 'vitest';
import { validateOkfWrite } from '../../src/okf/index.ts';

// P20-05: one check for a single OKF write, run by the repo writer (a team's memory/) and by the Personal memory store.

const CONCEPT = '---\ntype: Person\ntitle: Nadia\n---\n\nShe owns the release.\n';

describe('validateOkfWrite', () => {
  it('accepts a concept at a bundle-relative path', () => {
    const verdict = validateOkfWrite('people/nadia.md', CONCEPT);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.frontmatter.type).toBe('Person');
  });
  it.each([
    ['', 'empty'],
    ['/abs.md', 'absolute'],
    ['a/../b.md', 'dot-dot'],
    ['notes.txt', 'not markdown'],
    ['dir/', 'a folder'],
    ['a\\b.md', 'backslash'],
  ])('refuses the path %j (%s)', (path) => {
    expect(validateOkfWrite(path, CONCEPT).ok).toBe(false);
  });
  it('refuses the platform’s own files at any depth', () => {
    expect(validateOkfWrite('index.md', CONCEPT).ok).toBe(false);
    expect(validateOkfWrite('people/log.md', CONCEPT).ok).toBe(false);
  });
  it('refuses text with no type, a NUL, or more than a megabyte', () => {
    expect(validateOkfWrite('a.md', '---\ntitle: x\n---\nbody').ok).toBe(false);
    expect(validateOkfWrite('a.md', `${CONCEPT}\0`).ok).toBe(false);
    expect(validateOkfWrite('a.md', `${CONCEPT}${'x'.repeat(1_000_001)}`).ok).toBe(false);
  });
  it('is linear on hostile input', () => {
    const hostile = `---\ntype: Person\n${'a: '.repeat(20000)}\n---\n`;
    const start = Date.now();
    validateOkfWrite('a.md', hostile);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
