import { describe, expect, it } from 'vitest';
import { parseBotMd } from '../src/bot-md.ts';

// BOT.md parsing (PLAN P5-04): strict, and every failure carries the field path the red banner shows.

const ok = (body: string): string => `---\n${body}\n---\n\n# Soul\n`;
const valid = ok(`schema: 1\nname: Tester\nrole: Answers questions\nkind: agent\nruntime: hermes`);

describe('parseBotMd', () => {
  it('parses a valid frontmatter and lets the body be prose', () => {
    const parsed = parseBotMd(`${valid}\nAnything goes below the fence.\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter).toMatchObject({ name: 'Tester', kind: 'agent', runtime: 'hermes' });
  });

  it('an unknown key fails with its path', () => {
    const parsed = parseBotMd(ok('name: Tester\nrole: R\nkind: agent\nruntime: hermes\ncapabilties: {}'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.fieldPath).toBe('capabilties');
  });

  it('a bad value fails at its index', () => {
    const parsed = parseBotMd(
      ok('name: T\nrole: R\nkind: agent\nruntime: hermes\ncapabilities:\n  native: [messages.post, files.write, tasks.own, NOT A CAPABILITY]'),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.fieldPath).toBe('capabilities.native[3]');
  });

  it('a missing key fails with its path', () => {
    const parsed = parseBotMd(ok('name: Tester\nkind: agent\nruntime: hermes'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.fieldPath).toBe('role');
  });

  it('no opening fence and an unclosed fence are each one clear failure', () => {
    expect(parseBotMd('name: Tester\n')).toMatchObject({ ok: false, failure: { fieldPath: null, message: /--- frontmatter block/ } });
    expect(parseBotMd('---\nname: Tester\n')).toMatchObject({ ok: false, failure: { fieldPath: null, message: /never closes/ } });
  });

  it('YAML that will not parse fails as the frontmatter, not as a crash', () => {
    expect(parseBotMd('---\nname: [1, 2\n---\n')).toMatchObject({ ok: false, failure: { fieldPath: null, message: /^frontmatter: / } });
  });

  it('a byte-order mark before the fence is invisible, nothing else is lenient', () => {
    expect(parseBotMd(`\uFEFF${valid}`).ok).toBe(true);
    expect(parseBotMd('\uFEFFnot a fence').ok).toBe(false);
  });
});
