import { findCodeRanges } from './code.ts';

const OPEN = '';
const CLOSE = '';
const HOLD = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

const HTML_TAGS =
  'a|b|i|u|s|em|strong|del|ins|sub|sup|br|hr|p|div|span|img|kbd|mark|details|summary|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code';
const HTML_TAG = new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^<>]*)?/?>`, 'gi');

const ENTITY_REF = /(?<!\\)\[\[(?:thread|file|page|task):[^[\]\n|]{1,512}\]\]/g;
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g;

/**
 * Markdown to the text a reader sees, for `body_plain` and search: markers and link targets are dropped, link and image
 * text stays, code (spans and fences) is kept verbatim, `@mentions`, `#channels` and `[[entity]]` refs are left as typed.
 * Not a renderer: it covers what a chat composer produces (headings, emphasis, strike, links, images, quotes, lists, tables,
 * rules, fences, a few inline HTML tags). Never throws.
 */
export function toPlainText(markdown: string): string {
  const held: string[] = [];
  const hold = (text: string): string => `${OPEN}${held.push(text) - 1}${CLOSE}`;

  // Our placeholder characters are private use; a body that already holds them cannot collide.
  let text = markdown.replace(/\r\n?/g, '\n').replaceAll(OPEN, '').replaceAll(CLOSE, '');

  // 1. Code first, so nothing below touches it.
  let out = '';
  let at = 0;
  for (const code of findCodeRanges(text)) {
    out += text.slice(at, code.start) + hold(text.slice(code.contentStart, code.contentEnd));
    at = code.end;
  }
  text = out + text.slice(at);

  // 2. Things that must survive verbatim and must not be read as markdown: entity refs and escaped punctuation.
  text = text.replace(ENTITY_REF, (m) => hold(m)).replace(ESCAPABLE, (_m, ch: string) => hold(ch));

  // 3. Block markers, line by line.
  text = text
    .split('\n')
    .flatMap((raw) => {
      let line = raw;
      if (/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes('|')) return []; // table rule
      if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line) || /^ {0,3}=+[ \t]*$/.test(line)) return []; // rule / setext underline
      if (/^ {0,3}\[[^\]]+\]:\s+\S+(\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.test(line)) return []; // link reference definition
      line = line.replace(/^[ \t]*(?:>[ \t]?)+/, ''); // quote
      line = line.replace(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/, (_m, body: string | undefined) => body ?? ''); // heading
      line = line.replace(/^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '$1'); // list item, task box
      if (/^[ \t]*\|/.test(line)) line = line.replace(/^[ \t]*\|[ \t]*/, '').replace(/[ \t]*\|[ \t]*$/, '').replace(/[ \t]*\|[ \t]*/g, '  '); // table row
      return [line.replace(/(?:[ \t]{2,}|\\)$/, '').replace(/[ \t]+$/, '')];
    })
    .join('\n');

  // 4. Inline markup.
  text = text
    .replace(/!\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, '$1') // image
    .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, '$1') // link
    .replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1') // reference link
    .replace(/<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+)>/gi, '$1') // autolink
    .replace(HTML_TAG, '');
  for (let pass = 0; pass < 3; pass++) {
    text = text
      .replace(/(?<![\p{L}\p{N}*])(\*{1,3})(?=[^\s*])([\s\S]*?[^\s*])\1(?![\p{L}\p{N}*])/gu, '$2')
      .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=[^\s_])([\s\S]*?[^\s_])\1(?![\p{L}\p{N}_])/gu, '$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  }

  // 5. Put code and escapes back; tidy blank lines.
  const restore = (s: string): string => s.replace(HOLD, (_m, i: string) => restore(held[Number(i)] ?? ''));
  return restore(text).replace(/\n{3,}/g, '\n\n').trim();
}
