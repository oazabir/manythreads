import { describe, expect, it } from 'vitest';
import {
  BotFrontmatter,
  GATE_LIST_MAX_PROGRAM,
  GATE_MAX_ENTRIES,
  compileGate,
  matchGate,
  parseGateEntry,
} from '../src/bot-md/index.ts';

// P5-11 stage one: the gate list of a bot. Phrases and a linear-time regular-expression subset, refused at load when they cannot be run safely.

const hit = (entries: string[], text: string): ReturnType<typeof matchGate> => {
  const compiled = compileGate(entries);
  if (!compiled.ok) throw new Error(`${compiled.index}: ${compiled.reason}`);
  return matchGate(compiled.gate, text);
};

describe('phrases (the exact match)', () => {
  it('match whole words in order, ignoring case, punctuation and spacing', () => {
    const entries = ['credential rotation'];
    expect(hit(entries, 'Please start the Credential-Rotation today!')).toMatchObject({ entry: 'credential rotation', kind: 'exact', index: 0 });
    expect(hit(entries, 'credential   \n rotation')).not.toBeNull();
    expect(hit(entries, 'rotation of the credential')).toBeNull(); // order matters
    expect(hit(entries, 'credentials rotation')).toBeNull(); // whole words only
    expect(hit(entries, 'credential key rotation')).toBeNull();
    expect(hit(entries, 'a credential')).toBeNull(); // the phrase runs past the end
  });

  it('read letters of any script and digits, and a single word is a phrase too', () => {
    expect(hit(['licence'], 'about the LICENCE.')).not.toBeNull();
    expect(hit(['تغيير الترخيص'], 'نريد تغيير الترخيص اليوم')).not.toBeNull();
    expect(hit(['2fa'], 'turn off 2FA for everyone')).not.toBeNull();
    expect(hit(['licence'], 'sublicence')).toBeNull();
  });

  it('report the first entry of the list that matches, whichever kind it is', () => {
    const entries = ['delete production data', '/prod(uction)?\\b/i', 'licence change'];
    expect(hit(entries, 'a licence change in production')).toMatchObject({ entry: '/prod(uction)?\\b/i', kind: 'regex', index: 1 });
    expect(hit(entries, 'delete production data now')).toMatchObject({ index: 0, kind: 'exact' });
    expect(hit(entries, 'a licence change please')).toMatchObject({ index: 2 });
  });

  it('an empty list never matches', () => {
    expect(hit([], 'anything at all')).toBeNull();
  });
});

describe('patterns (the regex subset)', () => {
  // The subset is run by our own engine; for every pattern the answer must be JavaScript's own.
  const patterns = [
    'abc',
    'a.c',
    '^abc',
    'abc$',
    '^abc$',
    'a|b|cd',
    '(?:ab)+c',
    '(ab|cd)e',
    'a{2}',
    'a{2,3}b',
    'a{2,}b',
    'colou?r',
    'x*y',
    '[a-c]+d',
    '[^a-c]d',
    '\\d{3}-\\d{4}',
    '\\bword\\b',
    '\\Bor\\b',
    '\\w+@\\w+\\.com',
    'drop\\s+table',
    '[\\d.]+',
    '[\\w-]+',
    '(?:sk-|ghp_)[A-Za-z0-9]{8,}',
    'a.*b',
    '^$',
    '',
  ].filter((p) => p !== '');
  const texts = [
    '',
    'abc',
    'xabcx',
    'a\nc',
    'abcabc',
    'aab',
    'aaab',
    'ab',
    'cde',
    'abe',
    'color colour',
    'xxy',
    'y',
    'bd',
    'ed',
    '555-1234',
    'a word here',
    'sword',
    'world or',
    'mail me: bob@example.com',
    'DROP   TABLE users',
    'drop table',
    '3.14',
    'a-b_c',
    'sk-abcdefgh1234',
    'ghp_short',
    'a--b',
    'étude abc',
    '😀 abc 😀',
  ];

  it.each(patterns)('/%s/ agrees with JavaScript', (pattern) => {
    const compiled = compileGate([`/${pattern}/`]);
    expect(compiled.ok, compiled.ok ? '' : compiled.reason).toBe(true);
    const native = new RegExp(pattern);
    for (const text of texts) {
      expect(matchGate((compiled as { ok: true; gate: Parameters<typeof matchGate>[0] }).gate, text) !== null, `/${pattern}/ on ${JSON.stringify(text)}`).toBe(native.test(text));
    }
  });

  it('the i flag folds case, in literals and in classes', () => {
    expect(hit(['/drop table/i'], 'DROP TABLE users')).not.toBeNull();
    expect(hit(['/drop table/'], 'DROP TABLE users')).toBeNull();
    expect(hit(['/[a-c]+x/i'], 'ABCX')).not.toBeNull();
    expect(hit(['/[^a-c]x/i'], 'Ax')).toBeNull();
  });

  it('`.` does not cross a line break and `^`/`$` mean the whole text', () => {
    expect(hit(['/a.b/'], 'a\nb')).toBeNull();
    expect(hit(['/^b/'], 'a\nb')).toBeNull();
    expect(hit(['/a$/'], 'a\nb')).toBeNull();
  });

  it('allow what is safe even if it looks scary in a backtracking engine', () => {
    expect(compileGate(['/(a|aa)+$/']).ok).toBe(true);
    expect(compileGate(['/\\w*\\w*\\w*\\w*x/']).ok).toBe(true);
    expect(compileGate(['/(?:\\d{3}-)+\\d{4}/']).ok).toBe(true);
  });
});

