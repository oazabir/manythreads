import type { GateProgram, Inst } from './gate-compile.ts';
import { LINE_END, WORD, lower, setMatches } from './gate-parse.ts';

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
  // one stack for the whole run, emptied by each `add` (it always drains it), instead of an array allocated per character
  const stack: number[] = [];
  const add = (list: Int32Array, len: number, mark: Int32Array, pc: number, pos: number): number => {
    stack.length = 0;
    stack.push(pc);
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
      else if (inst.op === 'set') step = setMatches(inst.ranges, inst.negate, c, ignoreCase);
      if (step) nxtLen = add(nxt, nxtLen, nxtMark, pc + 1, at + 1);
    }
    if (matched) return true;
    [cur, nxt] = [nxt, cur];
    [curMark, nxtMark] = [nxtMark, curMark];
    curLen = nxtLen;
  }
  return false;
}

export { runProgram };

/** The pattern engine alone, on the text exactly as given (no folding): what the differential tests compare with `RegExp`. `matchGate` also tries the folded spellings. */
export function matchPattern(program: GateProgram, text: string): boolean {
  return runProgram(program, Uint32Array.from(Array.from(text), (ch) => ch.codePointAt(0) ?? 0));
}

/** A stretch of the text a pattern matched, as UTF-16 offsets (`text.slice(start, end)`). Never empty. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** How many scans a text may cost in all, as a multiple of its length, before the rest is covered by one span instead. */
const SPAN_WORK_FACTOR = 4;

/** A text read once into code points, so a rule set does not read it again for every rule. */
export interface PreparedText {
  readonly points: Uint32Array;
  /** `offsets[i]` is where code point `i` starts in the string (UTF-16 units); the last entry is the string's length. */
  readonly offsets: Int32Array;
}

export function prepareText(text: string): PreparedText {
  const points = new Uint32Array(text.length);
  const offsets = new Int32Array(text.length + 1);
  let n = 0;
  for (let unit = 0; unit < text.length; ) {
    const cp = text.codePointAt(unit) as number;
    points[n] = cp;
    offsets[n] = unit;
    n++;
    unit += cp > 0xffff ? 2 : 1;
  }
  offsets[n] = text.length;
  return { points: points.subarray(0, n), offsets: offsets.subarray(0, n + 1) };
}

/**
 * A cap on the work of a whole rule set over one text (or one call's texts). `steps` is spent as the scan goes (three, and one for each live thread, at
 * each position that is looked at; a quarter of a step per character for reading the text); when it runs out the scan stops, `exhausted` is set, and the caller treats the text as not checkable.
 */
export interface SpanBudget {
  steps: number;
  exhausted: boolean;
}

/**
 * Where the pattern matches in the text: the leftmost match, the longest one from that start, then the same again after its end, up to `max` spans.
 * The same simulation as `runProgram`, with each thread remembering where its match began (two threads on one instruction keep the earlier start).
 * Once a match is known, no new thread starts and the threads that began later are dropped; the scan ends when no thread that could beat the match is
 * left, and the next scan starts at the match's end. A pattern such as `a|a+b` over a long run of `a` would make those scans overlap again and again, so
 * the total work is capped at a few times the text's length; past the cap (or past `max` spans) the whole rest of the text from that point is returned
 * as one span, which errs on the side of covering too much, never too little. Empty matches are ignored.
 * A character that none of the pattern's first instructions can take starts no thread, so most positions of a text cost almost nothing. With a `budget`
 * the work of every call that shares it is capped; when it runs out the whole text is returned as one span and `budget.exhausted` is set.
 * What this is for: redaction (a secret has to be cut out of the text, not only found), where `runProgram` answers only yes or no.
 */
