// The gate list of a bot (BOT.md `guard.gate`, SPEC §7.3, PLAN P5-11 stage one): what a message may not be about before a model has read it.
// Pure functions only, no I/O, so the loader (which rejects a bad list), the runtime (which matches a message against it) and the editor
// (which can say why an entry is refused) read one definition.
//
// An entry is one of two things:
//
//  * a phrase — plain words (`credential rotation`). It matches a message that contains those words in that order, ignoring case,
//    punctuation and spacing (`Credential-rotation!` matches), and only whole words (`rotation` matches neither `rotations` nor `protation`).
//    This is the "exact" match of the spec.
//  * a pattern — `/…/` or `/…/i`, a regular expression from a deliberately small subset.
//
// Why a subset, and not `new RegExp(entry)`: a gate runs on every message of a bot, the pattern is written by a bot's author and the text is
// written by anybody, and JavaScript's engine backtracks — `(a+)+$` on a long run of `a` followed by `!` takes longer than the age of the
// universe. So patterns are parsed and run here, by a Thompson-style simulation that reads each character once per instruction: the cost is
// (message length) × (pattern size), whatever the pattern says. The subset is what a gate needs — literals, `.`, classes (`[a-z]`, `\d`
// `\w` `\s` and their negations), groups, alternation, `* + ? {n} {n,} {n,m}`, and the anchors `^ $ \b \B` — and refuses what cannot be run
// that way (backreferences, lookaround, named groups, flags other than `i`). It also refuses a repetition inside an unbounded repetition
// (`(a+)+`): this engine would run it linearly, but it is the shape that hangs every other engine the same pattern gets pasted into.
//
// Sizes are bounded where a list is loaded, so a hostile BOT.md cannot make a message expensive: an entry is at most 200 characters, a list at
// most 50 entries, one pattern compiles to at most 200 instructions and all the patterns of a list to at most 1,000.

export const GATE_MAX_ENTRIES = 50;
export const GATE_ENTRY_MAX_LENGTH = 200;
export const GATE_PATTERN_MAX_PROGRAM = 200;
export const GATE_LIST_MAX_PROGRAM = 1_000;
/** `x{n,m}` repeats at most this many times. */
export const GATE_REPEAT_MAX = 100;
const MAX_DEPTH = 20;

// -------------------------------------------------------------------------------------------------------------------------------------
// The pattern language: parse to a tree, compile to a small program, run the program.

type SetItem = { lo: number; hi: number } | { cls: 'd' | 'D' | 'w' | 'W' | 's' | 'S' };
type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'set'; negate: boolean; items: SetItem[] }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: 'bol' | 'eol' | 'wordb' | 'nwordb' };

type Inst =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'set'; negate: boolean; items: SetItem[] }
  | { op: 'split'; a: number; b: number }
  | { op: 'jmp'; to: number }
  | { op: 'assert'; kind: 'bol' | 'eol' | 'wordb' | 'nwordb' }
  | { op: 'match' };

/** A compiled pattern. Opaque to callers: build it with `parseGateEntry`, run it with `matchGate`. */
export interface GateProgram {
  readonly insts: readonly Inst[];
  readonly ignoreCase: boolean;
}

/** What the parser throws to stop: an Error carrying the reason in plain words (caught in this file only). */
type Failure = Error & { gateFailure: string };
const fail = (reason: string): never => {
  throw Object.assign(new Error(reason), { gateFailure: reason });
};
const isFailure = (value: unknown): value is Failure => value instanceof Error && 'gateFailure' in value;

