import { describe, expect, it } from 'vitest';
import {
  BotFrontmatter,
  GATE_LIST_MAX_PROGRAM,
  GATE_MAX_ENTRIES,
  compileGate,
  gateSpellings,
  matchGate,
  matchPattern,
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
    '(ab){2}',
    '(?:a|b){2,3}c',
    '(?:\\d{3}-){1,2}\\d',
    '\\Bor\\B',
    '[\\w.-]+@[\\w-]+',
    '\\D+\\d',
    '[^\\s]+\\s[^\\s]+',
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

  // the engine alone, on the text as given: `matchGate` also reads the folded spellings, which is deliberately more than JavaScript would match
  const engine = (pattern: string, flags: string) => {
    const parsed = parseGateEntry(`/${pattern}/${flags}`);
    expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    if (!parsed.ok || parsed.entry.kind !== 'pattern') throw new Error('not a pattern');
    const program = parsed.entry.program;
    return (text: string): boolean => matchPattern(program, text);
  };

  it.each(patterns)('/%s/ agrees with JavaScript', (pattern) => {
    const run = engine(pattern, '');
    const native = new RegExp(pattern);
    for (const text of texts) expect(run(text), `/${pattern}/ on ${JSON.stringify(text)}`).toBe(native.test(text));
  });

  it.each(patterns)('/%s/i agrees with JavaScript, class case-folding included', (pattern) => {
    const run = engine(pattern, 'i');
    const native = new RegExp(pattern, 'i');
    for (const text of texts) expect(run(text), `/${pattern}/i on ${JSON.stringify(text)}`).toBe(native.test(text));
  });

  it('the i flag folds case, in literals and in classes (the engine); the gate also reads the folded spelling, so case never hides a topic', () => {
    expect(hit(['/drop table/i'], 'DROP TABLE users')).not.toBeNull();
    expect(matchPattern((parseGateEntry('/drop table/') as { ok: true; entry: { kind: 'pattern'; program: Parameters<typeof matchPattern>[0] } }).entry.program, 'DROP TABLE users')).toBe(false);
    expect(hit(['/drop table/'], 'DROP TABLE users')).not.toBeNull(); // the lower-cased spelling matches
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
    // JavaScript refuses a quantifier on a quantifier, and so do we
    for (const entry of ['/a{2}{3}/', '/a+{2}/', '/a{2}*/', '/a*{2}/', '/a{1,2}?{3}/', '/a+??/']) expect(reasonOf(entry), entry).toMatch(/two quantifiers/);
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
    expect(reasonOf('/(?:a|b|c|d|e|f){50}/')).toMatch(/too large/);
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

describe('hostile input at COMPILE time (a BOT.md is parsed on every commit; it must never wedge the loader)', () => {
  const quick = (entries: string[]): { ms: number; ok: boolean; reason: string } => {
    const started = performance.now();
    const compiled = compileGate(entries);
    return { ms: performance.now() - started, ok: compiled.ok, reason: compiled.ok ? '' : compiled.reason };
  };

  it('nested empty repeats, the pattern that once took 38 seconds, are refused at once', () => {
    for (const entry of ['/(((((){100}){100}){100}){100}){100}/', '/(((((((((((((((((((((((((((((){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}){100}/']) {
      const r = quick([entry]);
      expect(r.ok, entry).toBe(false);
      expect(r.reason).toMatch(/repeat of nothing|nested deeper/);
      expect(r.ms).toBeLessThan(200);
    }
  });

  it('empty-width bodies are refused whatever the quantifier, and so is anything repeated zero times then repeated', () => {
    for (const entry of ['/(){2}/', '/(?:){100}/', '/(x{0}){2}/', '/(^)*/', '/(|){100}/', '/(?:()){100}/', '/(\\b)+/']) {
      expect(quick([entry]).reason, entry).toMatch(/repeat of nothing/);
    }
    // x{0} alone is harmless and allowed
    expect(quick(['/ax{0}b/']).ok).toBe(true);
  });

  it('deep nesting and large counts are measured before they are expanded: too large, quickly', () => {
    const cases = [
      '/((((a{100}){100}){100}){100}){100}/',
      '/(((((a|b){100}){100}){100}){100}){100}/',
      '/(?:(?:(?:(?:(?:x{2}){2}){2}){2}){2}){2}\\w{100}\\w{100}/',
      `/${'(?:'.repeat(20)}a{100}${')'.repeat(20)}{100}/`,
      '/[a-z]{100}[a-z]{100}[a-z]{100}/',
    ];
    for (const entry of cases) {
      const r = quick([entry]);
      expect(r.ok, entry).toBe(false);
      expect(r.reason, entry).toMatch(/too large/);
      expect(r.ms, entry).toBeLessThan(200);
    }
  });

  it('a list of many large patterns is refused by the list limit quickly too, and a parse of the longest allowed entry is fast', () => {
    const r = quick(Array.from({ length: 50 }, () => '/(?:abcdefghij){19}/'));
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(500);
    const longest = quick([`/${'(?:a|b)'.repeat(25)}/`]);
    expect(longest.ms).toBeLessThan(200);
  });

  it('the schema path (BotFrontmatter) is as quick as compileGate', () => {
    const base = { name: 'G', role: 'R', kind: 'agent', runtime: 'hermes' };
    const started = performance.now();
    const parsed = BotFrontmatter.safeParse({ ...base, guard: { gate: ['/(((((){100}){100}){100}){100}){100}/'] } });
    expect(parsed.success).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('class size does not change the cost bound', () => {
  it('large classes repeated to the instruction limit over 40,000 characters stay within the time bound', () => {
    const klass = '[a-zA-Z0-9_\\-.,;:!?()<>@#$%^&*+=~`|/\\\\à-ÿЀ-ӿ\u0600-ۿ一-鿿]';
    const entries = [`/${klass}{90}x/`, `/${klass.replace('[', '[^')}{90}y/i`, '/[\\w\\s\\d\\D\\W\\S.-]{80}z/', `/(?:${klass}|\\d){40}q/`];
    const compiled = compileGate(entries);
    expect(compiled.ok, compiled.ok ? '' : compiled.reason).toBe(true);
    if (!compiled.ok) return;
    const text = 'aB3 éбم中-'.repeat(5_000).slice(0, 40_000);
    const started = performance.now();
    matchGate(compiled.gate, text);
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});

describe('stage one is not beaten by typography (NFKC-style folding, invisible characters, look-alike letters)', () => {
  const entries = ['credential rotation', 'drop table', 'licence change', 'تغيير الترخيص', '/delete\\s+prod/'];
  const caught = (text: string, index?: number): void => {
    const found = hit(entries, text);
    expect(found, JSON.stringify(text)).not.toBeNull();
    if (index !== undefined) expect(found?.index, JSON.stringify(text)).toBe(index);
  };

  it('zero-width and other format characters inside a word, or in place of the space', () => {
    caught('start the cre\u200bdential rotation', 0); // ZWSP inside a word
    caught('credential\u200brotation', 0); // ZWSP instead of the space
    caught('cred\u200dential\u200c rot\u00adation', 0); // ZWJ, ZWNJ, soft hyphen
    caught('dr\u2060op table', 1); // a word joiner inside a word
    caught('drop\u200b\u200btable', 1); // two of them where the space was
    caught('\u202ecredential rotation\u202c', 0); // bidi controls around it
    caught('please delete\u200bprod now', 4); // a pattern with \s: the spaced spelling
  });

  it('full-width and styled letters, and accents', () => {
    caught('ｃｒｅｄｅｎｔｉａｌ　ｒｏｔａｔｉｏｎ', 0);
    caught('𝐜𝐫𝐞𝐝𝐞𝐧𝐭𝐢𝐚𝐥 rotation', 0); // mathematical bold
    caught('crédéntial rotatiön', 0);
    caught('LICENCE CHANGE', 2);
    caught('ﬁle a licence change', 2); // a ligature elsewhere in the text
  });

  it('look-alike Cyrillic and Greek letters', () => {
    caught('credential rоtation', 0); // Cyrillic о
    caught('сredentіal rotаtion', 0); // Cyrillic с, і, а
    caught('drop tаble', 1);
    caught('lіcеncе chаngе', 2);
    caught('crεdεntιal rοtation', 0); // Greek ε ι ο
  });

  it('folds U+212A (Kelvin sign) and U+017F (long s) to k and s, deliberately more than JavaScript\'s /i does', () => {
    expect(new RegExp('license key', 'i').test('licen\u017fe \u212aey')).toBe(false); // JavaScript (no u flag) keeps them apart
    expect(hit(['license key'], 'licen\u017fe \u212aey')).not.toBeNull(); // the gate reads what a person would read
    expect(hit(['/license\\s+key/i'], 'LICEN\u017fE \u212aEY')).not.toBeNull();
  });

  it('Arabic: tatweel, harakat and the zero-width non-joiner', () => {
    caught('نريد تغيير الترخيص', 3);
    caught('تغ\u0640\u0640\u0640يير الترخيص', 3); // tatweel
    caught('ت\u064eغ\u0652ي\u0650ير\u064f الت\u064e\u0651ر\u0652خ\u0650يص\u0650', 3); // harakat
    caught('تغيي\u200cر الترخيص', 3); // ZWNJ
  });

  it('what it does not claim: spaced-out letters, leetspeak, and an invisible character inside a word AND another in place of the space are left to the classifier', () => {
    expect(hit(entries, 'dr\u2060op\u200btable')).toBeNull();
    expect(hit(entries, 'c r e d e n t i a l rotation')).toBeNull();
    expect(hit(entries, 'cr3dential rotation')).toBeNull();
  });

  it('plain text with nothing wrong is still left alone, and the spellings are cheap and linear', () => {
    expect(hit(entries, 'Please look at the deploy dashboard (it is Tuesday)')).toBeNull();
    const spelled = gateSpellings('A\u200bB');
    expect(spelled).toEqual({ joined: 'ab', spaced: 'a b' });
    const started = performance.now();
    gateSpellings('\u200b'.repeat(200_000) + 'x\u0301'.repeat(100_000));
    const compiled = compileGate(entries);
    if (compiled.ok) matchGate(compiled.gate, 'cre\u200bdential '.repeat(3_000));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
