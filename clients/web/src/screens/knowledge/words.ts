import type { KnowledgeBaseState, KnowledgeDocument, KnowledgeSearchMode } from '@manythreads/shared';

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

export const KIND_LABEL: Record<KnowledgeDocument['kind'], string> = { markdown: 'Markdown', text: 'Text', csv: 'CSV', pdf: 'PDF' };

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
      return `${doc.name} was added (${String(doc.chunkCount)} passages).`;
    case 'updated':
      return `${doc.name} changed and is now at version ${String(doc.version)}.`;
    case 'unchanged':
      return `${doc.name} has the same content as before, so nothing changed.`;
    case 'failed':
      return `${doc.name} could not be read. ${doc.reason ?? ''}`.trim();
  }
}

export const countLine = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
