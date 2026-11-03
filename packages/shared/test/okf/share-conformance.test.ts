import { describe, expect, it } from 'vitest';
import { OKF_BUNDLE_MAX_FILES, checkOkfBundle, hasReferencesLink, pointsIntoReferences, renderBundleLog, serializeConcept, stripReferenceLinks } from '../../src/index.ts';
import { expectLinear } from '../../../test-utils/src/linear.ts';

// The OKF bundle check the memory-share plugin runs on a digest (P8-23) and the receiving side will run on one it is handed (P8-25): built from the P5-24 parsers.

const index = serializeConcept({ okf_version: '0.2' }, '# Digest');
const log = renderBundleLog([{ date: '2026-11-02', text: 'Digest from Engineering' }]);
const digest = (over: Record<string, unknown> = {}, body = 'One thing changed [^s1]\n\n[^s1]: decisions/a.md'): string =>
  serializeConcept({ type: 'Digest', title: 'D', from: 'x', sources: [{ id: 's1', resource: 'decisions/a.md' }], ...over }, body);
const copy = (over: Record<string, unknown> = {}, body = 'Body'): string =>
  serializeConcept({ type: 'Decision', title: 'A', sources: [{ resource: 'team:eng:/decisions/a.md' }], origin_trust: 'unverified', ...over }, body);
const good = (): Record<string, string> => ({ 'index.md': index, 'log.md': log, 'digest.md': digest(), 'decisions/a.md': copy() });
const problems = (files: Record<string, string>, digestMode = true): string[] => checkOkfBundle(files, { digest: digestMode }).problems.map((p) => `${p.path}: ${p.message}`);
const withoutFile = (files: Record<string, string>, name: string): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([k]) => k !== name));