const code = (ch: string): number => ch.codePointAt(0) ?? 0;
const DIGIT = (c: number): boolean => c >= 48 && c <= 57;
const WORD = (c: number): boolean => DIGIT(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const SPACE = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const LINE_END = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

function matchesClass(cls: 'd' | 'D' | 'w' | 'W' | 's' | 'S', c: number): boolean {
  switch (cls) {
    case 'd':
      return DIGIT(c);
    case 'D':
      return !DIGIT(c);
    case 'w':
      return WORD(c);
    case 'W':
      return !WORD(c);
    case 's':
      return SPACE(c);
    case 'S':
      return !SPACE(c);
  }
}

const lower = (c: number): number => {
  const folded = String.fromCodePoint(c).toLowerCase();
  const cp = folded.codePointAt(0) ?? c;
  return folded.length === String.fromCodePoint(cp).length ? cp : c;
};
const upper = (c: number): number => {
  const folded = String.fromCodePoint(c).toUpperCase();
  const cp = folded.codePointAt(0) ?? c;
  return folded.length === String.fromCodePoint(cp).length ? cp : c;
};

function setMatches(items: readonly SetItem[], negate: boolean, c: number, ignoreCase: boolean): boolean {
  const test = (x: number): boolean => items.some((item) => ('cls' in item ? matchesClass(item.cls, x) : x >= item.lo && x <= item.hi));
  const hit = test(c) || (ignoreCase && (test(lower(c)) || test(upper(c))));
  return hit !== negate;
}

function parsePattern(source: string): Node {
  const cps = Array.from(source);
  let i = 0;
  const peek = (): string | undefined => cps[i];

  const hex = (digits: number): number => {
    const chunk = cps.slice(i, i + digits).join('');
    if (chunk.length !== digits || !/^[0-9a-fA-F]+$/.test(chunk)) return fail(`a \\x or \\u escape needs ${digits} hex digits`);
    i += digits;
    return parseInt(chunk, 16);
  };

  /** After a backslash: a literal code point, or a class/anchor node. `inSet` forbids anchors. */
  const escape = (inSet: boolean): { literal: number } | { cls: 'd' | 'D' | 'w' | 'W' | 's' | 'S' } | { assert: 'wordb' | 'nwordb' } => {
    const ch = cps[i++];
    if (ch === undefined) return fail('a pattern cannot end with a backslash');
    switch (ch) {
      case 'd':
      case 'D':
      case 'w':
      case 'W':
      case 's':
      case 'S':
        return { cls: ch };
      case 'b':
        return inSet ? { literal: 8 } : { assert: 'wordb' };
      case 'B':
        return inSet ? fail('\\B is not allowed inside [...]') : { assert: 'nwordb' };
      case 'n':
        return { literal: 10 };
      case 'r':
        return { literal: 13 };
      case 't':
        return { literal: 9 };
      case 'f':
        return { literal: 12 };
      case 'v':
        return { literal: 11 };
      case '0':
        return { literal: 0 };
      case 'x':
        return { literal: hex(2) };
      case 'u':
        return cps[i] === '{' ? fail('\\u{…} is not supported; write the character itself') : { literal: hex(4) };
      default:
        if (/^[1-9]$/.test(ch)) return fail('backreferences are not supported (a pattern must run in linear time)');
        if (/^[A-Za-z]$/.test(ch)) return fail(`\\${ch} is not supported`);
        return { literal: code(ch) };
    }
  };

  const parseSet = (): Node => {
    let negate = false;
    if (peek() === '^') {
      negate = true;
      i += 1;
    }
    const items: SetItem[] = [];
    let closed = false;
    while (i < cps.length) {
      let ch = cps[i++] as string;
      if (ch === ']') {
        closed = true;
        break;
      }
      let lo: number;
      if (ch === '\\') {
        const e = escape(true);
        if ('cls' in e) {
          items.push({ cls: e.cls });
          continue;
        }
        if (!('literal' in e)) return fail('an anchor cannot sit inside [...]');
        lo = e.literal;
      } else {
        lo = code(ch);
      }
      // a range `a-z`, unless the dash is the last thing before `]`
      if (peek() === '-' && cps[i + 1] !== undefined && cps[i + 1] !== ']') {
        i += 1;
        ch = cps[i++] as string;
        let hi: number;
        if (ch === '\\') {
          const e = escape(true);
          if (!('literal' in e)) return fail('a range cannot end in a class such as \\d');
          hi = e.literal;
        } else {
          hi = code(ch);
        }
        if (hi < lo) return fail('a range in [...] runs backwards');
        items.push({ lo, hi });
      } else {
        items.push({ lo, hi: lo });
      }
    }
    if (!closed) return fail('a [ is never closed');
    if (items.length === 0) return fail('an empty [] matches nothing');
    return { t: 'set', negate, items };
  };

  const quantifier = (): { min: number; max: number } | null => {
    const ch = peek();
    let result: { min: number; max: number } | null = null;
    if (ch === '*') {
      i += 1;
      result = { min: 0, max: Infinity };
    } else if (ch === '+') {
      i += 1;
      result = { min: 1, max: Infinity };
    } else if (ch === '?') {
      i += 1;
      result = { min: 0, max: 1 };
    } else if (ch === '{') {
      // `{n}`, `{n,}`, `{n,m}`; anything else after a `{` is a literal brace
      let j = i + 1;
      let n = '';
      while (DIGIT(code(cps[j] ?? ''))) n += cps[j++];
      let m: string | null = null;
      if (cps[j] === ',') {
        j += 1;
        m = '';
        while (DIGIT(code(cps[j] ?? ''))) m += cps[j++];
      }
      if (n !== '' && cps[j] === '}') {
        const min = Number(n);
        const max = m === null ? min : m === '' ? Infinity : Number(m);
        if (min > GATE_REPEAT_MAX || (max !== Infinity && max > GATE_REPEAT_MAX)) return fail(`a repeat count above ${GATE_REPEAT_MAX} is not allowed`);
        if (max < min) return fail('a {n,m} repeat runs backwards');
        i = j + 1;
        result = { min, max };
      }
    }
    if (result) {
      if (peek() === '?') i += 1; // lazy: the same answer when only "does it match anywhere" is asked
      const next = peek();
      if (next === '*' || next === '+' || next === '?') return fail('two quantifiers in a row; a quantifier needs something to repeat');
    }
    return result;
  };

  const parseAlt = (depth: number): Node => {
    if (depth > MAX_DEPTH) return fail(`groups nested deeper than ${MAX_DEPTH} are not allowed`);
    const alts: Node[] = [parseSeq(depth)];
    while (peek() === '|') {
      i += 1;
      alts.push(parseSeq(depth));
    }
    return alts.length === 1 ? (alts[0] as Node) : { t: 'alt', items: alts };
  };

  const parseSeq = (depth: number): Node => {
    const items: Node[] = [];
    while (i < cps.length && peek() !== '|' && peek() !== ')') {
      const ch = cps[i++] as string;
      let atom: Node;
      let assertion = false;
      if (ch === '^') {
        atom = { t: 'assert', kind: 'bol' };
        assertion = true;
      } else if (ch === '$') {
        atom = { t: 'assert', kind: 'eol' };
        assertion = true;
      } else if (ch === '.') {
        atom = { t: 'any' };
      } else if (ch === '[') {
        atom = parseSet();
      } else if (ch === '(') {
        if (peek() === '?') {
          if (cps[i + 1] === ':') i += 2;
          else return fail('lookaround and named groups are not supported (a pattern must run in linear time); use (?:…) or (…)');
        }
        atom = parseAlt(depth + 1);
        if (peek() !== ')') return fail('a ( is never closed');
        i += 1;
      } else if (ch === '*' || ch === '+' || ch === '?') {
        return fail('a quantifier needs something to repeat');
      } else if (ch === '\\') {
        const e = escape(false);
        if ('cls' in e) atom = { t: 'set', negate: false, items: [{ cls: e.cls }] };
        else if ('assert' in e) {
          atom = { t: 'assert', kind: e.assert };
          assertion = true;
        } else atom = { t: 'char', c: e.literal };
      } else {
        atom = { t: 'char', c: code(ch) };
      }
      const q = quantifier();
      if (q) {
        if (assertion) return fail('an anchor cannot be repeated');
        atom = { t: 'rep', node: atom, min: q.min, max: q.max };
      }
      items.push(atom);
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'seq', items };
  };

  const tree = parseAlt(0);
  if (i < cps.length) return fail('a ) has no matching (');
  return tree;
}

/** Whether a node can repeat without bound (`*`, `+`, `{n,}`) anywhere inside it. */
function hasUnboundedRepeat(node: Node): boolean {
  switch (node.t) {
    case 'rep':
      return node.max === Infinity || hasUnboundedRepeat(node.node);
    case 'seq':
    case 'alt':
      return node.items.some(hasUnboundedRepeat);
    default:
      return false;
  }
}

/** The portability rule: a repetition inside an unbounded repetition is the catastrophic shape in every backtracking engine. */
function checkNesting(node: Node): void {
  switch (node.t) {
    case 'rep':
      if (node.max > 1 && hasUnboundedRepeat(node.node)) fail('a repetition inside a repetition, like (a+)+, is the shape that hangs regular-expression engines; write it flat');
      checkNesting(node.node);
      return;
    case 'seq':
    case 'alt':
      node.items.forEach(checkNesting);
      return;
    default:
  }
}

function compile(tree: Node, ignoreCase: boolean): GateProgram {
  const insts: Inst[] = [];
  const emit = (inst: Inst): number => {
    if (insts.length >= GATE_PATTERN_MAX_PROGRAM) return fail(`the pattern is too large (more than ${GATE_PATTERN_MAX_PROGRAM} instructions); shorten it or split it into two entries`);
    insts.push(inst);
    return insts.length - 1;
  };
  const fold = (c: number): number => (ignoreCase ? lower(c) : c);

  const gen = (node: Node): void => {
    switch (node.t) {
      case 'char':
        emit({ op: 'char', c: fold(node.c) });
        return;
      case 'any':
        emit({ op: 'any' });
        return;
      case 'set':
        emit({ op: 'set', negate: node.negate, items: node.items });
        return;
      case 'assert':
        emit({ op: 'assert', kind: node.kind });
        return;
      case 'seq':
        node.items.forEach(gen);
        return;
      case 'alt': {
        // split L1, L2; L1: first; jmp end; L2: split … ; last
        const jumps: number[] = [];
        node.items.forEach((item, index) => {
          if (index === node.items.length - 1) {
            gen(item);
            return;
          }
          const split = emit({ op: 'split', a: 0, b: 0 });
          (insts[split] as { a: number }).a = insts.length;
          gen(item);
          jumps.push(emit({ op: 'jmp', to: 0 }));
          (insts[split] as { b: number }).b = insts.length;
        });
        for (const j of jumps) (insts[j] as { to: number }).to = insts.length;
        return;
      }
      case 'rep': {
        for (let n = 0; n < node.min; n++) gen(node.node);
        if (node.max === Infinity) {
          // L: split body, end; body; jmp L
          const split = emit({ op: 'split', a: 0, b: 0 });
          (insts[split] as { a: number }).a = insts.length;
          gen(node.node);
          emit({ op: 'jmp', to: split });
          (insts[split] as { b: number }).b = insts.length;
          return;
        }
        // (max - min) optional copies, each skipping to the end when not taken
        const splits: number[] = [];
        for (let n = node.min; n < node.max; n++) {
          const split = emit({ op: 'split', a: 0, b: 0 });
          (insts[split] as { a: number }).a = insts.length;
          splits.push(split);
          gen(node.node);
        }
        for (const s of splits) (insts[s] as { b: number }).b = insts.length;
      }
    }
  };
  gen(tree);
  emit({ op: 'match' });
  return { insts, ignoreCase };
}

/**
 * Run a program over `points` (code points): does it match anywhere? One pass; the work is (characters) × (instructions) and nothing else.
 * Two thread lists swap at every character; `mark[pc] === position + 1` says that pc is already in the list being built for `position`, so a
 * list holds each instruction at most once and is never cleared.
 */
function runProgram(program: GateProgram, points: Uint32Array): boolean {
  const { insts, ignoreCase } = program;
  const size = insts.length;
  let cur = new Int32Array(size);
  let nxt = new Int32Array(size);
  let curMark = new Int32Array(size);
  let nxtMark = new Int32Array(size);
  let curLen = 0;
  let matched = false;

  const isWordAt = (index: number): boolean => index >= 0 && index < points.length && WORD(points[index] as number);

  /** Follow jumps, splits and satisfied anchors from `pc` at `pos`; the threads that wait for a character join `list`. */
  const add = (list: Int32Array, len: number, mark: Int32Array, pc: number, pos: number): number => {
    const stack = [pc];
    while (stack.length > 0) {
      const p = stack.pop() as number;
      if (mark[p] === pos + 1) continue;
      mark[p] = pos + 1;
      const inst = insts[p] as Inst;
      switch (inst.op) {
        case 'jmp':
          stack.push(inst.to);
          break;
        case 'split':
          stack.push(inst.b, inst.a);
          break;
        case 'assert': {
          const ok =
            inst.kind === 'bol'
              ? pos === 0
              : inst.kind === 'eol'
                ? pos === points.length
                : (isWordAt(pos - 1) !== isWordAt(pos)) === (inst.kind === 'wordb');
          if (ok) stack.push(p + 1);
          break;
        }
        case 'match':
          matched = true;
          break;
        default:
          list[len++] = p;
      }
    }
    return len;
  };

  for (let at = 0; at <= points.length; at++) {
    // a match may start at every position
    curLen = add(cur, curLen, curMark, 0, at);
    if (matched) return true;
    if (at === points.length) break;
    const c = points[at] as number;
    const folded = ignoreCase ? lower(c) : c;
    let nxtLen = 0;
    for (let k = 0; k < curLen; k++) {
      const pc = cur[k] as number;
      const inst = insts[pc] as Inst;
      let step = false;
      if (inst.op === 'char') step = inst.c === folded;
      else if (inst.op === 'any') step = !LINE_END(c);
      else if (inst.op === 'set') step = setMatches(inst.items, inst.negate, c, ignoreCase);
      if (step) nxtLen = add(nxt, nxtLen, nxtMark, pc + 1, at + 1);
    }
    if (matched) return true;
    [cur, nxt] = [nxt, cur];
    [curMark, nxtMark] = [nxtMark, curMark];
    curLen = nxtLen;
  }
  return false;
}

// -------------------------------------------------------------------------------------------------------------------------------------
// Entries and lists.

/** One parsed entry: a phrase (its words) or a pattern (its program). */
export type GateEntry =
  | { kind: 'phrase'; source: string; words: readonly string[] }
  | { kind: 'pattern'; source: string; program: GateProgram };

export type GateEntryResult = { ok: true; entry: GateEntry } | { ok: false; reason: string };

const WORDS = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string): string[] => Array.from(text.toLowerCase().matchAll(WORDS), (m) => m[0]);

