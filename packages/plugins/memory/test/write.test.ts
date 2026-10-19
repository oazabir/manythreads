import { parseConcept } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { bundleAbsoluteLinks, conceptText, draftPathFor, isPersonOwned, splitPlatformKeys } from '../src/write.ts';

// The pure half of `memory.write` (PLAN P5-26): what a bot may and may not claim, where a draft goes, how a relative link becomes a bundle link, and
// the round trip that makes the text this tool writes byte-identical to what the writer's own stamping would produce for the same frontmatter.

describe('splitPlatformKeys', () => {
  it('removes the keys the platform owns and names them, keeping everything else', () => {
    const { values, dropped } = splitPlatformKeys({
      path: 'memory/facts/x.md',
      type: 'fact',
      body: 'text',
      verified: [{ by: 'human:somebody' }],
      origin: 'drop',
      generated: { by: 'archivist/v2' },
      sources: [{ resource: 'drive:x' }],
      share: 'never',
      usage_window: { from: '2026-01-01' },
      title: 'Cache TTL',
    });
    expect(dropped).toEqual(['verified', 'origin', 'generated', 'sources', 'share', 'usage_window']);
    expect(values).toEqual({ path: 'memory/facts/x.md', type: 'fact', body: 'text', title: 'Cache TTL' });
  });

  it('answers nothing for input that is not an object (the schema refuses it after)', () => {
    expect(splitPlatformKeys(null)).toEqual({ values: {}, dropped: [] });
    expect(splitPlatformKeys('x')).toEqual({ values: {}, dropped: [] });
    expect(splitPlatformKeys([1, 2])).toEqual({ values: {}, dropped: [] });
  });
});

describe('draftPathFor', () => {
  it('puts the draft beside the concept, marked with the bot', () => {
    expect(draftPathFor('memory/facts/cache-ttl.md', 'coder')).toBe('memory/facts/cache-ttl-draft-coder.md');
    expect(draftPathFor('memory/a.md', 'brain')).toBe('memory/a-draft-brain.md');
  });

  it('keeps the name inside the bundle whatever the slug says', () => {
    expect(draftPathFor('memory/a.md', '../../etc/passwd')).toBe('memory/a-draft-etc-passwd.md');
    expect(draftPathFor('memory/a.md', '')).toBe('memory/a-draft-bot.md');
    expect(draftPathFor('memory/a.md', 'x'.repeat(80)).length).toBeLessThanOrEqual('memory/a-draft-'.length + 40 + 3);
  });
});

describe('isPersonOwned', () => {
  const concept = (frontmatter: string): string => `---\n${frontmatter}---\n\nA body.\n`;

  it('is true when the concept says a person wrote it', () => {
    expect(isPersonOwned(concept('type: fact\ngenerated:\n  by: human:5a1c\n'))).toBe(true);
  });

  it('is true when the last verifier is a person, even if a bot wrote it', () => {
    expect(isPersonOwned(concept('type: fact\ngenerated:\n  by: archivist/v2\nverified:\n  - by: archivist/v2\n  - by: human:5a1c\n'))).toBe(true);
  });

  it('is false for a machine-written concept, an earlier human verifier, and a file that is not a concept', () => {
    expect(isPersonOwned(concept('type: fact\ngenerated:\n  by: archivist/v2\n'))).toBe(false);
    expect(isPersonOwned(concept('type: fact\nverified:\n  - by: human:5a1c\n  - by: archivist/v2\n'))).toBe(false);
    expect(isPersonOwned('not a concept')).toBe(false);
    expect(isPersonOwned('---\ntitle: no type\n---\n\nx\n')).toBe(false);
  });
});

describe('bundleAbsoluteLinks', () => {
  const from = 'memory/journal/2026-10-14.md';

  it('rewrites a relative link that resolves inside the bundle into the bundle-absolute form', () => {
    expect(bundleAbsoluteLinks('see [the fact](../facts/cache-ttl.md)\n', from)).toBe('see [the fact](/facts/cache-ttl.md)\n');
    expect(bundleAbsoluteLinks('[x](facts/cache-ttl.md)', from)).toBe('[x](/journal/facts/cache-ttl.md)');
    expect(bundleAbsoluteLinks('[x](../facts/cache-ttl.md#ttl)', from)).toBe('[x](/facts/cache-ttl.md#ttl)');
    expect(bundleAbsoluteLinks('[x][shared](../shared/glossary.md)', from)).toBe('[x][shared](/shared/glossary.md)');
    expect(bundleAbsoluteLinks('![img](../facts/diagram.png)', from)).toBe('![img](../facts/diagram.png)');
  });

  it('keeps a link title, and leaves anchors, absolute paths, URLs, escapes and non-concepts alone', () => {
    expect(bundleAbsoluteLinks('[x](../facts/a.md "The fact")', from)).toBe('[x](/facts/a.md "The fact")');
    for (const body of [
      '[x](#section)',
      '[x](/facts/a.md)',
      '[x](https://example.com/a.md)',
      '[x](mailto:a@b.c)',
      '[x](../../etc/passwd)',
      '[x](../../pages/a.md)',
      '[x](../index.md)',
      '[x](../log.md)',
      '[x](../facts/a.txt)',
      '[x](%2e%2e/facts/a.md)',
      'plain text with (parentheses)',
    ]) {
      expect(bundleAbsoluteLinks(body, from), body).toBe(body);
    }
    // …and a link that resolves inside the bundle is rewritten even when the folder it names does not exist yet
    expect(bundleAbsoluteLinks('[x](../facts/new.md)', from)).toBe('[x](/facts/new.md)');
  });
});

describe('conceptText', () => {
  const generated = { by: 'archivist/v2', at: '2026-10-01T00:00:00.000Z' };

  it('writes a concept the parser reads back, and is what the writer’s own stamping would produce', () => {
    const text = conceptText({ type: 'fact', title: 'Cache TTL', resource: 'https://x/y', generated }, 'Thirty seconds.\n');
    const parsed = parseConcept(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter).toMatchObject({ type: 'fact', title: 'Cache TTL', resource: 'https://x/y', generated });
    // `serializeConcept` writes `---`, the frontmatter, `---`, a blank line, the body; reading back keeps that blank line
    expect(text.endsWith('---\n\nThirty seconds.\n')).toBe(true);
    expect(parsed.body).toBe('\nThirty seconds.\n');
    // a bot write is a stamp no-op: the text is already in the order the parser and the writer's `serializeConcept` produce
    expect(conceptText(parsed.frontmatter, parsed.body)).toBe(text);
  });

  it('leaves out a `type` the proposal did not have, so the parser says so in its own words', () => {
    const parsed = parseConcept(conceptText({ generated }, 'body\n'));
    expect(parsed).toEqual({ ok: false, reason: 'the frontmatter has no `type`' });
  });
});
