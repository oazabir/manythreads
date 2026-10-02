import { describe, expect, it } from 'vitest';
import { toPlainText } from '../../src/index.ts';

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
});
