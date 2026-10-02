/**
 * `messages.body_plain`: the markdown body without its markup, derived by the server on every write and used by search.
 * Deliberately simple (no markdown parser): code keeps its text, links and images their label, `[[entity]]` its name, headings,
 * quotes, list bullets, emphasis and HTML tags lose their marks, whitespace collapses. `@person` and `#channel` stay as written.
 */
export function markdownToPlain(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, '\n');
  s = s.replace(/```[^\n`]*\n([\s\S]*?)```/g, '$1').replace(/```/g, '');
  s = s.replace(/`([^`\n]{0,2000})`/g, '$1');
  s = s.replace(/!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, '$1');
  s = s.replace(/\[\[([^\]\n]{1,500})\]\]/g, '$1');
  s = s.replace(/\[([^\]\n]{1,500})\]\([^)\n]{0,2000}\)/g, '$1');
  s = s.replace(/<\/?[a-zA-Z][^>\n]{0,500}>/g, ' ');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '');
  s = s.replace(/(\*\*|__|~~)/g, '');
  s = s.replace(/(^|[\s(])[*_]+(?=\S)/g, '$1').replace(/(?<=\S)[*_]+(?=$|[\s).,!?:;])/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** What the API serves in place of the text of a deleted message. */
export const DELETED_BODY = '[deleted]';