/** Parse one gate-list entry; the reason of a refusal is written for the person editing BOT.md. */
export function parseGateEntry(source: string): GateEntryResult {
  const text = source.trim();
  if (text === '') return { ok: false, reason: 'an empty entry matches nothing' };
  if (text.length > GATE_ENTRY_MAX_LENGTH) return { ok: false, reason: `an entry is at most ${GATE_ENTRY_MAX_LENGTH} characters` };
  if (text.startsWith('/')) {
    const end = text.lastIndexOf('/');
    if (end === 0) return { ok: false, reason: 'a pattern is written /…/ or /…/i; for a phrase, leave out the leading slash' };
    const flags = text.slice(end + 1);
    if (flags !== '' && flags !== 'i') {
      return { ok: false, reason: `"${flags.slice(0, 20)}" after the closing / is not a flag (only i is supported); for a phrase that starts with a slash, leave the slash out` };
    }
    const body = text.slice(1, end);
    if (body === '') return { ok: false, reason: 'an empty pattern matches everything' };
    try {
      const tree = parsePattern(body);
      checkNesting(tree);
      return { ok: true, entry: { kind: 'pattern', source: text, program: compile(tree, flags === 'i') } };
    } catch (err) {
      if (isFailure(err)) return { ok: false, reason: err.gateFailure };
      throw err;
    }
  }
  const words = wordsOf(text);
  if (words.length === 0) return { ok: false, reason: 'a phrase needs at least one word (letters or digits)' };
  return { ok: true, entry: { kind: 'phrase', source: text, words } };
}

