import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../test-utils/src/linear.ts';
import { compileSpanPattern, findSpans, matchPattern, parseGateEntry, prepareText, type SpanBudget } from '../src/bot-md/index.ts';

// P10-04: where a pattern matches, for redaction. Same engine as the bot gate lists (linear time, a small regular-expression subset), plus the position
// of each match. For patterns where leftmost-first and leftmost-longest agree the answer must be JavaScript's own.

const program = (body: string, ignoreCase = false) => {
  const compiled = compileSpanPattern(body, ignoreCase);
  if (!compiled.ok) throw new Error(compiled.reason);
  return compiled.program;
};
const spans = (body: string, text: string, ignoreCase = false, max = 100) => findSpans(program(body, ignoreCase), text, max).map((s) => text.slice(s.start, s.end));

describe('findSpans', () => {
  const cases: [string, string][] = [
    ['AKIA[0-9A-Z]{16}', 'key AKIAIOSFODNN7EXAMPLE and AKIAABCDEFGHIJKLMNOP.'],
    ['[a-z]+@[a-z]+\\.com', 'mail bob@example.com or al@x.com now'],
    ['\\d{3}-\\d{4}', 'call 555-1234, 555-9876 or 5-5'],
    ['\\bcat\\b', 'cat concat cat. bobcat cat'],
    ['^abc', 'abc abc'],
    ['abc$', 'abc abc'],
    ['x+', 'axxbxxxc x'],
    ['(ab)+', 'ababab ab a'],
    ['[^ ]+', 'one two  three'],
  ];
  for (const [pattern, text] of cases) {
    it(`finds what RegExp finds for /${pattern}/`, () => {
      const expected = [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m[0]);
      expect(spans(pattern, text)).toEqual(expected);
    });
  }

  it('takes the longest match from the leftmost start', () => {
    expect(spans('a|ab|abc', 'xabcx')).toEqual(['abc']);
    expect(spans('a+|a+b', 'aaab aa')).toEqual(['aaab', 'aa']);
  });

  it('does not overlap and continues after each match', () => {
    expect(spans('aa', 'aaaaa')).toEqual(['aa', 'aa']);
  });

  it('ignores case on request', () => {
    expect(spans('secret', 'A Secret and a SECRET', true)).toEqual(['Secret', 'SECRET']);
    expect(spans('secret', 'A Secret and a SECRET', false)).toEqual([]);
  });

  it('reports offsets in UTF-16 units, also after characters outside the basic plane', () => {
    const text = '😀 key-ABC1 😀 key-XYZ2';
    const found = findSpans(program('key-[A-Z0-9]{4}'), text, 10);
    expect(found.map((s) => text.slice(s.start, s.end))).toEqual(['key-ABC1', 'key-XYZ2']);
  });

  it('never reports an empty span', () => {
    // built without the creation-time refusal: the scan itself must also drop empty matches
    const parsed = parseGateEntry('/a?b?/');
    if (!parsed.ok || parsed.entry.kind !== 'pattern') throw new Error('pattern');
    expect(findSpans(parsed.entry.program, 'xyz', 10)).toEqual([]);
    expect(findSpans(parsed.entry.program, 'xaby', 10)).toEqual([{ start: 1, end: 3 }]);
  });

  it('stops at the cap and covers the rest of the text with one span', () => {
    const text = 'a '.repeat(20);
    const found = findSpans(program('a'), text, 3);
    expect(found).toHaveLength(4);
    expect(found[3]!.end).toBe(text.length);
  });

  it('agrees with the yes/no answer of the gate engine', () => {
    for (const [pattern, text] of cases) expect(findSpans(program(pattern), text, 10).length > 0).toBe(matchPattern(program(pattern), text));
  });
});

describe('findSpans with a prepared text and a budget', () => {
  it('gives the same answer for a prepared text as for the string, also across characters outside the basic plane', () => {
    const text = '😀 key-ABC1 😀 key-XYZ2 and key-QQQ9';
    const prog = program('key-[A-Z0-9]{4}');
    expect(findSpans(prog, prepareText(text), 10)).toEqual(findSpans(prog, text, 10));
  });

  it('spends from a shared budget, and a text read to the end leaves it unexhausted', () => {
    const budget: SpanBudget = { steps: 1_000_000, exhausted: false };
    const text = 'x'.repeat(1000) + 'AKIAIOSFODNN7EXAMPLE';
    const found = findSpans(program('AKIA[0-9A-Z]{16}'), text, 10, budget);
    expect(found).toEqual([{ start: 1000, end: 1020 }]);
    expect(budget.exhausted).toBe(false);
    expect(budget.steps).toBeLessThan(1_000_000);
  });

  it('covers the whole text with one span, and says so, when the budget runs out before the end', () => {
    const budget: SpanBudget = { steps: 50, exhausted: false };
    const text = 'a'.repeat(10_000);
    const found = findSpans(program('[a-z]+@[a-z]+\\.com'), text, 10, budget);
    expect(budget.exhausted).toBe(true);
    expect(found).toEqual([{ start: 0, end: text.length }]);
  });

  it('keeps answering "exhausted" for later texts once the budget is spent', () => {
    const budget: SpanBudget = { steps: 0, exhausted: false };
    expect(findSpans(program('abc'), 'xabcx', 10, budget)).toEqual([{ start: 0, end: 5 }]);
    expect(budget.exhausted).toBe(true);
  });

  it('skips positions that cannot start a match without changing the answer', () => {
    const text = '    '.repeat(2000) + 'AKIAIOSFODNN7EXAMPLE' + ' '.repeat(5000);
    const spent: SpanBudget = { steps: 10_000_000, exhausted: false };
    expect(findSpans(program('AKIA[0-9A-Z]{16}'), text, 10, spent)).toEqual([{ start: 8000, end: 8020 }]);
    expect(spent.steps).toBeGreaterThan(9_000_000);
  });
});

describe('compileSpanPattern', () => {
  it('refuses a pattern that matches the empty text, an empty one, and what the subset does not support', () => {
    expect(compileSpanPattern('a*', false).ok).toBe(false);
    expect(compileSpanPattern('', false).ok).toBe(false);
    expect(compileSpanPattern('(?=a)b', false).ok).toBe(false);
    expect(compileSpanPattern('(a)\\1', false).ok).toBe(false);
    expect(compileSpanPattern('(a+)+', false).ok).toBe(false);
  });
  it('accepts a pattern that needs at least one character, with or without capital letters ignored', () => {
    expect(compileSpanPattern('CUST-[0-9]{6}', true).ok).toBe(true);
  });
});

describe('hostile input', () => {
  const hostile: [string, string, (n: number) => string][] = [
    ['a run that the longest alternative never finishes', 'a|a+b', (n) => 'a'.repeat(n)],
    ['many partial matches', '[a-z]+@[a-z]+\\.com', (n) => 'ab'.repeat(n / 2)],
    ['nothing matches but every position starts', '(a|b)*c', (n) => 'ab'.repeat(n / 2)],
    ['repeats of a long optional tail', 'x(y{1,50}z)?w', (n) => 'xyyyy'.repeat(n / 5)],
  ];
  for (const [label, pattern, build] of hostile) {
    it(`stays linear: ${label}`, () => {
      const compiled = program(pattern);
      expectLinear(build, (text) => findSpans(compiled, text, 500), { n: 10_000, label, ceilingMs: 1500 });
    });
  }
});
