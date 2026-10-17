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
