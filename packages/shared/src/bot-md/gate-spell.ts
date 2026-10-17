/** Letters, digits and spacing combining marks (the vowel signs of Devanagari, Bengali, Tamil…, which would otherwise cut a word in two). */
const WORDS = /[\p{L}\p{N}\p{Mc}]+/gu;
/** Scripts written without spaces between words: a phrase in one of them is found inside a run of text, not as a whole word. */
export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Look-alike letters folded to the Latin letter they imitate, after lower-casing and NFKD. Scope, stated plainly: the Cyrillic and Greek letters that
 * pass for Latin ones in ordinary type, plus dotless i and script g. It is applied to the gate list and to the message alike, so a phrase written in
 * Cyrillic or Greek still matches itself (and, as a cost, can also match a Latin word that looks the same). It does not catch leetspeak (`cr3dential`),
 * letters spaced apart (`c r e d e n t i a l`), typos, translations or text in an image; those are the classifier's (stage two) and a person's.
 */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l', ѵ: 'v',
  // Greek
  α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ϲ: 'c', ϳ: 'j',
  // Latin look-alikes outside ASCII
  ı: 'i', ɡ: 'g',
};
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');
/**
 * Characters that draw nothing: format characters (`\p{Cf}`: zero-width space and joiners, soft hyphen, bidi controls, word joiner, tags), C0/C1 control
 * characters other than tab, line feed and carriage return, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the Braille blank (U+2800).
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\u115f\u1160\u3164\uffa0\u2800]/gu;
const keepsWhitespace = (ch: string): boolean => ch === '\t' || ch === '\n' || ch === '\r';
const MARKS = /[\p{Mn}\p{Me}\u0640]/gu;

/**
 * The two spellings of a text the gate reads (SPEC §7.3 stage one must not be beaten by typography). Both are NFKD (full-width and styled letters
 * become plain ones, accents split off), lower-cased, stripped of combining marks (accents, Arabic harakat) and the Arabic tatweel, and folded through
 * `LOOKALIKES`. They differ in what an invisible character (zero-width space or joiner, soft hyphen, bidi marks, a control character, a Hangul filler, the Braille blank) becomes: nothing
 * (`joined`: `cre<ZWSP>dential` is `credential`) or a space (`spaced`: `drop<ZWSP>table` is two words). A phrase is compared in both spellings,
 * so inserting such a character *inside* a word or *instead of* a space changes nothing. Linear in the text.
 */
export function gateSpellings(text: string): { joined: string; spaced: string } {
  const base = text.normalize('NFKD').toLowerCase();
  const fold = (s: string): string => s.replace(MARKS, '').replace(LOOKALIKE, (ch) => LOOKALIKES[ch] ?? ch);
  const joined = fold(base.replace(INVISIBLE, (ch) => (keepsWhitespace(ch) ? ch : '')));
  const spaced = fold(base.replace(INVISIBLE, (ch) => (keepsWhitespace(ch) ? ch : ' ')));
  return { joined, spaced };
}

export const wordsOf = (folded: string): string[] => Array.from(folded.matchAll(WORDS), (m) => m[0]);
