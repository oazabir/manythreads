import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FOLDERS_SECTION,
  bundleIndexPathFor,
  conceptTitle,
  memoryIndexFiles,
  memoryLogFile,
  parseConcept,
  type BundleConcept,
} from '../../src/okf/index.ts';
import { MemoryConceptSummary } from '../../src/entities/memory.ts';

// PLAN P5-25 / criterion 18: the bundle's `index.md` files and `log.md` are a pure function of the concept tree. The same tree always renders the
// same bytes, a directory that loses its last concept loses its index, and the log is date-grouped, newest first.

const concept = (path: string, frontmatter: Record<string, unknown>): BundleConcept => {
  const parsed = parseConcept(`---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\nbody\n`);
  if (!parsed.ok) throw new Error(`test concept ${path} did not parse: ${parsed.reason}`);
  return { path, frontmatter: parsed.frontmatter };
};

describe('bundleIndexPathFor', () => {
  it('names the index of the directory holding a concept, and nothing outside memory/', () => {
    expect(bundleIndexPathFor('memory/facts/onboarding.md')).toBe('memory/facts/index.md');
    expect(bundleIndexPathFor('memory/facts/a/b.md')).toBe('memory/facts/a/index.md');
    expect(bundleIndexPathFor('memory/root.md')).toBe('memory/index.md');
    expect(bundleIndexPathFor('pages/policy.md')).toBeNull();
    expect(bundleIndexPathFor('TEAM.md')).toBeNull();
  });
});

describe('memoryIndexFiles', () => {
  it('an empty bundle is just the root, with okf_version and the intro', () => {
    const files = memoryIndexFiles([]);
    expect([...files.keys()]).toEqual(['memory/index.md']);
    const root = files.get('memory/index.md') ?? '';
    expect(root).toContain('okf_version: "0.2"');
    expect(root).toContain("# Team memory");
  });

  it('lists child folders first, then one section per type, sorted', () => {
    const files = memoryIndexFiles([
      concept('memory/journal/2026-10-03.md', { type: 'Journal' }),
      concept('memory/facts/pricing.md', { type: 'Fact', title: 'Pricing' }),
      concept('memory/facts/onboarding.md', { type: 'Fact', title: 'Onboarding', description: 'How we onboard' }),
    ]);
    expect([...files.keys()].sort()).toEqual(['memory/facts/index.md', 'memory/index.md', 'memory/journal/index.md']);

    const root = files.get('memory/index.md') ?? '';
    expect(root).toContain(`# ${BUNDLE_FOLDERS_SECTION}`);
    expect(root).toContain('* [facts](facts/)');
    expect(root).toContain('* [journal](journal/)');

    const facts = files.get('memory/facts/index.md') ?? '';
    expect(facts).toContain('# Fact');
    expect(facts).toContain('* [Onboarding](onboarding.md) - How we onboard');
    expect(facts).toContain('* [Pricing](pricing.md)');
    // paths are relative to the directory that holds them
    expect(facts).not.toContain('memory/facts/onboarding.md');
  });

  it('is a pure function of the tree: order in gives the same bytes, and a re-render is byte-identical', () => {
    const a = concept('memory/facts/onboarding.md', { type: 'Fact', title: 'Onboarding', description: 'How we onboard' });
    const b = concept('memory/journal/2026-10-03.md', { type: 'Journal' });
    const c = concept('memory/facts/pricing.md', { type: 'Fact', title: 'Pricing' });
    const forward = memoryIndexFiles([a, b, c]);
    const shuffled = memoryIndexFiles([c, a, b]);
    expect([...forward]).toEqual([...shuffled]);
    expect([...memoryIndexFiles([a, b, c])]).toEqual([...forward]);
  });

  it('a directory that loses its last concept is absent, so the caller deletes its index; the root always stays', () => {
    const only = concept('memory/facts/onboarding.md', { type: 'Fact' });
    expect([...memoryIndexFiles([only]).keys()].sort()).toEqual(['memory/facts/index.md', 'memory/index.md']);
    const empty = memoryIndexFiles([]);
    expect(empty.has('memory/facts/index.md')).toBe(false);
    expect(empty.has('memory/index.md')).toBe(true);
  });

  it('a description is kept on the entry, and a nested folder is listed in its parent', () => {
    const files = memoryIndexFiles([concept('memory/facts/sources/handbook.md', { type: 'Fact', title: 'Handbook' })]);
    expect(files.get('memory/facts/index.md')).toContain('* [sources](sources/)');
    expect(files.get('memory/facts/sources/index.md')).toContain('* [Handbook](handbook.md)');
    expect(files.get('memory/index.md')).toContain('* [facts](facts/)');
  });
});

