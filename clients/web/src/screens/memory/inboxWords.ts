import type { InboxHoldReason, InboxItem, InboxKind, InboxOrigin, InboxState } from '@manythreads/shared';

/*
 * The plain words and small rules of the Memory screen's Inbox tab, kept apart from the components so a test can read them. Nothing here touches the network.
 * The server writes a sentence for the state of an item (`reason`); these words are the fallback, and the labels of the filters, the buttons and the notices.
 */

export type FilterId = 'all' | 'processing' | 'needs_review' | 'held' | 'filed' | 'failed';

export const FILTERS: ReadonlyArray<{ id: FilterId; label: string; states: readonly InboxState[] }> = [
  { id: 'all', label: 'All', states: ['queued', 'extracting', 'filing', 'filed', 'held', 'failed', 'duplicate', 'needs_review'] },
  { id: 'processing', label: 'Processing', states: ['queued', 'extracting', 'filing'] },
  { id: 'needs_review', label: 'Needs review', states: ['needs_review'] },
  { id: 'held', label: 'Held', states: ['held'] },
  { id: 'filed', label: 'Filed', states: ['filed', 'duplicate'] },
  { id: 'failed', label: 'Failed', states: ['failed'] },
];

export const isFilterId = (value: string | null): value is FilterId => FILTERS.some((f) => f.id === value);

export const inFilter = (item: Pick<InboxItem, 'state'>, filter: FilterId): boolean => (FILTERS.find((f) => f.id === filter)?.states ?? []).includes(item.state);

/** How many items each filter would show. */
export function countsByFilter(items: readonly Pick<InboxItem, 'state'>[]): Record<FilterId, number> {
  const out = { all: 0, processing: 0, needs_review: 0, held: 0, filed: 0, failed: 0 } satisfies Record<FilterId, number>;
  for (const f of FILTERS) out[f.id] = items.filter((i) => inFilter(i, f.id)).length;
  return out;
}

/** An item is still moving: the page asks again until it stops. */
export const isProcessing = (item: Pick<InboxItem, 'state'>): boolean => item.state === 'queued' || item.state === 'extracting' || item.state === 'filing';

export type Look = { tone: 'ok' | 'warn' | 'bad' | 'idle'; glyph: string; label: string };

/** One word for where an item stands, with a shape as well as a colour. */
export function itemLook(item: Pick<InboxItem, 'state'>): Look {
  switch (item.state) {
    case 'queued':
      return { tone: 'idle', glyph: '…', label: 'Waiting' };
    case 'extracting':
      return { tone: 'idle', glyph: '…', label: 'Reading' };
    case 'filing':
      return { tone: 'idle', glyph: '…', label: 'Filing' };
    case 'filed':
      return { tone: 'ok', glyph: '✓', label: 'Filed' };
    case 'duplicate':
      return { tone: 'idle', glyph: '=', label: 'Already dropped' };
    case 'held':
      return { tone: 'warn', glyph: '!', label: 'Held' };
    case 'needs_review':
      return { tone: 'warn', glyph: '?', label: 'Needs review' };
    case 'failed':
      return { tone: 'bad', glyph: '!', label: 'Failed' };
    case 'discarded':
      return { tone: 'idle', glyph: '–', label: 'Discarded' };
  }
}

const HOLD_WORDS: Record<InboxHoldReason, string> = {
  review_all: 'This team checks every drop before anything reads it.',
  unknown_sender: 'It came from an address nobody on the team has vouched for.',
  failed_sender_check: 'The sender could not be verified.',
  foreign_bundle: 'It looks like a memory bundle from somewhere else, and importing one is not available yet.',
  dlp: 'The data-protection check asked for a person to look at it first.',
  oversize: 'It is larger than this team lets through without a look.',
};

export const holdSentence = (reason: InboxHoldReason): string => HOLD_WORDS[reason];