describe('checkOkfBundle', () => {
  it('accepts a well-formed digest', () => {
    expect(checkOkfBundle(good(), { digest: true })).toEqual({ ok: true, problems: [] });
  });

  it('accepts the same bundle as a plain OKF bundle (no digest rules)', () => {
    expect(checkOkfBundle(good()).ok).toBe(true);
  });

  it('wants an index.md with okf_version and nothing else', () => {
    expect(problems({ ...good(), 'index.md': serializeConcept({ okf_version: '0.2', title: 'x' }, 'x') })).toEqual([expect.stringContaining('index.md: the root index.md must have okf_version')]);
    expect(problems({ ...good(), 'index.md': serializeConcept({ okf_version: '0.1' }, 'x') })).toEqual([expect.stringContaining('okf_version must be "0.2"')]);
    expect(problems(withoutFile(good(), 'index.md'))).toEqual([expect.stringContaining('no index.md')]);
  });

  it('wants a log.md with a dated entry', () => {
    expect(problems({ ...good(), 'log.md': '# Memory log\n\nnothing\n' })).toEqual([expect.stringContaining('no dated entry')]);
    expect(problems(withoutFile(good(), 'log.md'))).toEqual([expect.stringContaining('no log.md')]);
  });

  it('refuses a concept that does not parse', () => {
    expect(problems({ ...good(), 'decisions/a.md': 'no frontmatter here' })).toEqual([expect.stringContaining('decisions/a.md: the file does not open with a --- frontmatter line')]);
  });

  it.each([
    ['a path that climbs', '../a.md'],
    ['an absolute path', '/a.md'],
    ['a backslash', 'a\\b.md'],
    ['a file that is not Markdown', 'a.txt'],
    ['an empty part', 'a//b.md'],
    ['a control character', 'a\u0007.md'],
  ])('refuses %s as a path', (_label, path) => {
    expect(checkOkfBundle({ ...good(), [path]: copy() }, { digest: true }).ok).toBe(false);
  });

  it('refuses two files that differ only in case, and a NUL character', () => {
    expect(problems({ ...good(), 'Decisions/A.md': copy(), 'decisions/a.MD': copy() }).join('\n')).toContain('differ only in upper and lower case');
    expect(problems({ ...good(), 'decisions/a.md': `${copy()}\0` }).join('\n')).toContain('NUL');
  });

  it('refuses too many files and too many bytes', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= OKF_BUNDLE_MAX_FILES; i += 1) many[`c/${i}.md`] = copy();
    expect(checkOkfBundle(many).problems[0]?.message).toContain('the most is');
    expect(checkOkfBundle(good(), { maxBytes: 100 }).problems[0]?.message).toContain('the most is 100');
  });

  describe('as a digest', () => {
    it('wants a digest.md of type Digest', () => {
      expect(problems(withoutFile(good(), 'digest.md'))).toEqual([expect.stringContaining('no digest.md')]);
      expect(problems({ ...good(), 'digest.md': digest({ type: 'Summary' }) })).toEqual([expect.stringContaining('must have type: Digest')]);
    });

    it('wants every footnote to have a source and every source a footnote', () => {
      expect(problems({ ...good(), 'digest.md': digest({}, 'Claim [^s9]\n\n[^s1]: x') }).join('\n')).toContain('the footnote [^s9] has no source');
      expect(problems({ ...good(), 'digest.md': digest({}, 'Claim with no note') }).join('\n')).toContain('the source "s1" has no footnote');
      expect(problems({ ...good(), 'digest.md': digest({ sources: [{ id: 's1', resource: 'a.md' }, { id: 's1', resource: 'b.md' }] }) }).join('\n')).toContain('share the id "s1"');
      expect(problems({ ...good(), 'digest.md': digest({ sources: [{ resource: 'a.md' }] }) }).join('\n')).toContain('needs an id');
    });

    it('refuses a copy that carries verified, more than one source, or a way into references/', () => {
      expect(problems({ ...good(), 'decisions/a.md': copy({ verified: [{ by: 'human:x' }] }) }).join('\n')).toContain('trust does not travel');
      expect(problems({ ...good(), 'decisions/a.md': copy({ sources: [{ resource: 'a' }, { resource: 'b' }] }) }).join('\n')).toContain('at most one source');
      expect(problems({ ...good(), 'decisions/a.md': copy({ sources: [{ resource: 'references/q3.md' }] }) }).join('\n')).toContain('references/');
      expect(problems({ ...good(), 'decisions/a.md': copy({ resource: 'team:eng:/references/q3.md' }) }).join('\n')).toContain('references/');
      expect(problems({ ...good(), 'decisions/a.md': copy({}, 'See [the original](/references/q3.md).') }).join('\n')).toContain('references/');
      expect(problems({ ...good(), 'decisions/a.md': copy({}, 'See [the original](../references/q3.md).') }).join('\n')).toContain('references/');
    });

    it('does not apply those rules to a plain bundle', () => {
      expect(checkOkfBundle({ ...good(), 'decisions/a.md': copy({ verified: [{ by: 'human:x' }] }) }).ok).toBe(true);
    });
  });

  it('reads footnote marks the way it always did (and a run of "[^" does not take a second per 80 KB)', () => {
    const start = Date.now();
    expect(problems({ ...good(), 'digest.md': digest({}, `Claim [^s1]${'[^'.repeat(40_000)}\n\n[^s1]: a`) })).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(problems({ ...good(), 'digest.md': digest({}, 'a [^s1] b [^s2] [^[^s3] [^ x]\n\n[^s1]: a') }).join('\n')).toContain('the footnote [^s2] has no source');
  });

  it.each([
    ['inline', '[a](/references/a.md)'],
    ['an address in angle brackets with a space', '[a](<../references/a b.pdf>)'],
    ['a memory/ prefix', '[a](/memory/references/a.md)'],
    ['a .. part in the middle', '[a](decisions/../references/a.pdf)'],
    ['percent-encoded dots', '[a](%2e%2e/references/a.pdf)'],
    ['percent-encoded twice', '[a](%252e%252e/references/a.pdf)'],
    ['upper case', '[a](References/a.pdf)'],
    ['a backslash', '[a](..\\references\\a.pdf)'],
    ['an image', '![a](../references/a.png "title")'],
    ['an HTML href', '<a href="../references/a.pdf">a</a>'],
    ['an HTML src in single quotes', "<img src='/references/a.png'>"],
    ['an HTML href without quotes', '<a href=/references/a.pdf>a</a>'],
    ['a definition', '[a][1]\n\n[1]: /references/a.pdf'],
    ['a definition in angle brackets', '[a][1]\n\n[1]: <../references/a b.pdf>'],
  ])('refuses and removes a way into references/: %s', (_label, text) => {
    expect(hasReferencesLink(text)).toBe(true);
    expect(problems({ ...good(), 'decisions/a.md': copy({}, text) }).join('\n')).toContain('references/');
    const stripped = stripReferenceLinks(text);
    expect(hasReferencesLink(stripped)).toBe(false);
    expect(stripped.toLowerCase()).not.toContain('references');
  });

  it('keeps links that are not into references/', () => {
    for (const text of ['[a](/decisions/a.md)', '[web](https://example.com/references/x)', '[mail](mailto:a@b.co)', '[a](//cdn.example.com/references/x.js)', '<a href="/decisions/a.md">a</a>']) {
      expect(hasReferencesLink(text), text).toBe(false);
      expect(stripReferenceLinks(text)).toBe(text);
    }
    expect(pointsIntoReferences('team:eng:/references/q3.md')).toBe(true);
    expect(pointsIntoReferences('team:eng:/decisions/a.md')).toBe(false);
  });

  it('knows a link into references/ when it sees one', () => {
    expect(hasReferencesLink('x [a](/references/a.md) y')).toBe(true);
    expect(hasReferencesLink('x [a](memory/references/a.md) y')).toBe(true);
    expect(hasReferencesLink('x [a](/decisions/a.md) and https://example.com/references/ y')).toBe(false);
  });

  it('costs time in proportion to the input, whatever the input is made of', () => {
    const shapes: Record<string, (n: number) => Record<string, string>> = {
      'unclosed brackets': (n) => ({ ...good(), 'decisions/a.md': copy({}, '['.repeat(n)) }),
      'footnote marks': (n) => ({ ...good(), 'digest.md': digest({}, `[^s1]${' [^x'.repeat(n)}\n\n[^s1]: a`) }),
      'many links': (n) => ({ ...good(), 'decisions/a.md': copy({}, '[a](b) '.repeat(n)) }),
      'footnote openers that never close': (n) => ({ ...good(), 'digest.md': digest({}, `[^s1] ${'[^'.repeat(n)}\n\n[^s1]: a`) }),
      'open links': (n) => ({ ...good(), 'decisions/a.md': copy({}, '](<'.repeat(n)) }),
      'html attributes': (n) => ({ ...good(), 'decisions/a.md': copy({}, 'href="'.repeat(n)) }),
    };
    for (const [name, build] of Object.entries(shapes)) expectLinear(build, (files) => checkOkfBundle(files, { digest: true }), { n: 16_000, label: name });
  });
});
