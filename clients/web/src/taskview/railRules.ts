import type { FileSummary, ThreadFileItem, TodoItem } from '@manythreads/shared';
import { isPreviewableImage } from '../channels/images';
import { currentItem, todoProgress } from '../channels/todo-card/words';

/*
 * The rules of the thread's side rail (P29-20, docs/plans/channel-task-view.md section 10e): how the to-do list is drawn as a vertical timeline and what stage it is at, and which
 * files the Outputs part shows as pictures and which as a list. Pure, so each rule is tested without a screen.
 */

/** How many files the Outputs part lists before "Show all files". */
export const OUTPUTS_CAP = 20;
/** How many of the newest pictures get a preview. */
export const PREVIEW_COUNT = 2;

export type Stage = 'none' | 'not-started' | 'working' | 'blocked' | 'done';

export interface ListStage {
  stage: Stage;
  /** The words the head of the rail says: "In progress", "Waiting for you", "Not started", "All done". */
  label: string;
  /** "2 of 5 done", or null with no list. */
  count: string | null;
  pct: number;
}

/** Which stage the whole list is at: all done, something blocked (waiting on a person or a card), something being worked on, or nothing started yet. */
export function listStage(items: readonly Pick<TodoItem, 'status'>[]): ListStage {
  if (items.length === 0) return { stage: 'none', label: '', count: null, pct: 0 };
  const p = todoProgress(items);
  const count = `${p.done} of ${p.total} done`;
  const pct = Math.round((p.done / p.total) * 100);
  if (p.allDone) return { stage: 'done', label: 'All done', count, pct };
  if (p.blocked > 0 && p.working === 0) return { stage: 'blocked', label: 'Waiting', count, pct };
  if (p.working > 0 || p.done > 0) return { stage: 'working', label: 'In progress', count, pct };
  return { stage: 'not-started', label: 'Not started', count, pct };
}

export interface Timeline {
  /** The finished steps that came before the first open one, folded into one line; empty when there is nothing to fold. */
  earlier: TodoItem[];
  /** The rest in the list's own order: the current step, the ones blocked, the ones to come (and a finished step after an open one). */
  steps: TodoItem[];
  /** The step the list is at (being worked on, else blocked, else the next to do), or null when all are done. */
  current: TodoItem | null;
}

/**
 * The list as a timeline: the finished steps in front of the first open one fold into "N earlier steps" (two or more; a single one reads as itself), the rest keep their order.
 * A list that is all done is shown whole, with nothing folded.
 */
export function timelineOf(items: readonly TodoItem[]): Timeline {
  const current = currentItem(items);
  if (current === null) return { earlier: [], steps: [...items], current: null };
  const firstOpen = items.findIndex((i) => i.status !== 'done');
  const lead = items.slice(0, firstOpen);
  if (lead.length >= 2) return { earlier: lead, steps: items.slice(firstOpen), current };
  return { earlier: [], steps: [...items], current };
}

/** "3 earlier steps", "1 earlier step". */
export const earlierLabel = (n: number): string => `${n} earlier ${n === 1 ? 'step' : 'steps'}`;

export interface OutputsPlan {
  /** The newest pictures, up to `PREVIEW_COUNT`, drawn as thumbnails. */
  previews: ThreadFileItem[];
  /** Every other file (older pictures included), compact, the newest first, up to the cap. */
  list: ThreadFileItem[];
  /** Files beyond the cap that "Show all files" reveals (or that the server still holds beyond the ones loaded). */
  more: number;
}

/**
 * Splits the thread's files (newest first) into the previews and the list. The server's `total` counts all files; `loaded` may be fewer, so `more` is the larger of what is cut
 * here and what was not loaded.
 */
export function planOutputs(items: readonly ThreadFileItem[], total: number, showAll: boolean, cap = OUTPUTS_CAP): OutputsPlan {
  const previews = items.filter((i) => isPreviewableImage(i.file)).slice(0, PREVIEW_COUNT);
  const ids = new Set(previews.map((p) => p.file.id));
  const rest = items.filter((i) => !ids.has(i.file.id));
  const list = showAll ? rest : rest.slice(0, cap);
  const more = Math.max(0, total - previews.length - list.length);
  return { previews, list, more };
}

/** The type label of a file in plain words ("PDF", "Image", "Markdown", "Archive", "File"), never a raw MIME type. */
export function typeLabel(file: Pick<FileSummary, 'name' | 'mime'>): string {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(file.name)?.[1] ?? '').toLowerCase();
  if (file.mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (file.mime.startsWith('image/')) return 'Image';
  if (file.mime.startsWith('video/')) return 'Video';
  if (file.mime.startsWith('audio/')) return 'Audio';
  if (ext === 'md' || ext === 'markdown') return 'Markdown';
  if (['zip', 'gz', 'tgz', 'tar', '7z'].includes(ext)) return 'Archive';
  if (['csv', 'xlsx', 'xls', 'tsv'].includes(ext)) return 'Spreadsheet';
  if (['doc', 'docx', 'odt', 'txt', 'rtf'].includes(ext) || file.mime.startsWith('text/')) return 'Document';
  return 'File';
}

/** The message ids that carry files, joined: the rail reads its files again when this changes (a new attachment, a deleted message). */
export function attachmentKey(messages: ReadonlyArray<{ id: string; attachments?: readonly unknown[] | undefined; deletedAt?: string | null | undefined }>): string {
  return messages.filter((m) => (m.attachments?.length ?? 0) > 0 && !m.deletedAt).map((m) => `${m.id}:${m.attachments!.length}`).join(',');
}

// ---- the open state, kept per person in this browser ----------------------------------------------------------------------------------

const OPEN_KEY = 'mt.tv.rail';
let openMemory: boolean | null = null;

/** Whether the person left the rail open; `null` when they never chose. A blocked storage means the choice lasts until the tab closes. */
export function readRailOpen(): boolean | null {
  if (openMemory !== null) return openMemory;
  try {
    const v = globalThis.localStorage?.getItem(OPEN_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeRailOpen(open: boolean): void {
  openMemory = open;
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // kept for this tab only
  }
}

/** For tests. */
export function forgetRailOpen(): void {
  openMemory = null;
}
