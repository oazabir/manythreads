import { describe, expect, it } from 'vitest';
import { checkOkfBundle, parseConcept, parseLog, serializeConcept, splitConcept } from '@manythreads/shared';
import { expectLinear } from '../../../test-utils/src/linear.ts';
import { buildDigest, oneLine, stripReferenceLinks, type DigestItem, type DigestInput } from '../src/digest.ts';
import type { SelectableConcept } from '../src/selection.ts';

// The digest builder (PLAN P8-23): pure, so the bundle is checked against the P5-24 parsers here without a database.

const TEAM = { id: '0190a000-0000-7000-8000-000000000002', slug: 'engineering', name: 'Engineering' };
let n = 0;
const concept = (path: string, over: Partial<SelectableConcept> = {}): SelectableConcept => {
  n += 1;
  return { path: `memory/${path}`, type: 'Decision', title: path, description: 'Why we did it', tags: [], status: 'stable', staleAfter: null, trustTier: 'unverified', origin: '', shareNever: false, blobSha: String(n).padStart(40, '0'), generatedAt: null, ...over };
};
const file = (fm: Record<string, unknown>, body: string): DigestItem['file'] => {
  const parsed = parseConcept(serializeConcept({ type: 'Decision', ...fm }, body));
  if (!parsed.ok) throw new Error(parsed.reason);
  return { frontmatter: parsed.frontmatter, body: parsed.body };
};
const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  team: TEAM,
  share: { slug: 'release-notes', name: 'Release notes' },
  mode: 'summary',
  period: '2026-11-02',
  since: null,
  included: [],
  retired: [],
  ...over,
});

