import { describe, expect, it } from 'vitest';
import { toPlainText } from '../../src/index.ts';
import { expectLinear } from '../../../test-utils/src/linear.ts';

describe('toPlainText', () => {
  it('returns plain text unchanged', () => {
    expect(toPlainText('just words, 2 * 3 = 6')).toBe('just words, 2 * 3 = 6');
    expect(toPlainText('')).toBe('');
  });

  it('strips heading markers, including closing hashes', () => {
    expect(toPlainText('# Title\n## Sub ##\n###### Deep')).toBe('Title\nSub\nDeep');
    expect(toPlainText('Title\n=====\nSub\n-----')).toBe('Title\nSub');
  });

  it('keeps a hash that is not a heading', () => {
    expect(toPlainText(`#general and C# and ${'#'}123`)).toBe(`#general and C# and ${'#'}123`);
    expect(toPlainText('# C#')).toBe('C#');
  });

  it('strips emphasis, strong, strike and combinations', () => {
    expect(toPlainText('*a* **b** ***c*** _d_ __e__ ~~f~~ **bold _and_ more**')).toBe('a b c d e f bold and more');
  });

  it('keeps snake_case, stars used as math and lone markers', () => {
    expect(toPlainText('snake_case_name and 2*3*4 and a * b * c')).toBe('snake_case_name and 2*3*4 and a * b * c');
  });

  it('keeps globs and intraword stars', () => {
    expect(toPlainText('match *.ts and *.js, 2*3 and a*b')).toBe('match *.ts and *.js, 2*3 and a*b');
  });

  it('keeps link and image text and drops targets', () => {
    expect(toPlainText('[docs](https://x.com/a_(b) "Title") and ![logo](a.png) and [ref][1]\n\n[1]: https://x.com')).toBe(
      'docs and logo and ref',
    );
  });

  it('keeps autolinks and bare URLs', () => {
    expect(toPlainText('<https://x.com/a> https://y.com/b <omar@kahf.co>')).toBe('https://x.com/a https://y.com/b omar@kahf.co');
  });

  it('keeps inline code verbatim', () => {
    expect(toPlainText('run `**not bold** [x](y) #h` now')).toBe('run **not bold** [x](y) #h now');
  });

  it('keeps fenced code verbatim and drops the fences', () => {
    expect(toPlainText('before\n```ts\nconst a = *b* # c\n  indented\n```\nafter')).toBe('before\nconst a = *b* # c\n  indented\nafter');
    expect(toPlainText('~~~\n# not heading\n~~~')).toBe('# not heading');
  });

  it('keeps an unclosed fence as code', () => {
    expect(toPlainText('```\n**x**')).toBe('**x**');
  });

  it('strips quote and list markers', () => {
    expect(toPlainText('> quoted\n>> deeper\n- one\n* two\n+ three\n1. four\n2) five\n- [x] done\n- [ ] todo')).toBe(
      'quoted\ndeeper\none\ntwo\nthree\nfour\nfive\ndone\ntodo',
    );
  });

  it('drops horizontal rules', () => {
    expect(toPlainText('a\n\n---\n\nb\n***\n___')).toBe('a\n\nb');
  });

  it('flattens tables', () => {
    expect(toPlainText('| a | b |\n|---|:-:|\n| 1 | 2 |')).toBe('a  b\n1  2');
  });

  it('keeps mentions, channels and entity refs as typed', () => {
    expect(toPlainText('hi @omar in #releases see [[page:notes/a_b_c.md]] and [[task:42]]')).toBe(
      'hi @omar in #releases see [[page:notes/a_b_c.md]] and [[task:42]]',
    );
  });

  it('unescapes escaped punctuation', () => {
    expect(toPlainText('\\*not emphasis\\* \\# \\[x\\](y) \\_a\\_')).toBe('*not emphasis* # [x](y) _a_');
  });

  it('strips known inline html but keeps other angle text', () => {
    expect(toPlainText('a <b>bold</b><br/>x <span class="y">z</span> and 1 < 2 > 0, <unknown>')).toBe('a boldx z and 1 < 2 > 0, <unknown>');
  });

  it('drops hard-break markers and collapses blank runs', () => {
    expect(toPlainText('a  \nb\\\nc\n\n\n\nd')).toBe('a\nb\nc\n\nd');
  });

  it('normalises CRLF and trims', () => {
    expect(toPlainText('\r\n  a\r\nb  \r\n')).toBe('a\nb');
  });

  it('keeps unicode and emoji', () => {
    expect(toPlainText('**مرحبا** 😀 _zoë_')).toBe('مرحبا 😀 zoë');
  });

  it('is not confused by input holding private-use characters', () => {
    expect(toPlainText('a0 `c`')).toBe('a0 c');
  });

  it('never throws on awkward input', () => {
    for (const s of ['`', '```', '[[', '](', '![', '**', '__', '~~', '>', '|', '\\', '<', '[x]:']) {
      expect(() => toPlainText(s)).not.toThrow();
    }
  });

  it('keeps a bare [[text]] as typed and typed entity refs verbatim (the canonical text; channels used to drop the brackets)', () => {
    expect(toPlainText('see [[x]] and [[Deploy plan]]')).toBe('see [[x]] and [[Deploy plan]]');
    expect(toPlainText('[[thread:3f2a]] [[file:abc]]')).toBe('[[thread:3f2a]] [[file:abc]]');
  });

  it('turns a linked image into its alt text, and keeps line breaks', () => {
    expect(toPlainText('[![logo](a.png)](https://x.example) done\nnext **line**')).toBe('logo done\nnext line');
  });

  it('matches what a chat composer produces for the former channels cases', () => {
    expect(toPlainText('**Merged** `rollback` plan, see [runbook](https://x.example)')).toBe('Merged rollback plan, see runbook');
    expect(toPlainText('```sh\nkubectl rollout undo\n```\nthen check')).toBe('kubectl rollout undo\nthen check');
    expect(toPlainText('# Heading\n> quoted\n- one\n- two\n1. three')).toBe('Heading\nquoted\none\ntwo\nthree');
  });
});