describe('memoryLogFile', () => {
  it('is date-grouped newest first, path order within a date, and links are bundle-relative', () => {
    const log = memoryLogFile([
      concept('memory/facts/onboarding.md', { type: 'Fact', title: 'Onboarding', description: 'How we onboard', generated: { by: 'process:platform', at: '2026-10-02T09:00:00Z' } }),
      concept('memory/journal/2026-10-03.md', { type: 'Journal', title: 'Wednesday', generated: { by: 'process:journal', at: '2026-10-03T08:00:00Z' } }),
      concept('memory/facts/pricing.md', { type: 'Fact', title: 'Pricing', generated: { by: 'process:platform', at: '2026-10-02T07:00:00Z' } }),
    ]);
    const lines = log.split('\n');
    expect(lines[0]).toBe('# Memory log');
    // 2026-10-03 before 2026-10-02; within the 2nd, facts/onboarding before facts/pricing (path order)
    expect(lines.indexOf('## 2026-10-03')).toBeLessThan(lines.indexOf('## 2026-10-02'));
    expect(log.indexOf('/facts/onboarding.md')).toBeLessThan(log.indexOf('/facts/pricing.md'));
    expect(log).toContain('- Update: [Wednesday](/journal/2026-10-03.md)');
    expect(log).toContain('[Onboarding](/facts/onboarding.md) — How we onboard');
  });

  it('a concept with no generated date is not in the log', () => {
    const log = memoryLogFile([concept('memory/facts/undated.md', { type: 'Fact', title: 'Undated' })]);
    expect(log).not.toContain('undated.md');
  });

  it('the verb comes from origin', () => {
    const log = memoryLogFile([concept('memory/facts/x.md', { type: 'Fact', title: 'X', origin: 'drop', generated: { by: 'process:platform', at: '2026-10-02T00:00:00Z' } })]);
    expect(log).toContain('- Filed: [X](/facts/x.md)');
  });
});

describe('conceptTitle', () => {
  it('uses the frontmatter title, or derives one from the filename', () => {
    expect(conceptTitle('memory/facts/onboarding.md', { title: 'Onboarding' })).toBe('Onboarding');
    expect(conceptTitle('memory/facts/onboarding.md', {})).toBe('onboarding');
    expect(conceptTitle('memory/facts/2026-10-03.md', {})).toBe('2026 10 03');
    expect(conceptTitle('memory/facts/vendor_terms.md', {})).toBe('vendor terms');
  });
});

describe('MemoryConceptSummary', () => {
  it('parses the row shape the table and the fill share', () => {
    const summary = MemoryConceptSummary.parse({
      path: 'memory/facts/onboarding.md',
      type: 'Fact',
      title: 'Onboarding',
      description: null,
      tags: ['people'],
      status: 'stable',
      staleAfter: null,
      trustTier: 'human-reviewed',
      origin: 'journal',
      shareNever: false,
      fromTeam: null,
      blobSha: 'a'.repeat(40),
      generatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(summary.trustTier).toBe('human-reviewed');
    expect(() => MemoryConceptSummary.parse({ ...summary, trustTier: 'human_reviewed' })).toThrow();
    expect(() => MemoryConceptSummary.parse({ ...summary, status: 'archived' })).toThrow();
  });
});