/** The line under an item's name: the server's own sentence when it wrote one, else words for the state. */
export function itemSentence(item: Pick<InboxItem, 'state' | 'reason' | 'holdReason' | 'filedPaths' | 'duplicateOf'>): string | null {
  if (item.reason) return item.reason;
  switch (item.state) {
    case 'queued':
      return 'Waiting for its turn.';
    case 'extracting':
      return 'Being read into plain text.';
    case 'filing':
      return 'Being turned into memory.';
    case 'held':
      return item.holdReason ? holdSentence(item.holdReason) : 'A team lead has to look at this before it is read.';
    case 'needs_review':
      return 'The result could not be used as it came. A team lead can file it as a reference only.';
    case 'duplicate':
      return 'The same file was dropped before, so nothing new was written.';
    case 'failed':
      return 'It could not be filed.';
    default:
      return null;
  }
}

const REFERENCES = 'memory/references/';

/** The concepts an item became: every path it wrote except the reference (the platform's own record of the original). */
export const filedConcepts = (item: Pick<InboxItem, 'filedPaths'>): string[] => item.filedPaths.filter((p) => !p.startsWith(REFERENCES));
/** The reference an item left, when it left one. */
export const filedReference = (item: Pick<InboxItem, 'filedPaths'>): string | null => item.filedPaths.find((p) => p.startsWith(REFERENCES)) ?? null;

/** The file name of a concept path, without the folder and the `.md`, as a fallback when its title is not known. */
export const conceptName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');

/** Where a concept is shown in the Memory screen. */
export const conceptLink = (slug: string, path: string): string => `/t/${encodeURIComponent(slug)}/memory?concept=${encodeURIComponent(path)}`;
/** The Inbox tab itself (the Files `inbox/` row opens it, so do the notices). */
export const inboxLink = (slug: string): string => `/t/${encodeURIComponent(slug)}/memory?tab=inbox`;

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The line a person is told when an item moves: "Filed 3 concepts from Design review notes". Null when there is nothing to say yet. */
export function noticeCopy(item: Pick<InboxItem, 'state' | 'name' | 'filedPaths'>): string | null {
  switch (item.state) {
    case 'filed': {
      const n = filedConcepts(item).length;
      return n > 0 ? `Filed ${plural(n, 'concept', 'concepts')} from ${item.name}` : `Filed ${item.name} as a reference`;
    }
    case 'held':
      return `${item.name} is held until a team lead looks at it`;
    case 'needs_review':
      return `${item.name} needs a look before it is filed`;
    case 'failed':
      return `${item.name} could not be filed`;
    default:
      return null;
  }
}

const KIND_WORDS: Record<InboxKind, string> = {
  markdown: 'Note',
  text: 'Text',
  csv: 'Spreadsheet (CSV)',
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'Slides',
  xlsx: 'Spreadsheet',
  eml: 'Email',
  html: 'Web page',
  image: 'Picture',
  audio: 'Recording',
  video: 'Video',
  link: 'Web address',
  bundle: 'Memory bundle',
  unknown: 'File',
};
export const kindLabel = (kind: InboxKind): string => KIND_WORDS[kind];

const ORIGIN_WORDS: Record<InboxOrigin, string> = {
  person: 'Dropped',
  message: 'Sent from a message',
  email: 'Emailed',
  share: 'Shared by another team',
  bot: 'Dropped by a bot',
};
export const originLabel = (origin: InboxOrigin): string => ORIGIN_WORDS[origin];

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The problem with a file the page can see before sending it; the server has the last word. */
export function dropProblem(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > maxBytes) return `${file.name} is larger than the ${String(Math.max(1, Math.floor(maxBytes / 1024 / 1024)))} MB limit.`;
  return null;
}

/** What a person on the team may do with an item. A lead or admin (`canManage`) releases, discards and retries; nobody else does. */
export function itemActions(item: Pick<InboxItem, 'state'>, canManage: boolean): { retry: boolean; release: boolean; discard: boolean } {
  if (!canManage) return { retry: false, release: false, discard: false };
  return {
    retry: item.state === 'failed',
    release: item.state === 'held' || item.state === 'needs_review',
    discard: item.state === 'queued' || item.state === 'held' || item.state === 'needs_review' || item.state === 'failed',
  };
}

/** The address the team's email door answers on, when the server told us one. */
export function emailAddressOf(answer: { emailAddress?: string | null | undefined }): string | null {
  const a = answer.emailAddress?.trim();
  return a ? a : null;
}

export const message = (e: unknown, fallback = 'Something went wrong. Try again.'): string => (e instanceof Error && e.message !== '' ? e.message : fallback);
