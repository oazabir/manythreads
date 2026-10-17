export const GATE_MAX_ENTRIES = 50;
export const GATE_ENTRY_MAX_LENGTH = 200;
export const GATE_PATTERN_MAX_PROGRAM = 200;
export const GATE_LIST_MAX_PROGRAM = 1_000;
/** `x{n,m}` repeats at most this many times. */
export const GATE_REPEAT_MAX = 100;
/** A multi-word phrase is searched as a run of the message's joined words only from this many joined characters; shorter ones match by words alone. */
export const GATE_RUN_MIN_JOINED = 4;
const MAX_DEPTH = 20;

type SetItem = { lo: number; hi: number } | { cls: 'd' | 'D' | 'w' | 'W' | 's' | 'S' };
export type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'set'; negate: boolean; items: SetItem[] }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: 'bol' | 'eol' | 'wordb' | 'nwordb' };

/** What the parser throws to stop: an Error carrying the reason in plain words (caught in this file only). */
type Failure = Error & { gateFailure: string };
export const fail = (reason: string): never => {
  throw Object.assign(new Error(reason), { gateFailure: reason });
};
export const isFailure = (value: unknown): value is Failure => value instanceof Error && 'gateFailure' in value;

const code = (ch: string): number => ch.codePointAt(0) ?? 0;
const DIGIT = (c: number): boolean => c >= 48 && c <= 57;
export const WORD = (c: number): boolean => DIGIT(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
export const LINE_END = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

export const lower = (c: number): number => {
  const folded = String.fromCodePoint(c).toLowerCase();
  const cp = folded.codePointAt(0) ?? c;
  return folded.length === String.fromCodePoint(cp).length ? cp : c;
};
const upper = (c: number): number => {
  const folded = String.fromCodePoint(c).toUpperCase();
  const cp = folded.codePointAt(0) ?? c;
  return folded.length === String.fromCodePoint(cp).length ? cp : c;
};

/**
 * A class as sorted, merged ranges `[lo0, hi0, lo1, hi1, …]`, with `\d \w \s` expanded and `\D \W \S` complemented. The simulation then asks "is this
 * code point in the class" by binary search, so a class of a hundred items costs what a class of one does and the (characters × instructions) bound
 * holds whatever the class looks like.
 */
const CLASS_RANGES: Record<'d' | 'w' | 's', readonly number[]> = {
  d: [48, 57],
  w: [48, 57, 65, 90, 95, 95, 97, 122],
  s: [9, 13, 32, 32, 160, 160, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff],
};
const MAX_CODE_POINT = 0x10ffff;

function complementOf(pairs: readonly number[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    if ((pairs[k] as number) > next) out.push(next, (pairs[k] as number) - 1);
    next = (pairs[k + 1] as number) + 1;
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
  return out;
}

export function toRanges(items: readonly SetItem[]): Uint32Array {
  const pairs: [number, number][] = [];
  for (const item of items) {
    if ('cls' in item) {
      const base = CLASS_RANGES[item.cls.toLowerCase() as 'd' | 'w' | 's'];
      const list = item.cls === item.cls.toLowerCase() ? base : complementOf(base);
      for (let k = 0; k < list.length; k += 2) pairs.push([list[k] as number, list[k + 1] as number]);
    } else {
      pairs.push([item.lo, item.hi]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const merged: number[] = [];
  for (const [lo, hi] of pairs) {
    const last = merged.length - 1;
    if (last >= 0 && lo <= (merged[last] as number) + 1) merged[last] = Math.max(merged[last] as number, hi);
    else merged.push(lo, hi);
  }
  return Uint32Array.from(merged);
}

function inRanges(ranges: Uint32Array, c: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < (ranges[mid * 2] as number)) hi = mid - 1;
    else if (c > (ranges[mid * 2 + 1] as number)) lo = mid + 1;
    else return true;
  }
  return false;
}

export function setMatches(ranges: Uint32Array, negate: boolean, c: number, ignoreCase: boolean): boolean {
  const hit = inRanges(ranges, c) || (ignoreCase && (inRanges(ranges, lower(c)) || inRanges(ranges, upper(c))));
  return hit !== negate;
}

/** Whether a node can only ever match the empty string (an empty group, an anchor, something repeated zero times). Repeating it costs and means nothing. */
function matchesNothing(node: Node): boolean {
  switch (node.t) {
    case 'assert':
      return true;
    case 'seq':
      return node.items.every(matchesNothing);
    case 'alt':
      return node.items.every(matchesNothing);
    case 'rep':
      return node.max === 0 || matchesNothing(node.node);
    default:
      return false;
  }
}

export function parsePattern(source: string): Node {
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

  /** `{n}`, `{n,}` or `{n,m}` starting at `at` (a `{`), or null when what follows is not that shape (then the brace is a literal). */
  const braceAt = (at: number): { min: number; max: number; end: number } | null => {
    let j = at + 1;
    let n = '';
    while (DIGIT(code(cps[j] ?? ''))) n += cps[j++];
    let m: string | null = null;
    if (cps[j] === ',') {
      j += 1;
      m = '';
      while (DIGIT(code(cps[j] ?? ''))) m += cps[j++];
    }
    if (n === '' || cps[j] !== '}') return null;
    const min = Number(n);
    const max = m === null ? min : m === '' ? Infinity : Number(m);
    if (min > GATE_REPEAT_MAX || (max !== Infinity && max > GATE_REPEAT_MAX)) return fail(`a repeat count above ${GATE_REPEAT_MAX} is not allowed`);
    if (max < min) return fail('a {n,m} repeat runs backwards');
    return { min, max, end: j + 1 };
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
      const brace = braceAt(i);
      if (brace) {
        i = brace.end;
        result = { min: brace.min, max: brace.max };
      }
    }
    if (result) {
      if (peek() === '?') i += 1; // lazy: the same answer when only "does it match anywhere" is asked
      // JavaScript refuses `a{2}{3}`, `a+{2}` and `a**` ("nothing to repeat"); so does this
      const next = peek();
      if (next === '*' || next === '+' || next === '?' || (next === '{' && braceAt(i) !== null)) return fail('two quantifiers in a row; a quantifier needs something to repeat');
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
        if (matchesNothing(atom)) return fail('a repeat of nothing (an empty group, or something repeated zero times) is not allowed');
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
export function checkNesting(node: Node): void {
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
