import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { flattenExtensions, resolveExtensions, sortExtensions, type AnyExtension, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { splitFrontmatter } from '../frontmatter';

/*
 * Markdown <-> Tiptap document, with no DOM: the editor and the unit tests use the same extension list and the same manager.
 * Rules the viewer relies on:
 *  - the frontmatter block is kept verbatim and never goes through the parser;
 *  - text the person did not touch is never re-serialised (the viewer keeps the original bytes until a user edit);
 *  - after an edit the whole body is serialised once, then tidied (runs of blank lines collapsed outside code fences).
 */

/** The content extensions (schema); the editor adds the Markdown extension and the slash menu on top. */
export const contentExtensions = (): AnyExtension[] => [
  StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
  Image.configure({ inline: true, allowBase64: false }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
];

let manager: MarkdownManager | undefined;
const getManager = (): MarkdownManager => {
  manager ??= new MarkdownManager({
    extensions: sortExtensions(flattenExtensions(resolveExtensions(contentExtensions()))),
  });
  return manager;
};

export const parseMarkdown = (markdown: string): JSONContent => getManager().parse(markdown);

/** Collapse runs of blank lines to one outside fenced code blocks, trim the end to a single newline. */
export function tidyMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let blank = 0;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && f?.[1]) fence = f[1][0] ?? null;
    else if (fence !== null && f?.[1] && f[1][0] === fence && line.trim() === f[1]) fence = null;
    if (fence === null && line.trim() === '') {
      blank++;
      if (blank > 1) continue;
    } else blank = 0;
    out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

export const serializeMarkdown = (doc: JSONContent): string => {
  const out = getManager().serialize(doc);
  return /\S/.test(out) ? tidyMarkdown(out) : '';
};

/** Body text to the JSON the editor shows. */
export const bodyToDoc = (text: string): { frontmatter: string; doc: JSONContent } => {
  const { frontmatter, body } = splitFrontmatter(text);
  return { frontmatter, doc: parseMarkdown(body) };
};

/** Editor document back to the file's text: the original frontmatter first, then the body. */
export const docToText = (frontmatter: string, doc: JSONContent): string => frontmatter + serializeMarkdown(doc);
