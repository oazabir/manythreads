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
//
// The implementation lives in `./gate-parse.ts` (the pattern language: parse to a tree), `./gate-compile.ts` (the tree to a small program),
// `./gate-run.ts` (running the program), `./gate-spell.ts` (the two spellings a text is read in) and `./gate-match.ts` (entries and lists);
// this module is the facade over them.
export {
  GATE_ENTRY_MAX_LENGTH,
  GATE_LIST_MAX_PROGRAM,
  GATE_MAX_ENTRIES,
  GATE_PATTERN_MAX_PROGRAM,
  GATE_REPEAT_MAX,
  GATE_RUN_MIN_JOINED,
} from './gate-parse.ts';
export type { GateProgram } from './gate-compile.ts';
export { findSpans, matchPattern, prepareText } from './gate-run.ts';
export type { PreparedText, SpanBudget, TextSpan } from './gate-run.ts';
export { gateSpellings } from './gate-spell.ts';
export { compileGate, compileSpanPattern, matchGate, parseGateEntry } from './gate-match.ts';
export type { SpanPatternResult } from './gate-match.ts';
export type { CompiledGate, CompileGateResult, GateEntry, GateEntryResult, GateMatch } from './gate-match.ts';
