// "Remove claim" (PLAN P5-17, SPEC §6.3): the sharer of an answer may take claims out of the copy before it is posted — and nothing else. The text
// of the copy is therefore never anything the sharer wrote: this function takes the answer's own text and the NUMBERS of the citations whose claims
// go, and returns that text with whole sentences deleted. What it returns is a subsequence of what it was given (a test pins it, and the messages
// provider checks it again before it stores a copy), so a removal can shorten an answer and can never add a word to it.
//
// A claim is a sentence unit that carries the marker `[n]` of a removed citation. The model is told to write markers wherever it likes (`[1], [2]`,
// before the stop, after it, tight to it, after a space, at the start of a line, wrapped in emphasis, brackets, quotes or a link), and what is
// stored is its text, so the segmentation FAILS TOWARD REMOVING MORE: where the extent of a sentence is ambiguous the claim is never left behind.
//
//   * The unit is a BLOCK, not a line: a paragraph (hard-wrapped lines included), a list item with its continuation lines, a quote, a heading, a
//     table row (which goes whole). A block is cut into sentence units; a block that loses every unit goes whole, with its bullet.
//   * A unit ends at `.`, `!`, `?` (and their Arabic, Indic, Chinese and ellipsis forms), after any run of stops and closers, when white space
//     follows — and the next word does not begin in lower case or with a digit and the stop does not close an abbreviation (`e.g.`, `U.S.`,
//     `Dr.`, an initial) — or when the stop is of a script written without spaces (`。！？`), or when a marker group follows the stop directly.
//   * A split can be wrong, and no list of abbreviations is complete (`Sen.`, `Gov.`, `Corp.`, `Mt.`, `ca. €3M`): so a unit that FOLLOWS a doubtful
//     split — a `.` after a word of four letters or fewer (any script, any case), after a number (`Am 3. Mai`) or after a token with a dot inside
//     it (`v2.3`, `a.txt`); a `?`, `!` or `…`; a run of stops or a closing quote or bracket after the stop (`...`, `Friday?" Dana`, `done." Warren`);
//     or a next character that is not a letter — is marked SOFT, and
//     when a soft unit is taken the unit before it is taken too (backwards, so doubtful splits chain). The documented price is one innocent
//     neighbour when a short word ends a sentence and the next one carries the marker; the claim itself is never left half behind.
//   * One positional rule decides where a removed marker group belongs, whatever decorates it (`**[2]**`, `\[2\]`, `([2])`, `(see [2])`, `"[2]"`,
//     `「[2]」`, `[[2]](url)`, `<sup>[2]</sup>`, `^[2]`): it belongs to the unit it sits in; and if NO word character (a letter, a digit or a mark of
//     any script) lies between the start of the unit and the group — only white space, punctuation, symbols, decoration, a link address, or words
//     inside an opening bracket or quote that the group is also inside — it is at a sentence BOUNDARY: it may be the suffix of the sentence before
//     or the prefix of this one, so BOTH go (the documented price is one innocent neighbour). A group after words is the unit's own: this unit goes.
//     No list of decorations has to be complete; only word characters count. The same holds across blocks: a block whose first unit has no word
//     character at all (`[2]` alone in a paragraph or a list item) also takes the last unit of the block immediately before it.
//   * Markers are `[2]`, `[1, 2]`, `[1-3]`, `[ 2 ]`, `［2］` and `【2】`, with a backslash allowed before the closing bracket (the client unescapes it);
//     a group counts as removed when ANY number in it is.
//   * Fenced code with a removed marker in it goes whole; a fence with no closing line is ordinary prose (it never shields what follows); an
//     inline code span is read as one piece (its stops are no sentence ends, it counts as a word) and a removed marker in it takes its unit.
//   * After a block was cut, a removed marker still in it (nothing should be) takes the whole block, and what is left is read again.
//
// One pass over each block, no backtracking: every character is looked at a constant number of times, so 20,000 characters of `[` or of `.` cost
// what 20,000 of `a` do (a hostile-input timing test sits next to the function's tests).
//
// The implementation lives in `./markers.ts` (marker groups), `./segment.ts` (blocks cut into units), `./boundary.ts` (the positional rule) and
// `./remove.ts` (the orchestration); this module is the facade over them.
export { isSubsequence, removeClaims } from './remove.ts';
export type { ClaimRemoval } from './remove.ts';
