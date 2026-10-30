import { GATE_ENTRY_MAX_LENGTH, GATE_LIST_MAX_PROGRAM, GATE_MAX_ENTRIES, GATE_RUN_MIN_JOINED, checkNesting, isFailure, parsePattern } from './gate-parse.ts';
import { compile, type GateProgram } from './gate-compile.ts';
import { runProgram } from './gate-run.ts';
import { UNSPACED, gateSpellings, wordsOf } from './gate-spell.ts';

/** One parsed entry: a phrase (its words) or a pattern (its program). */
export type GateEntry =
  | { kind: 'phrase'; source: string; words: readonly string[] }
  | { kind: 'pattern'; source: string; program: GateProgram };

export type GateEntryResult = { ok: true; entry: GateEntry } | { ok: false; reason: string };

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
  const words = wordsOf(gateSpellings(text).joined);
  if (words.length === 0) return { ok: false, reason: 'a phrase needs at least one word (letters or digits)' };
  return { ok: true, entry: { kind: 'phrase', source: text, words } };
}

export type SpanPatternResult = { ok: true; program: GateProgram } | { ok: false; reason: string };

/**
 * A pattern written without the slashes, compiled by the same linear-time engine as a gate pattern, for finding where it matches (`findSpans`).
 * Refused, with a reason written for the person who typed it, when the pattern is outside the supported subset, too large, or matches the empty text
 * (a pattern that matches nothing in particular would "find" something everywhere).
 */
export function compileSpanPattern(body: string, ignoreCase: boolean): SpanPatternResult {
  if (body.trim() === '') return { ok: false, reason: 'an empty pattern matches everything' };
  const parsed = parseGateEntry(`/${body}/${ignoreCase ? 'i' : ''}`);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.entry.kind !== 'pattern') return { ok: false, reason: 'not a pattern' };
  if (runProgram(parsed.entry.program, new Uint32Array(0))) return { ok: false, reason: 'this pattern also matches empty text; it must need at least one character' };
  return { ok: true, program: parsed.entry.program };
}

/** A gate list ready to match against messages. */
export interface CompiledGate {
  readonly entries: readonly GateEntry[];
  /** Phrases by their first word, with their index in the list. */
  readonly byFirstWord: ReadonlyMap<string, readonly { index: number; words: readonly string[] }[]>;
  readonly patterns: readonly { index: number; program: GateProgram }[];
  /**
   * Phrases also matched as one run of letters: `text` is the phrase's words joined. A phrase of two or more words is found when the message's words,
   * joined, contain it **aligned to word boundaries** (so `droptable`, `d r o p t a b l e` and `drop<invisible>table` are all the phrase, while
   * `sublicence change` is not `licence change`); a phrase in a script written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar) is found anywhere
   * in the run, because there are no word boundaries to align to.
   */
  readonly runs: readonly { index: number; text: string; unspaced: boolean }[];
}

export type CompileGateResult = { ok: true; gate: CompiledGate } | { ok: false; index: number | null; reason: string };

/** Parse and compile a whole list, or say which entry is wrong and why. An empty list compiles to a gate that never matches. */
export function compileGate(sources: readonly string[]): CompileGateResult {
  if (sources.length > GATE_MAX_ENTRIES) return { ok: false, index: null, reason: `a gate list has at most ${GATE_MAX_ENTRIES} entries` };
  const entries: GateEntry[] = [];
  const byFirstWord = new Map<string, { index: number; words: readonly string[] }[]>();
  const patterns: { index: number; program: GateProgram }[] = [];
  const runs: { index: number; text: string; unspaced: boolean }[] = [];
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
      const text = parsed.entry.words.join('');
      const unspaced = UNSPACED.test(text);
      // a multi-word phrase is also searched as a run only when its joined text is long enough to mean something (`a b` would match inside
      // any word run); a shorter one is left to the word comparison
      if (unspaced || (parsed.entry.words.length > 1 && text.length >= GATE_RUN_MIN_JOINED)) runs.push({ index, text, unspaced });
    } else {
      instructions += parsed.entry.program.insts.length;
      if (instructions > GATE_LIST_MAX_PROGRAM) {
        return { ok: false, index, reason: `the patterns of one gate list are limited to ${GATE_LIST_MAX_PROGRAM} instructions together; simplify some of them` };
      }
      patterns.push({ index, program: parsed.entry.program });
    }
  }
  return { ok: true, gate: { entries, byFirstWord, patterns, runs } };
}

/**
 * The message's words joined into one run, searched for each multi-word phrase (aligned to word boundaries) and each phrase of an unspaced script (anywhere).
 * Catches what the word-by-word comparison cannot: a phrase whose words the message has run together (`droptable`), spaced apart (`d r o p t a b l e`), or
 * split by an invisible character inside a word and another where the space was. The price is stated: `droptable` is held although nobody typed a space.
 * One `indexOf` per phrase, repeated after a match that was not aligned: cost O(n × Σ|phrase|) for a message of n characters and the phrases'
 * joined lengths, bounded by the 40k message cap and the list limits. Runs are in list order, so a run after the best entry so far cannot win and is skipped.
 */
function matchRuns(gate: CompiledGate, words: readonly string[], best: () => number, take: (index: number, kind: GateMatch['kind']) => void): void {
  const joined = words.join('');
  const starts = new Uint8Array(joined.length + 1);
  const ends = new Uint8Array(joined.length + 1);
  let offset = 0;
  for (const word of words) {
    starts[offset] = 1;
    offset += word.length;
    ends[offset] = 1;
  }
  for (const run of gate.runs) {
    if (run.index > best()) break; // in list order: nothing after this can beat the best entry found
    let from = 0;
    for (;;) {
      const at = joined.indexOf(run.text, from);
      if (at === -1) break;
      if (run.unspaced || (starts[at] === 1 && ends[at + run.text.length] === 1)) {
        take(run.index, 'exact');
        break;
      }
      from = at + 1;
    }
  }
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

  const spellings = gateSpellings(text);
  // the spellings that differ; for ordinary text there is one, and the work is not repeated
  const variants = spellings.joined === spellings.spaced ? [spellings.joined] : [spellings.joined, spellings.spaced];

  if (gate.byFirstWord.size > 0) {
    for (const variant of variants) {
      const words = wordsOf(variant);
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
      if (gate.runs.length > 0) matchRuns(gate, words, () => (best === null ? Infinity : (best as GateMatch).index), take);
    }
  }

  if (gate.patterns.length > 0) {
    // a pattern is written against what a person typed, so it sees the raw text too (`/DROP/` is case-sensitive), and both folded spellings
    const texts = [text, ...variants.filter((v) => v !== text)];
    const sets = texts.map((t) => Uint32Array.from(Array.from(t), (ch) => ch.codePointAt(0) ?? 0));
    for (const pattern of gate.patterns) {
      if (best !== null && pattern.index > (best as GateMatch).index) break; // patterns are in list order
      if (sets.some((points) => runProgram(pattern.program, points))) {
        take(pattern.index, 'regex');
        break;
      }
    }
  }
  return best;
}