describe('what is refused at load, and why', () => {
  const reasonOf = (entry: string): string => {
    const parsed = parseGateEntry(entry);
    if (parsed.ok) throw new Error(`expected a refusal for ${entry}`);
    return parsed.reason;
  };

  it('a repetition inside an unbounded repetition (the catastrophic shape)', () => {
    for (const entry of ['/(a+)+$/', '/(a*)*b/', '/(\\w+\\s?)*end/', '/(?:x+y?)+/', '/(a+){2}/', '/((a)+b*)+/']) {
      expect(reasonOf(entry), entry).toMatch(/repetition inside a repetition/);
    }
  });

  it('lookaround, named groups and backreferences', () => {
    expect(reasonOf('/(?=x)y/')).toMatch(/lookaround/);
    expect(reasonOf('/(?!x)y/')).toMatch(/lookaround/);
    expect(reasonOf('/(?<=x)y/')).toMatch(/lookaround/);
    expect(reasonOf('/(?<name>x)/')).toMatch(/named groups/);
    expect(reasonOf('/(a)\\1/')).toMatch(/backreferences/);
  });

  it('flags other than i, an unclosed or empty pattern, and syntax errors, each in words', () => {
    expect(reasonOf('/abc/g')).toMatch(/not a flag/);
    expect(reasonOf('/etc/passwd')).toMatch(/not a flag/);
    expect(reasonOf('/oops')).toMatch(/leave out the leading slash/);
    expect(reasonOf('//')).toMatch(/empty pattern/);
    expect(reasonOf('/(abc/')).toMatch(/never closed/);
    expect(reasonOf('/abc)/')).toMatch(/no matching/);
    expect(reasonOf('/[abc/')).toMatch(/never closed/);
    expect(reasonOf('/[]/')).toMatch(/empty/);
    expect(reasonOf('/[z-a]/')).toMatch(/backwards/);
    expect(reasonOf('/*a/')).toMatch(/quantifier needs something/);
    expect(reasonOf('/a**/')).toMatch(/two quantifiers/);
    expect(reasonOf('/a{3,1}/')).toMatch(/backwards/);
    expect(reasonOf('/a{101}/')).toMatch(/above 100/);
    expect(reasonOf('/^*/')).toMatch(/anchor cannot be repeated/);
    expect(reasonOf('/\\k/')).toMatch(/not supported/);
    expect(reasonOf('/a\\/')).toMatch(/never closed|backslash/);
  });

  it('an empty phrase, a phrase with no words, and an entry that is too long', () => {
    expect(reasonOf('   ')).toMatch(/empty/);
    expect(reasonOf('!!! ???')).toMatch(/at least one word/);
    expect(reasonOf('x'.repeat(201))).toMatch(/at most 200/);
  });

  it('a pattern that compiles to too much, alone or together with the others', () => {
    expect(reasonOf('/(?:abcdefghij){50}/')).toMatch(/too large/);
    const big = '/(?:abcdefghij){9}/'; // 90 + a little: fine alone
    expect(parseGateEntry(big).ok).toBe(true);
    const many = Array.from({ length: Math.ceil(GATE_LIST_MAX_PROGRAM / 91) + 1 }, () => big);
    const compiled = compileGate(many);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toMatch(/limited to 1000 instructions/);
  });

  it('a list with more entries than allowed', () => {
    const compiled = compileGate(Array.from({ length: GATE_MAX_ENTRIES + 1 }, (_, i) => `topic ${i}`));
    expect(compiled).toMatchObject({ ok: false, index: null });
  });

  it('BOT.md: the refusal names the entry (guard.gate.<n>) and the definition is invalid', () => {
    const base = { name: 'Gatekeeper', role: 'Guards things', kind: 'agent', runtime: 'hermes' };
    expect(BotFrontmatter.safeParse({ ...base, guard: { gate: ['credential rotation', '/drop\\s+table/i'] } }).success).toBe(true);
    const bad = BotFrontmatter.safeParse({ ...base, guard: { gate: ['credential rotation', '/(a+)+$/'] } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['guard', 'gate', 1]);
    expect(bad.error?.issues[0]?.message).toMatch(/repetition inside a repetition/);
  });
});

describe('hostile input', () => {
  it('stays linear: patterns that hang a backtracking engine, long texts, a gate list at its limits', () => {
    const texts = ['a'.repeat(40_000) + '!', 'a '.repeat(20_000), 'ab'.repeat(20_000), ' '.repeat(40_000) + 'x', '😀'.repeat(20_000)];
    const patterns = ['/(a|aa)+$/', '/\\w*\\w*\\w*\\w*\\w*\\w*$/', '/(?:a|a)+b/', '/(?:\\s|\\s)*x$/', '/a?a?a?a?a?a?a?a?a?a?aaaaaaaaaa/', '/.*.*.*.*y/'];
    const compiled = compileGate(patterns);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const started = performance.now();
    for (const text of texts) matchGate(compiled.gate, text);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('a list of 50 phrases and a long text is a single pass over the words', () => {
    const entries = Array.from({ length: 50 }, (_, i) => `a a a a a a a a a a b${i}`);
    const compiled = compileGate(entries);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const started = performance.now();
    expect(matchGate(compiled.gate, 'a '.repeat(40_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('the largest allowed list (1,000 instructions) over a 40,000-character message', () => {
    const big = '/(?:abcdefghij){9}x?/';
    const entries = Array.from({ length: 10 }, () => big);
    const compiled = compileGate(entries);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const started = performance.now();
    matchGate(compiled.gate, 'abcdefghi'.repeat(4_400));
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});