describe('toPlainText on hostile input', () => {
  // Each construction is a builder of any size, so the same hostile shape is timed at n and at 4n: the claim is linear cost (the ratio), with a
  // generous ceiling for a real blow-up, not a flat millisecond limit that measures the machine (three workers beside it read 150 ms vs 50).
  const N = 40_000;
  const repeat = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const hostile: Record<string, (n: number) => string> = {
    'open brackets': (n) => repeat('[', n),
    'nested brackets': (n) => repeat('[[', n) + repeat(']]', n).slice(0, n / 2),
    'unclosed labels': (n) => repeat('[a', n),
    'link starts': (n) => repeat('[a](', n),
    'chained destinations': (n) => repeat('[a]((x)', n),
    'image starts': (n) => repeat('![a](', n),
    'titles without end': (n) => repeat('[a](x "t ', n),
    'reference starts': (n) => repeat('[a][b', n),
    backticks: (n) => repeat('`', n),
    'backtick pairs': (n) => repeat('` ``', n),
    'growing backtick runs': (n) => Array.from({ length: 900 }, (_, i) => '`'.repeat(i + 1)).join(' ').slice(0, n),
    'open fences': (n) => repeat('```\n', n),
    stars: (n) => repeat('*', n),
    'star openers': (n) => repeat('*a ', n),
    'star closers': (n) => repeat('a* ', n),
    'mixed stars and underscores': (n) => repeat('*_*_', n),
    'mixed emphasis': (n) => repeat('*a _b ', n),
    'emphasis over lines': (n) => repeat('*a\n', n),
    underscores: (n) => repeat('_', n),
    'underscore openers': (n) => repeat('_a ', n),
    'strike openers': (n) => repeat('~~a ', n),
    tildes: (n) => repeat('~', n),
    'angle starts': (n) => repeat('<a ', n),
    'tag starts': (n) => repeat('<b', n),
    'autolink starts': (n) => repeat('<http:', n),
    'entity starts': (n) => repeat('[[task:', n),
    backslashes: (n) => repeat('\\', n),
    newlines: (n) => repeat('\n', n),
    'long blank run': (n) => ' '.repeat(n) + 'x',
    'long tab run': (n) => '\t'.repeat(n) + '-',
    'heading blanks': (n) => '# a' + ' '.repeat(n) + 'b',
    'list blanks': (n) => '-' + ' '.repeat(n) + 'x',
    'table pipes': (n) => repeat('| a ', n),
    'rule dashes': (n) => repeat('|-', n),
    'hash runs': (n) => repeat('#', n),
    'reference definitions': (n) => repeat('[a]: ', n),
    quotes: (n) => repeat('> ', n),
    'everything at once': (n) => repeat('[`*_~<![]()|#>\\\n ', n),
  };

  it.each(Object.entries(hostile))('%s: scales linearly from 40,000 characters (n vs 4n), well under a second', (name, build) => {
    expect(build(N).length).toBeGreaterThanOrEqual(N - 100);
    toPlainText('warm up **x** [a](b) `c`');
    expectLinear(build, (input) => toPlainText(input), { n: N, label: name });
  });

  it('returns the same text for a long plain paragraph as for a short one', () => {
    const sentence = 'Rollback finished for release 42, see #dev and @nadia. ';
    expect(toPlainText(sentence.repeat(700)).length).toBe(sentence.repeat(700).trim().length);
  });
});
