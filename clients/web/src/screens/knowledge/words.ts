import type { KnowledgeBaseState, KnowledgeDocument, KnowledgeSearchMode } from '@manythreads/shared';
import { spaceHref } from '../files/spaces';

/*
 * The plain words and small rules of the Knowledge screen, kept apart from the components so a test can read them. Nothing here touches the network.
 */

/** A name a person types, as the base's address-safe name: lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters. Null when nothing usable is left. */
export function slugFromName(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug === '' ? null : slug;
}

/** An address for a base whose name has nothing an address can be made of (a name written in another script): `base-` and a few letters and digits. */
export const fallbackSlug = (): string => `base-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

const STATE_WORDS: Record<KnowledgeBaseState, string> = {
  ready: 'Ready: every document can be searched',
  attention: 'Needs attention: a document could not be read',
  empty: 'Empty: add a document to start',
};
export const stateSentence = (state: KnowledgeBaseState): string => STATE_WORDS[state];

export const searchModeSentence = (mode: KnowledgeSearchMode): string =>
  mode === 'hybrid'
    ? 'Searched by the words in a question and by their meaning.'
    : 'Searched by the words in a question. Meaning-based search needs an embedding model, which this workspace has not been given.';

export const KIND_LABEL: Record<KnowledgeDocument['kind'], string> = { markdown: 'Markdown', text: 'Text', csv: 'CSV', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' };

/** The kinds a personal base reads; the file picker offers only these. */
export const ACCEPTED_FILES = '.md,.markdown,.txt,.csv,.pdf,text/markdown,text/plain,text/csv,application/pdf';

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What an upload became, as a sentence. */
export function uploadSentence(outcome: 'added' | 'updated' | 'unchanged' | 'failed', doc: Pick<KnowledgeDocument, 'name' | 'chunkCount' | 'version' | 'reason'>): string {
  switch (outcome) {
    case 'added':
      return `${doc.name} was added (${countLine(doc.chunkCount, 'passage', 'passages')}).`;
    case 'updated':
      return `${doc.name} changed and is now at version ${String(doc.version)}.`;
    case 'unchanged':
      return `${doc.name} has the same content as before, so nothing changed.`;
    case 'failed':
      return `${doc.name} could not be read. ${doc.reason ?? ''}`.trim();
  }
}

export const countLine = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/**
 * Where a team's knowledge lives in Files: every base is a folder `knowledge/<base>` in the team's files (the converted text of each document, and the Markdown or
 * text files people put there to be read in). The Files screen opens a folder by `?path=`, so these are plain links; a person uploads, renames and deletes there.
 * A Personal base has no folder in Files: its documents are kept by the knowledge plugin alone.
 */
export const knowledgeFolder = (base?: string): string => (base ? `knowledge/${base}` : 'knowledge');
export const knowledgeFilesHref = (team: string, base?: string): string => spaceHref(team, { folder: knowledgeFolder(base) });
export const knowledgeFilesLabel = (teamName: string): string => `Open ${teamName} knowledge folder in Files`;

/** What a source is, in one line each: shown above the Sources of a base and on the Knowledge screen. */
export const SOURCES_INTRO = 'Sources are where Brain and the bots read from. Each base is filled by one or more of them, and they search only what has been read in.';
export const SOURCE_CHOICES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'upload', text: 'Upload a file: a Markdown, text, CSV or PDF file is turned into text and added to the base.' },
  { id: 'folder', text: 'The base’s folder in Files: Markdown and text files kept there are read in, so you can add, edit and delete them in Files and then press Read again.' },
  { id: 'url', text: 'A web page: one address, read again on the schedule you choose.' },
  { id: 'app', text: 'A connected app: a folder from Drive, Notion and the like, read with your own sign-in and kept up to date.' },
];

/** The Personal side: a base has only the first and last choice, and its documents are kept here, not in Files. */
export const PERSONAL_SOURCES_INTRO = 'Sources are where Brain reads from. Upload a file to this base, or add a folder from a connected app. Both are kept here, not in Files, and only you can search them.';
