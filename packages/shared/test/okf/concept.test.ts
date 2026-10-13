import { describe, expect, it } from 'vitest';
import {
  OKF_FRONTMATTER_MAX_BYTES,
  OKF_VERSION,
  isConceptPath,
  isStale,
  parseConcept,
  renderBundleIndex,
  renderBundleLog,
  serializeConcept,
  splitConcept,
  trustTier,
} from '../../src/okf/index.ts';

// The minimum of OKF that P5-14 needs (P5-24 extends this file's module in place: the full parser tests, the spec's own bundle and the forty
// hostile inputs are P5-24's). What is pinned here is the contract of the parts that must never regress: a concept needs a `type`, aliases and
// anchors are refused, the frontmatter is capped before a parser sees it, and every input is handled in linear time.

const concept = (frontmatter: string, body = 'The body.\n'): string => `---\n${frontmatter}\n---\n\n${body}`;

describe('parseConcept', () => {
  it('reads the frontmatter and keeps the body untouched', () => {
    const r = parseConcept(concept('type: Decision\ntitle: Use Postgres\ntags: [db, infra]\nstatus: stable', '# Use Postgres\n\nBecause.\n'));
    expect(r).toMatchObject({ ok: true, frontmatter: { type: 'Decision', title: 'Use Postgres', tags: ['db', 'infra'], status: 'stable' }, body: '\n# Use Postgres\n\nBecause.\n' });
  });

  it('keeps extension keys (OKF §4.1: unknown keys and types are fine)', () => {
    const r = parseConcept(concept('type: Whatever\nacme_score: 7\nsources:\n  - memory/references/a.md'));
    expect(r).toMatchObject({ ok: true, frontmatter: { type: 'Whatever', acme_score: 7, sources: ['memory/references/a.md'] } });
  });

  it.each([
    ['no frontmatter at all', '# Just a page\n'],
    ['a frontmatter that never closes', '---\ntype: Fact\nbody'],
    ['a frontmatter with no type', concept('title: No type here')],
    ['an empty type', concept('type: ""')],
    ['a blank type', concept('type: "   "')],
    ['a frontmatter that is a list', concept('- a\n- b')],
    ['an empty frontmatter', '---\n---\nbody'],
    ['a status that is not one of the three', concept('type: Fact\nstatus: archived')],
    ['tags that are not a list', concept('type: Fact\ntags: one')],
    ['duplicate keys', concept('type: Fact\ntype: Decision')],
    ['broken YAML', concept('type: [unclosed')],
  ])('refuses %s, with a reason', (_what, text) => {
    const r = parseConcept(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
  });

  it('names the missing type in words', () => {
    const r = parseConcept(concept('title: x'));
    expect(r).toEqual({ ok: false, reason: 'the frontmatter has no `type`' });
  });

  it('refuses a YAML alias and a YAML anchor, used or not', () => {
    // an alias needs an anchor, and the traversal meets the anchor first: either word is the refusal
    expect(parseConcept(concept('type: Fact\na: &x 1\nb: *x'))).toMatchObject({ ok: false, reason: expect.stringMatching(/alias|anchor/) });
    expect(parseConcept(concept('type: Fact\na: &unused 1'))).toMatchObject({ ok: false, reason: expect.stringContaining('anchor') });
  });

  it('reads a bare `verified` mapping as a one-element list', () => {
    const r = parseConcept(concept('type: Fact\nverified:\n  by: human:abc\n  at: 2026-10-01'));
    expect(r).toMatchObject({ ok: true, frontmatter: { verified: [{ by: 'human:abc', at: '2026-10-01' }] } });
  });

  it('accepts a byte-order mark and CRLF line ends', () => {
    expect(parseConcept(`${String.fromCharCode(0xfeff)}---\r\ntype: Fact\r\n---\r\nbody\r\n`)).toMatchObject({ ok: true, frontmatter: { type: 'Fact' } });
  });
});

describe('splitConcept', () => {
  it('refuses a frontmatter larger than the cap before anything parses it', () => {
    const big = `---\ntype: Fact\nnote: ${'x'.repeat(OKF_FRONTMATTER_MAX_BYTES + 10)}\n---\nbody`;
    expect(splitConcept(big)).toMatchObject({ ok: false, reason: expect.stringContaining('larger than') });
    expect(parseConcept(big).ok).toBe(false);
    // ... and one that never closes costs a bounded scan, not the whole file
    expect(splitConcept(`---\n${'y: 1\n'.repeat(100_000)}`).ok).toBe(false);
  });

  it('takes the first closing fence', () => {
    expect(splitConcept('---\ntype: A\n---\nfirst\n---\nsecond')).toEqual({ ok: true, frontmatter: 'type: A\n', body: 'first\n---\nsecond' });
  });
});

describe('hostile input is linear', () => {
  const timed = (text: string): number => {
    const t = Date.now();
    parseConcept(text);
    return Date.now() - t;
  };
  it.each([
    ['nested flow sequences', `---\ntype: Fact\nx: ${'['.repeat(30_000)}\n---\n`],
    ['nested flow mappings', `---\ntype: Fact\nx: ${'{a: '.repeat(10_000)}\n---\n`],
    ['a long run of anchors', `---\ntype: Fact\n${'a: &x 1\n'.repeat(5_000)}---\n`],
    ['a billion-laughs shape', `---\ntype: Fact\na: &a [x, x]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\ne: &e [*d, *d]\nf: [*e, *e]\n---\n`],
    ['many keys', `---\ntype: Fact\n${Array.from({ length: 4_000 }, (_, i) => `k${i}: v${i}`).join('\n')}\n---\n`],
    ['a long quoted string', `---\ntype: Fact\nnote: "${'a\\"'.repeat(15_000)}"\n---\n`],
    ['a huge body', `---\ntype: Fact\n---\n${'# heading\n\n'.repeat(100_000)}`],
  ])('%s is handled in well under a second', (_what, text) => {
    expect(timed(text)).toBeLessThan(500);
  });
});

describe('serializeConcept', () => {
  it('is read back by parseConcept', () => {
    const text = serializeConcept({ type: 'Journal', title: 'Journal 2026-10-12', generated: { by: 'process:journal', at: '2026-10-13T03:00:00.000Z' }, origin: 'journal', tags: ['journal'] }, '# Journal\n\nBody.');
    const r = parseConcept(text);
    expect(r).toMatchObject({ ok: true, frontmatter: { type: 'Journal', generated: { by: 'process:journal' }, origin: 'journal', tags: ['journal'] } });
    expect(text.endsWith('Body.\n')).toBe(true);
  });

  it('quotes what YAML would misread', () => {
    const r = parseConcept(serializeConcept({ type: 'Fact', title: 'yes: no # maybe', description: '0.2' }, 'x'));
    expect(r).toMatchObject({ ok: true, frontmatter: { title: 'yes: no # maybe', description: '0.2' } });
  });
});

describe('trust and staleness', () => {
  it('tiers (SPEC §12.1)', () => {
    expect(trustTier({})).toBe('unverified');
    expect(trustTier({ verified: [] })).toBe('unverified');
    expect(trustTier({ verified: [{ by: 'archivist/smart' }] })).toBe('machine-confirmed');
    expect(trustTier({ verified: [{ by: 'archivist/smart' }, { by: 'human:7' }] })).toBe('human-reviewed');
  });

  it('is stale once stale_after has been reached, never for a date nobody can read', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    expect(isStale({}, now)).toBe(false);
    expect(isStale({ stale_after: '2026-10-13' }, now)).toBe(true);
    expect(isStale({ stale_after: '2026-10-14' }, now)).toBe(false);
    expect(isStale({ stale_after: 'soon' }, now)).toBe(false);
  });
});

