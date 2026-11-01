import { IMPORT_SKIP_WORDS, IMPORT_SKIP_WORDS_ONE, importSkipPhrase, type ImportChannelLine, type ImportRun, type ImportSource, type ImportStatus } from '@manythreads/shared';

// What the Import screen says, kept apart from the screen so it can be tested without a browser.

export const SOURCE_NAMES: Record<ImportSource, string> = { slack: 'Slack', mattermost: 'Mattermost' };

/** What to tell the admin about the file they can pick, per source. */
export const SOURCE_HELP: Record<ImportSource, string> = {
  slack: 'The zip file Slack gives you from Settings, Import/Export Data, Export. Do not unpack it.',
  mattermost: 'The file made by "mmctl export create" and downloaded, either the zip or the JSON-lines file inside it.',
};

/** The accept attribute of the file picker; the server reads the first bytes whatever the name says. */
export const SOURCE_ACCEPT: Record<ImportSource, string> = { slack: '.zip', mattermost: '.zip,.jsonl,.json' };

export const STATUS_WORDS: Record<ImportStatus, string> = {
  uploaded: 'Uploaded, not read yet',
  analysing: 'Reading the archive',
  analysed: 'Dry run finished',
  queued: 'Waiting to start',
  running: 'Importing',
  done: 'Finished',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

/** A run that a background job is working on: the screen keeps asking until it is over. */
export const isActive = (status: ImportStatus): boolean => status === 'analysing' || status === 'queued' || status === 'running';

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

/** How far a running import is, 0 to 1; null when it has not said (or has nothing to do). */
export function progressFraction(run: Pick<ImportRun, 'progress'>): number | null {
  const p = run.progress;
  if (!p || p.messagesTotal <= 0) return null;
  return Math.max(0, Math.min(1, p.messagesDone / p.messagesTotal));
}

export function progressWords(run: Pick<ImportRun, 'status' | 'progress'>): string {
  const p = run.progress;
  if (run.status === 'queued') return 'Waiting for a free moment on the server.';
  if (!p) return run.status === 'analysing' ? 'Reading the archive. Nothing is written.' : 'Starting.';
  const phase = p.phase === 'people' ? 'Matching people' : p.phase === 'channels' ? 'Making channels' : p.phase === 'messages' ? 'Writing messages' : 'Finishing';
  return p.messagesTotal > 0 ? `${phase}: ${p.messagesDone.toLocaleString('en-US')} of ${p.messagesTotal.toLocaleString('en-US')} messages.` : `${phase}.`;
}

/** The sentence for a left-out kind, with its count. */
export function skippedLine(reason: keyof typeof IMPORT_SKIP_WORDS, count: number): string {
  return importSkipPhrase(reason, count);
}

/** What happened to a channel of the archive, in words ("left out (direct conversation where someone has no account here)", never a code). */
export function channelOutcomeWords(c: Pick<ImportChannelLine, 'outcome' | 'reason' | 'becomes'>): string {
  if (c.outcome === 'skip') return c.reason ? `left out (${IMPORT_SKIP_WORDS_ONE[c.reason]})` : 'left out';
  if (c.outcome === 'exists') return 'already there';
  return c.becomes ? `becomes #${c.becomes}` : 'new';
}

/** Whether the picked file looks too big for the server's default limit (1 GB); the server has the last word. */
export const DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024;
export const tooBigWarning = (bytes: number): string | null =>
  bytes > DEFAULT_LIMIT_BYTES ? `That file is ${formatSize(bytes)}. Servers accept up to ${formatSize(DEFAULT_LIMIT_BYTES)} unless the operator raised the limit; the upload will say if it is refused.` : null;

/** What the buttons of a run offer, from its status. */
export function actionsFor(status: ImportStatus): { dryRun: boolean; start: boolean; cancel: boolean; remove: boolean } {
  return {
    dryRun: status === 'uploaded' || status === 'analysed',
    start: status === 'analysed',
    cancel: isActive(status),
    remove: !isActive(status),
  };
}