export function findSpans(program: GateProgram, text: string | PreparedText, max: number, budget?: SpanBudget): TextSpan[] {
  const prepared = typeof text === 'string' ? prepareText(text) : text;
  const { points, offsets } = prepared;
  const n = points.length;
  const unit = offsets[n] as number;
  const { insts, ignoreCase } = program;
  const size = insts.length;
  if (budget && typeof text === 'string') {
    budget.steps -= (n >> 2) + 1;
    if (budget.steps < 0) {
      budget.exhausted = true;
      return n === 0 ? [] : [{ start: 0, end: unit }];
    }
  }
  // the instructions a match can start with (anchors count as satisfied, so the set is never too small); null when the pattern can match nothing at all
  const startInsts = ((): Inst[] | null => {
    const seen = new Set<number>();
    const found: Inst[] = [];
    const todo = [0];
    while (todo.length > 0) {
      const p = todo.pop() as number;
      if (seen.has(p)) continue;
      seen.add(p);
      const inst = insts[p] as Inst;
      if (inst.op === 'jmp') todo.push(inst.to);
      else if (inst.op === 'split') todo.push(inst.a, inst.b);
      else if (inst.op === 'assert') todo.push(p + 1);
      else if (inst.op === 'match') return null;
      else found.push(inst);
    }
    return found;
  })();
  const canStart = (c: number): boolean => {
    if (startInsts === null) return true;
    const folded = ignoreCase ? lower(c) : c;
    for (const inst of startInsts) {
      if (inst.op === 'char' ? inst.c === folded : inst.op === 'any' ? !LINE_END(c) : inst.op === 'set' && setMatches(inst.ranges, inst.negate, c, ignoreCase)) return true;
    }
    return false;
  };
  const isWordAt = (index: number): boolean => index >= 0 && index < n && WORD(points[index] as number);
  const spans: TextSpan[] = [];
  const workCap = SPAN_WORK_FACTOR * (n + 1) + 16;
  let work = 0;
  let from = 0;

  let cur = new Int32Array(size);
  let nxt = new Int32Array(size);
  let curStart = new Int32Array(size);
  let nxtStart = new Int32Array(size);
  let curMark = new Int32Array(size);
  let nxtMark = new Int32Array(size);
  let bestStart = -1;
  let bestEnd = -1;
  const stack: number[] = [];

  const add = (list: Int32Array, starts: Int32Array, len: number, mark: Int32Array, pc: number, pos: number, start: number): number => {
    stack.length = 0;
    stack.push(pc);
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
                ? pos === n
                : (isWordAt(pos - 1) !== isWordAt(pos)) === (inst.kind === 'wordb');
          if (ok) stack.push(p + 1);
          break;
        }
        case 'match':
          if (pos > start && (bestStart === -1 || start < bestStart || (start === bestStart && pos > bestEnd))) {
            bestStart = start;
            bestEnd = pos;
          }
          break;
        default:
          list[len] = p;
          starts[len] = start;
          len++;
      }
    }
    return len;
  };

  const restOfText = (point: number): TextSpan => ({ start: offsets[point] as number, end: unit });

  while (from <= n) {
    curMark.fill(0);
    nxtMark.fill(0);
    bestStart = -1;
    bestEnd = -1;
    let curLen = 0;
    for (let at = from; at <= n; at++) {
      if (++work > workCap) {
        spans.push(restOfText(bestStart === -1 ? at : bestStart));
        return spans;
      }
      const starts = bestStart === -1 && at < n && canStart(points[at] as number);
      // nothing alive and nothing can start here: the position costs nothing
      if (!starts && curLen === 0 && bestStart === -1) continue;
      if (budget) {
        budget.steps -= 3 + curLen;
        if (budget.steps < 0) {
          // out of work for the whole call: nothing here can be said to be clean, so the text is covered whole
          budget.exhausted = true;
          return n === 0 ? [] : [{ start: 0, end: unit }];
        }
      }
      if (starts) curLen = add(cur, curStart, curLen, curMark, 0, at, at);
      if (bestStart !== -1) {
        // threads that began after the best match's start cannot beat it
        let kept = 0;
        for (let k = 0; k < curLen; k++) {
          if ((curStart[k] as number) <= bestStart) {
            cur[kept] = cur[k] as number;
            curStart[kept] = curStart[k] as number;
            kept++;
          }
        }
        curLen = kept;
        if (curLen === 0) break;
      }
      if (at === n) break;
      const c = points[at] as number;
      const folded = ignoreCase ? lower(c) : c;
      let nxtLen = 0;
      for (let k = 0; k < curLen; k++) {
        const pc = cur[k] as number;
        const inst = insts[pc] as Inst;
        let step = false;
        if (inst.op === 'char') step = inst.c === folded;
        else if (inst.op === 'any') step = !LINE_END(c);
        else if (inst.op === 'set') step = setMatches(inst.ranges, inst.negate, c, ignoreCase);
        if (step) nxtLen = add(nxt, nxtStart, nxtLen, nxtMark, pc + 1, at + 1, curStart[k] as number);
      }
      [cur, nxt] = [nxt, cur];
      [curStart, nxtStart] = [nxtStart, curStart];
      [curMark, nxtMark] = [nxtMark, curMark];
      curLen = nxtLen;
    }
    if (bestStart === -1) break;
    spans.push({ start: offsets[bestStart] as number, end: offsets[bestEnd] as number });
    if (spans.length >= max) {
      if (bestEnd < n) spans.push(restOfText(bestEnd));
      return spans;
    }
    from = bestEnd;
  }
  return spans;
}