describe('the bundle root', () => {
  it('index.md carries okf_version and nothing else in its frontmatter', () => {
    const text = renderBundleIndex();
    expect(text.startsWith(`---\nokf_version: "${OKF_VERSION}"\n---\n`)).toBe(true);
    const split = splitConcept(text);
    expect(split.ok && split.frontmatter).toBe(`okf_version: "${OKF_VERSION}"\n`);
  });

  it('log.md groups by date, newest first', () => {
    const text = renderBundleLog([
      { date: '2026-10-11', text: 'older' },
      { date: '2026-10-13', text: 'newest' },
      { date: '2026-10-13', text: 'second\nline' },
    ]);
    expect(text).toBe('# Memory log\n\n## 2026-10-13\n\n- newest\n- second line\n\n## 2026-10-11\n\n- older\n');
  });
});

describe('isConceptPath', () => {
  it.each([
    ['memory/facts/deploys.md', true],
    ['memory/journal/2026-10-12.md', true],
    ['memory/shared/design/digest.md', true],
    ['memory/index.md', false],
    ['memory/facts/index.md', false],
    ['memory/log.md', false],
    ['memory/facts/.gitkeep', false],
    ['memory/facts/data.csv', false],
    ['pages/memory/x.md', false],
    ['memory.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(isConceptPath(path)).toBe(expected);
  });
});