describe('the digest bundle', () => {
  const a = concept('decisions/a.md', { title: 'Ship on Tuesdays', generatedAt: new Date('2026-10-30T10:00:00Z') });
  const b = concept('playbooks/b.md', { title: 'Rollback', description: null });

  it('a summary is index.md, log.md and digest.md, and conforms', () => {
    const built = buildDigest(input({ included: [{ concept: a, change: 'added' }, { concept: b, change: 'changed' }] }));
    expect(Object.keys(built.files).sort()).toEqual(['digest.md', 'index.md', 'log.md']);
    expect(checkOkfBundle(built.files, { digest: true })).toEqual({ ok: true, problems: [] });
  });

  it('the index carries okf_version and nothing else; the log has one dated entry', () => {
    const built = buildDigest(input({ included: [{ concept: a, change: 'added' }] }));
    const index = splitConcept(built.files['index.md']!);
    expect(index.ok && index.frontmatter).toBe('okf_version: "0.2"\n');
    expect(parseLog(built.files['log.md']!)).toEqual([{ date: '2026-11-02', text: 'Digest from Engineering: 1 new, 0 updated, 0 retired.' }]);
  });

  it('digest.md is type Digest with from, to, share, period, a source per concept and a footnote for each', () => {
    const built = buildDigest(input({ since: '2026-10-26', included: [{ concept: a, change: 'added' }, { concept: b, change: 'changed' }] }));
    const digest = parseConcept(built.files['digest.md']!);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    const fm = digest.frontmatter;
    expect(fm.type).toBe('Digest');
    expect(fm['from']).toBe(TEAM.id);
    // one digest goes to every accepted team, so it names none of them: who else gets it is not the recipient's to know
    expect(fm['to']).toBeUndefined();
    expect(fm['share']).toBe('release-notes');
    expect(fm['period']).toEqual({ from: '2026-10-26', to: '2026-11-02' });
    expect(fm.generated?.by).toBe('memory-share/0.1');
    expect(fm.sources).toEqual([
      { id: 's1', resource: 'decisions/a.md', title: 'Ship on Tuesdays', last_modified: '2026-10-30T10:00:00.000Z' },
      { id: 's2', resource: 'playbooks/b.md', title: 'Rollback' },
    ]);
    expect(digest.body).toContain('Ship on Tuesdays: Why we did it [^s1]');
    expect(digest.body).toContain('## New');
    expect(digest.body).toContain('## Updated');
    expect(digest.body).toContain('[^s2]: playbooks/b.md');
  });

  it('is the same bytes and the same fingerprint for the same selection, a different one for different content', () => {
    const one = buildDigest(input({ included: [{ concept: a, change: 'added' }] }));
    const again = buildDigest(input({ included: [{ concept: a, change: 'added' }] }));
    const other = buildDigest(input({ included: [{ concept: b, change: 'added' }] }));
    expect(again).toEqual(one);
    expect(other.sha).not.toBe(one.sha);
    expect(one.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names retired concepts in the summary', () => {
    const built = buildDigest(input({ included: [{ concept: a, change: 'added' }], retired: [b] }));
    expect(built.files['digest.md']).toContain('## Retired');
    expect(built.files['digest.md']).toContain('playbooks/b: Engineering has retired this concept.');
    expect(checkOkfBundle(built.files, { digest: true }).ok).toBe(true);
  });

  it('keeps a title or a description from forging a footnote or a heading', () => {
    const sneaky = concept('x.md', { title: 'Hello [^s9]\n# Injected', description: 'a\u0000b [^s8]' });
    const built = buildDigest(input({ included: [{ concept: sneaky, change: 'added' }] }));
    expect(checkOkfBundle(built.files, { digest: true })).toEqual({ ok: true, problems: [] });
    expect(built.files['digest.md']).not.toMatch(/^# Injected/m);
  });
});

describe('full mode', () => {
  const a = concept('decisions/a.md', { title: 'Ship on Tuesdays', trustTier: 'human-reviewed' });
  const withFile = (c: SelectableConcept, fm: Record<string, unknown>, body: string): DigestItem => ({ concept: c, change: 'added', file: file(fm, body) });

  it('copies the concept at its own path with one origin source and origin_trust in place of verified', () => {
    const item = withFile(
      a,
      {
        title: 'Ship on Tuesdays',
        description: 'Why',
        tags: ['release'],
        resource: 'https://example.com/rfc',
        status: 'stable',
        stale_after: '2027-01-01',
        sources: [{ resource: 'references/q3-planning.md' }, { resource: 'https://wiki/x' }],
        verified: [{ by: 'human:alice', at: '2026-10-01' }],
        origin: 'drop',
        generated: { by: 'process:inbox' },
      },
      'We ship on Tuesdays.',
    );
    const built = buildDigest(input({ mode: 'full', included: [item] }));
    expect(Object.keys(built.files).sort()).toEqual(['decisions/a.md', 'digest.md', 'index.md', 'log.md']);
    const copy = parseConcept(built.files['decisions/a.md']!);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const fm = copy.frontmatter;
    expect(fm.type).toBe('Decision');
    expect(fm.title).toBe('Ship on Tuesdays');
    expect(fm.description).toBe('Why');
    expect(fm.tags).toEqual(['release']);
    expect(fm['resource']).toBe('https://example.com/rfc');
    expect(fm.status).toBe('stable');
    expect(fm.stale_after).toBe('2027-01-01');
    expect(fm.sources).toEqual([{ resource: 'team:engineering:/decisions/a.md', title: 'Ship on Tuesdays' }]);
    expect(fm['origin_trust']).toBe('human-reviewed');
    expect(fm.verified).toBeUndefined();
    expect(fm.origin).toBeUndefined();
    expect(fm.generated).toBeUndefined();
    expect(copy.body.trim()).toBe('We ship on Tuesdays.');
    expect(checkOkfBundle(built.files, { digest: true })).toEqual({ ok: true, problems: [] });
  });

  it('takes out links into references/ and a resource that points at an original', () => {
    const item = withFile(
      a,
      { resource: 'inbox/filed/2026-10/abc-q3.pdf' },
      [
        'See [the planning doc](../references/q3-planning.md) and ![chart](/references/chart.md) and [another](../references/z.md "title").',
        'Keep [this one](/decisions/other.md) and [the web](https://example.com/references/x).',
        '',
        '[ref]: /references/q3.md',
      ].join('\n'),
    );
    const built = buildDigest(input({ mode: 'full', included: [item] }));
    const copy = parseConcept(built.files['decisions/a.md']!);
    if (!copy.ok) throw new Error(copy.reason);
    expect(copy.frontmatter['resource']).toBeUndefined();
    expect(copy.body).toContain('See the planning doc and chart and another.');
    expect(copy.body).toContain('[this one](/decisions/other.md)');
    expect(copy.body).toContain('https://example.com/references/x');
    expect(copy.body).not.toMatch(/references\/q3|\[ref\]/);
    expect(checkOkfBundle(built.files, { digest: true }).ok).toBe(true);
  });

  it.each([
    ['an address in angle brackets with a space', 'See [a](<../references/a b.pdf>).'],
    ['a memory/ prefix', 'See [a](/memory/references/a.md).'],
    ['a .. part in the middle', 'See [a](decisions/../references/a.pdf).'],
    ['percent-encoded dots', 'See [a](%2e%2e/references/a.pdf).'],
    ['percent-encoded twice', 'See [a](%252e%252e/references/a.pdf).'],
    ['upper case', 'See [a](References/a.pdf).'],
    ['a backslash', 'See [a](..\\references\\a.pdf).'],
    ['an HTML link', 'See <a href="../references/a.pdf">a</a>.'],
    ['an HTML image in single quotes', "See <img src='/references/a.png'>."],
    ['an angle-bracket definition', 'See [a][1].\n\n[1]: <../references/a b.pdf>'],
  ])('takes out a link into references/ however it is written: %s', (_label, text) => {
    const item = withFile(a, {}, text);
    const built = buildDigest(input({ mode: 'full', included: [item] }));
    const copy = built.files['decisions/a.md']!;
    expect(copy).not.toMatch(/references/i);
    expect(checkOkfBundle(built.files, { digest: true }).ok).toBe(true);
  });

  it('turns relative links to other concepts into bundle-absolute ones', () => {
    const item = withFile(a, {}, 'Also [the playbook](../playbooks/b.md).');
    const built = buildDigest(input({ mode: 'full', included: [item] }));
    expect(built.files['decisions/a.md']).toContain('[the playbook](/playbooks/b.md)');
  });

  it('a retired concept goes as a short notice with no content', () => {
    const gone = concept('decisions/old.md', { title: 'Old rule is now private', status: 'deprecated', trustTier: 'machine-confirmed', tags: ['internal'], type: 'Decision' });
    const built = buildDigest(input({ mode: 'full', included: [withFile(a, {}, 'x')], retired: [gone] }));
    const notice = parseConcept(built.files['decisions/old.md']!);
    if (!notice.ok) throw new Error(notice.reason);
    expect(notice.frontmatter.status).toBe('deprecated');
    // only what an earlier digest carried: the path-derived name, never today's title, type, tags or trust
    expect(notice.frontmatter.title).toBe('decisions/old');
    expect(notice.frontmatter.type).toBe('Retired');
    expect(notice.frontmatter['origin_trust']).toBeUndefined();
    expect(notice.frontmatter.tags).toBeUndefined();
    expect(notice.body).toContain('Engineering has retired this concept');
    expect(JSON.stringify(built.files)).not.toContain('Old rule is now private');
    expect(checkOkfBundle(built.files, { digest: true }).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('oneLine flattens, cuts and defuses footnote marks', () => {
    expect(oneLine('a\n\nb\t c', 50)).toBe('a b c');
    expect(oneLine('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine('see [^1]', 50)).toBe('see [\\^1]');
  });

  it('stripReferenceLinks costs time in proportion to the input', () => {
    const shapes: Record<string, (k: number) => string> = {
      'open brackets then one link': (k) => `${'['.repeat(k)}](/references/x.md)`,
      'many reference links': (k) => '[a](/references/x.md) '.repeat(k),
      'link labels that never close': (k) => '[a '.repeat(k) + '](/references/x.md)',
      'angle brackets that never close': (k) => '](<'.repeat(k),
      'html attributes that never close': (k) => 'href="'.repeat(k) + ' src=\'x'.repeat(k),
    };
    for (const [name, build] of Object.entries(shapes)) expectLinear(build, (text) => stripReferenceLinks(text), { n: 20_000, label: name });
  });
});
