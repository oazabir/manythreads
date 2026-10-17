import { GATE_PATTERN_MAX_PROGRAM, fail, lower, toRanges, type Node } from './gate-parse.ts';

export type Inst =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'set'; negate: boolean; ranges: Uint32Array }
  | { op: 'split'; a: number; b: number }
  | { op: 'jmp'; to: number }
  | { op: 'assert'; kind: 'bol' | 'eol' | 'wordb' | 'nwordb' }
  | { op: 'match' };

/** A compiled pattern. Opaque to callers: build it with `parseGateEntry`, run it with `matchGate`. */
export interface GateProgram {
  readonly insts: readonly Inst[];
  readonly ignoreCase: boolean;
}

/**
 * How many instructions a tree compiles to, at most, computed **before** anything is emitted and saturating at one past the limit. Every node
 * counts at least one, even an empty group: a body that emits nothing would otherwise be "free" to repeat a hundred times inside a hundred
 * repeats inside a hundred repeats, and the compiler would spin through 100^k empty copies before it ever reached the instruction cap.
 */
const SIZE_CAP = GATE_PATTERN_MAX_PROGRAM + 1;
const saturate = (n: number): number => Math.min(n, SIZE_CAP);
function sizeOf(node: Node): number {
  switch (node.t) {
    case 'char':
    case 'any':
    case 'set':
    case 'assert':
      return 1;
    case 'seq': {
      let total = 0;
      for (const item of node.items) total = saturate(total + sizeOf(item));
      return Math.max(1, total);
    }
    case 'alt': {
      let total = (node.items.length - 1) * 2;
      for (const item of node.items) total = saturate(total + sizeOf(item));
      return Math.max(1, total);
    }
    case 'rep': {
      const body = sizeOf(node.node);
      let total = saturate(node.min * body);
      total = node.max === Infinity ? saturate(total + body + 2) : saturate(total + (node.max - node.min) * (body + 1));
      return Math.max(1, total);
    }
  }
}

export function compile(tree: Node, ignoreCase: boolean): GateProgram {
  if (sizeOf(tree) + 1 > GATE_PATTERN_MAX_PROGRAM) {
    return fail(`the pattern is too large (more than ${GATE_PATTERN_MAX_PROGRAM} instructions once repeats are expanded); shorten it or split it into two entries`);
  }
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
        emit({ op: 'set', negate: node.negate, ranges: toRanges(node.items) });
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
