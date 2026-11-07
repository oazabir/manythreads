import type { InboxHoldReason, MemoryConceptSummary, PersonalInboxItem, PersonalMemoryAuthorKind } from '@manythreads/shared';

/*
 * The plain words and small rules of a person's own Memory and inbox (the Personal side of the Memory screen), kept apart from the components so a test can
 * read them. Nothing here touches the network. A person's own space is never shown to anyone else, so the words speak to "you".
 */

/** Where the Personal side of the screen lives: `/memory`, and the same screen under a team is `/t/<team>/memory`. */
export const PERSONAL_MEMORY_HREF = '/memory';
export const personalConceptLink = (path: string): string => `/memory?concept=${encodeURIComponent(path)}`;
export const personalInboxHref = '/memory?tab=inbox';

/** A path as the store keeps it. A `memory/` in front (the team folder's name) is accepted by the server and removed, so a link may carry either. */
export const bundlePath = (path: string): string => (path.startsWith('memory/') ? path.slice('memory/'.length) : path);
export const samePath = (a: string, b: string): boolean => bundlePath(a) === bundlePath(b);

/** The concept a link names, found among the person's own files (the path may or may not carry the `memory/` the inbox writes). */
export function findConcept<T extends Pick<MemoryConceptSummary, 'path'>>(concepts: readonly T[], wanted: string | null): T | null {
  if (!wanted) return null;
  return concepts.find((c) => c.path === wanted) ?? concepts.find((c) => samePath(c.path, wanted)) ?? null;
}

/** The titles of the person's files by bundle path, so a path in either spelling finds its title (`titleFor`). */
export const conceptTitles = (concepts: readonly Pick<MemoryConceptSummary, 'path' | 'title'>[]): Map<string, string> => new Map(concepts.map((c) => [bundlePath(c.path), c.title]));
export const titleFor = (titles: ReadonlyMap<string, string>, path: string): string | undefined => titles.get(bundlePath(path));

const isReference = (p: string): boolean => bundlePath(p).startsWith('references/');
/** The files an inbox item became, except the Reference (the platform's own record of the original). */
export const filedFiles = (item: Pick<PersonalInboxItem, 'filedPaths'>): string[] => item.filedPaths.filter((p) => !isReference(p));
/** The Reference an item left. */
export const filedReference = (item: Pick<PersonalInboxItem, 'filedPaths'>): string | null => item.filedPaths.find(isReference) ?? null;

const HOLD_WORDS: Record<InboxHoldReason, string> = {
  review_all: 'It waits for you to look at it first.',
  unknown_sender: 'It came from an address you have not vouched for.',
  failed_sender_check: 'The sender could not be verified.',
  foreign_bundle: 'It looks like a memory bundle from somewhere else. A bundle cannot be imported into your memory, so letting it through will fail.',
  dlp: 'The data-protection check found what looks like private data, such as a key or a card number. Look at it before you let it through.',
  oversize: 'It is larger than the inbox takes without a look. Let it through to read it anyway, or discard it.',
};

export const personalHoldSentence = (reason: InboxHoldReason): string => HOLD_WORDS[reason];

/** The line under an item's name: the server's own sentence when it wrote one, else words for the state. */
export function personalSentence(item: Pick<PersonalInboxItem, 'state' | 'reason' | 'holdReason'>): string | null {
  if (item.reason) return item.reason;
  switch (item.state) {
    case 'queued':
      return 'Waiting for its turn.';
    case 'extracting':
      return 'Being read into plain text.';
    case 'filing':
      return 'Being filed in your memory.';
    case 'held':
      return item.holdReason ? personalHoldSentence(item.holdReason) : 'It waits for you to decide.';
    case 'duplicate':
      return 'The same file is already in your inbox, so nothing new was written.';
    case 'failed':
      return 'It could not be filed. Try again, or discard it.';
    default:
      return null;
  }
}

/** What the owner may do with an item. A filed item is a file in Memory now (delete it there), so it cannot be discarded. */
export function personalActions(item: Pick<PersonalInboxItem, 'state' | 'originalKept'>): { retry: boolean; release: boolean; discard: boolean; sendToTeam: boolean } {
  const s = item.state;
  return {
    retry: s === 'failed',
    release: s === 'held',
    discard: s === 'queued' || s === 'held' || s === 'failed',
    sendToTeam: item.originalKept && (s === 'filed' || s === 'queued' || s === 'extracting' || s === 'filing' || s === 'failed'),
  };
}

/** The line a person is told when an item moved. */
export function personalNotice(item: Pick<PersonalInboxItem, 'state' | 'name' | 'filedPaths'>): string | null {
  switch (item.state) {
    case 'filed': {
      const n = filedFiles(item).length;
      return n > 0 ? `Filed ${String(n)} ${n === 1 ? 'file' : 'files'} from ${item.name} in your memory` : `Filed ${item.name} in your memory as a reference`;
    }
    case 'held':
      return `${item.name} is held until you look at it`;
    case 'failed':
      return `${item.name} could not be filed`;
    default:
      return null;
  }
}

const AUTHORS: Record<PersonalMemoryAuthorKind, string> = {
  person: 'You',
  bot: 'A bot, in a conversation you started',
  system: 'The platform, filing from your inbox',
};
export const authorLabel = (kind: PersonalMemoryAuthorKind): string => AUTHORS[kind];

/** "Version 3 · 2.1 KB". */
export function versionLine(file: { versionNo: number; sizeBytes: number }): string {
  const size = file.sizeBytes < 1024 ? `${String(file.sizeBytes)} B` : file.sizeBytes < 1024 * 1024 ? `${(file.sizeBytes / 1024).toFixed(1)} KB` : `${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `Version ${String(file.versionNo)} · ${size}`;
}

/** Whether a failed save was the "changed since you opened it" refusal (HTTP 409), so the screen offers to reload instead of only showing the sentence. */
export const isChangedSince = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 409;

/** What a team's name is called in the Send to team dialog: the team name, then the slug it is sent to. */
export function teamChoiceLabel(team: { name: string; slug: string }): string {
  return team.name === team.slug ? team.name : `${team.name} (${team.slug})`;
}