/** A gate list ready to match against messages. */
export interface CompiledGate {
  readonly entries: readonly GateEntry[];
  /** Phrases by their first word, with their index in the list. */
  readonly byFirstWord: ReadonlyMap<string, readonly { index: number; words: readonly string[] }[]>;
  readonly patterns: readonly { index: number; program: GateProgram }[];
}

export type CompileGateResult = { ok: true; gate: CompiledGate } | { ok: false; index: number | null; reason: string };

/** Parse and compile a whole list, or say which entry is wrong and why. An empty list compiles to a gate that never matches. */
export function compileGate(sources: readonly string[]): CompileGateResult {
  if (sources.length > GATE_MAX_ENTRIES) return { ok: false, index: null, reason: `a gate list has at most ${GATE_MAX_ENTRIES} entries` };
  const entries: GateEntry[] = [];
  const byFirstWord = new Map<string, { index: number; words: readonly string[] }[]>();
  const patterns: { index: number; program: GateProgram }[] = [];
  let instructions = 0;
  for (const [index, source] of sources.entries()) {
    const parsed = parseGateEntry(source);
    if (!parsed.ok) return { ok: false, index, reason: parsed.reason };
    entries.push(parsed.entry);
    if (parsed.entry.kind === 'phrase') {
      const first = parsed.entry.words[0] as string;
      const bucket = byFirstWord.get(first) ?? [];
      bucket.push({ index, words: parsed.entry.words });
      byFirstWord.set(first, bucket);
    } else {
      instructions += parsed.entry.program.insts.length;
      if (instructions > GATE_LIST_MAX_PROGRAM) {
        return { ok: false, index, reason: `the patterns of one gate list are limited to ${GATE_LIST_MAX_PROGRAM} instructions together; simplify some of them` };
      }
      patterns.push({ index, program: parsed.entry.program });
    }
  }
  return { ok: true, gate: { entries, byFirstWord, patterns } };
}

export interface GateMatch {
  /** The entry as written in BOT.md. Configuration, not message text. */
  entry: string;
  /** `exact` for a phrase, `regex` for a pattern. */
  kind: 'exact' | 'regex';
  index: number;
}

/**
 * The first entry of the list (in list order) that the text matches, or null. Linear in the text for the phrases (every word is looked at once
 * and compared with the few phrases that start with it), and (characters × instructions) for the patterns.
 */
export function matchGate(gate: CompiledGate, text: string): GateMatch | null {
  let best: GateMatch | null = null;
  const take = (index: number, kind: GateMatch['kind']): void => {
    if (best === null || index < best.index) best = { entry: (gate.entries[index] as GateEntry).source, kind, index };
  };

  if (gate.byFirstWord.size > 0) {
    const words = wordsOf(text);
    for (let at = 0; at < words.length; at++) {
      const candidates = gate.byFirstWord.get(words[at] as string);
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (best !== null && candidate.index > (best as GateMatch).index) continue;
        if (at + candidate.words.length > words.length) continue;
        let all = true;
        for (let k = 1; k < candidate.words.length; k++) {
          if (words[at + k] !== candidate.words[k]) {
            all = false;
            break;
          }
        }
        if (all) take(candidate.index, 'exact');
      }
    }
  }

  if (gate.patterns.length > 0) {
    const points = Uint32Array.from(Array.from(text), (ch) => ch.codePointAt(0) ?? 0);
    for (const pattern of gate.patterns) {
      if (best !== null && pattern.index > (best as GateMatch).index) break; // patterns are in list order
      if (runProgram(pattern.program, points)) {
        take(pattern.index, 'regex');
        break;
      }
    }
  }
  return best;
}
