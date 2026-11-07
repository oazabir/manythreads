import { parseActionItems } from './action-items.ts';

// The person's own list of actions, `Action items/action-items.md` in their Personal space (PLAN P20-12). It is the same checkbox line the inbox reads
// (`parseActionItems`), with a few indented lines under an action that say where it came from and what happened to it:
//
//     # Action items
//
//     - [ ] Send the revised quote to Acme (owner: Nadia; due: 2026-11-20)
//       - source: mail "Quote for Acme", 3 Nov
//     - [x] Reply to Rafi about the release
//       - source: thread in #eng
//       - why: 6 Nov: marked done because the reply was sent in the thread
//       - card: 0192f0c4-1111-7000-8000-000000000001
//
// A person edits the file by hand or with the list view; the routine "Keep my action items" rewrites it. Rules this file keeps in one place: an action is never
// removed by a rewrite (`reviewActionItemsRewrite`), an action turns done only with a `why:` line saying what showed it, and every edit leaves the rest of the
// file (headings, prose, lines it does not know) exactly as it was. All scans are linear in the size of the text; nothing here throws.

export const ACTION_ITEMS_PATH = 'Action items/action-items.md';
export const ACTION_ITEMS_FOLDER = 'Action items';
export const ACTION_ITEMS_FILE_NAME = 'action-items.md';
type NoteKey = 'source' | 'why' | 'card';

export interface ActionItemEntry {
  /** A short stable name made from the words (`a1b2c3d4`, `-2` after a repeat). It changes when the words change. */
  id: string;
  what: string;
  owner: string | null;
  due: string | null;
  done: boolean;
  /** Where the action came from, one line; null when not written. */
  source: string | null;
  /** What happened to it, oldest first (each line starts with a date when the writer gave one). */
  why: string[];
  /** The board card made from it, when the person added it to a board. */
  cardTaskId: string | null;
}

interface Block {
  entry: ActionItemEntry;
  start: number;
  /** One past the last line of the block (the item line and its indented lines). */
  end: number;
  /** The line index of the first indented note, or `end` when none. */
  notesAt: number;
}

/** A 32-bit FNV-1a of the lower-cased words, as 8 hex characters. Not a secret and not a check of anything: a handle for one line. */
function handle(what: string): string {
  let h = 0x811c9dc5;
  const s = what.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const NOTE_LINE = /^[ \t]{2,}[-*+][ \t]+([a-z]+):[ \t]*(.*)$/i;

function scan(text: string): { lines: string[]; blocks: Block[] } {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^[ \t]/.test(line)) continue;
    const parsed = parseActionItems(line)[0];
    if (!parsed) continue;
    const base = handle(parsed.what);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const entry: ActionItemEntry = {
      id: n === 1 ? base : `${base}-${n}`,
      what: parsed.what,
      owner: parsed.owner,
      due: parsed.due,
      done: parsed.done,
      source: null,
      why: [],
      cardTaskId: null,
    };
    let j = i + 1;
    const notesAt = j;
    while (j < lines.length) {
      const m = NOTE_LINE.exec(lines[j] as string);
      if (!m) break;
      const key = (m[1] as string).toLowerCase();
      const value = (m[2] as string).trim();
      if (key === 'source' && value !== '') entry.source = value.slice(0, 300);
      else if (key === 'why' && value !== '') entry.why.push(value.slice(0, 500));
      else if (key === 'card' && /^[0-9a-f-]{36}$/i.test(value)) entry.cardTaskId = value.toLowerCase();
      j++;
    }
    blocks.push({ entry, start: i, end: j, notesAt });
    i = j - 1;
  }
  return { lines, blocks };
}

/** The actions in the file, in order. */
export function parseActionItemsFile(text: string): ActionItemEntry[] {
  return scan(text).blocks.map((b) => b.entry);
}

const clean = (s: string, max: number): string => s.replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** One action as its line: `- [ ] words (owner: X; due: 2026-11-20)`. */
export function actionLine(item: { what: string; owner: string | null; due: string | null; done: boolean }): string {
  const extra: string[] = [];
  const owner = item.owner === null ? '' : clean(item.owner, 120).replace(/[;()]/g, ' ').trim();
  if (owner !== '') extra.push(`owner: ${owner}`);
  if (item.due !== null) extra.push(`due: ${item.due}`);
  return `- [${item.done ? 'x' : ' '}] ${clean(item.what, 500).replace(/\(\s*(owner|due)\s*:/gi, '[$1:')}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`;
}

const noteLine = (key: NoteKey, value: string): string => `  - ${key}: ${clean(value, key === 'why' ? 500 : 300)}`;

export type ActionItemOp =
  | { op: 'tick'; id: string; done: boolean; why?: string }
  | { op: 'edit'; id: string; what?: string; owner?: string | null; due?: string | null }
  | { op: 'add'; what: string; owner?: string | null; due?: string | null; source?: string | null }
  | { op: 'card'; id: string; taskId: string };

export type ApplyResult = { ok: true; text: string; id: string } | { ok: false; code: 'not_found' | 'empty' | 'too_many'; message: string };

/** `12 Nov` style stamp of an instant, UTC, for the `why:` lines the platform writes. */
export function whyStamp(at: Date): string {
  return `${at.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getUTCMonth()]}`;
}

/** Apply one change a person made on the list, leaving everything else in the file as it was. */
export function applyActionItemOp(text: string, op: ActionItemOp, now: Date = new Date()): ApplyResult {
  const { lines, blocks } = scan(text);
  const stamp = whyStamp(now);
  if (op.op === 'add') {
    const what = clean(op.what, 500);
    if (what === '') return { ok: false, code: 'empty', message: 'Write what needs doing.' };
    if (blocks.length >= 200) return { ok: false, code: 'too_many', message: 'The list is full (200 actions). Tick or remove some first.' };
    const item = { what, owner: op.owner ?? null, due: op.due ?? null, done: false };
    const add = [actionLine(item), ...(op.source ? [noteLine('source', op.source)] : []), noteLine('why', `${stamp}: added by you`)];
    let out: string[];
    if (blocks.length > 0) {
      const at = (blocks[blocks.length - 1] as Block).end;
      out = [...lines.slice(0, at), ...add, ...lines.slice(at)];
    } else {
      const base = [...lines];
      while (base.length > 0 && (base[base.length - 1] as string).trim() === '') base.pop();
      out = [...(base.length > 0 ? base : ['# Action items']), '', ...add];
    }
    const handleOf = parseActionItemsFile(out.join('\n')).find((e) => e.what === what)?.id ?? handle(what);
    return { ok: true, text: ensureEnd(out.join('\n')), id: handleOf };
  }
  const block = blocks.find((b) => b.entry.id === op.id);
  if (!block) return { ok: false, code: 'not_found', message: 'That action is no longer in the list. Reload it.' };
  const out = [...lines];
  const replaceHead = (item: { what: string; owner: string | null; due: string | null; done: boolean }): void => {
    out[block.start] = actionLine(item);
  };
  const insertNote = (key: NoteKey, value: string, replace = false): void => {
    // `why` lines go after the last note; `source` and `card` replace their own line when there is one
    if (replace) {
      for (let i = block.notesAt; i < block.end; i++) {
        const m = NOTE_LINE.exec(out[i] as string);
        if (m && (m[1] as string).toLowerCase() === key) {
          out[i] = noteLine(key, value);
          return;
        }
      }
    }
    out.splice(block.end, 0, noteLine(key, value));
  };
  const e = block.entry;
  let id = e.id;
  if (op.op === 'tick') {
    replaceHead({ ...e, done: op.done });
    if (op.done !== e.done) insertNote('why', `${stamp}: ${op.why && op.why.trim() !== '' ? op.why.trim() : op.done ? 'ticked by you' : 'opened again by you'}`);
  } else if (op.op === 'edit') {
    const what = op.what === undefined ? e.what : clean(op.what, 500);
    if (what === '') return { ok: false, code: 'empty', message: 'An action needs words.' };
    const next = { what, owner: op.owner === undefined ? e.owner : op.owner, due: op.due === undefined ? e.due : op.due, done: e.done };
    replaceHead(next);
    insertNote('why', `${stamp}: edited by you`);
  } else {
    insertNote('card', op.taskId, true);
    insertNote('why', `${stamp}: added to a board`);
  }
  const next = out.join('\n');
  if (op.op === 'edit' && op.what !== undefined) {
    id = parseActionItemsFile(next)[blocks.indexOf(block)]?.id ?? id;
  }
  return { ok: true, text: ensureEnd(next), id };
}

const ensureEnd = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/** The starting file of a person who has none yet. */
export const EMPTY_ACTION_ITEMS_FILE = '# Action items\n\n';

/**
 * Checks a rewrite of the whole file (the routine "Keep my action items" answers with the new file). The rules: no action disappears (same words, case aside),
 * an action that was done stays done, and an action that is newly done carries a `why:` line. Returns the problems in plain words; empty means the rewrite may be
 * saved. The old text is the person's; this is the one place the "never deletes" rule is kept.
 */
export function reviewActionItemsRewrite(oldText: string, newText: string): string[] {
  const before = parseActionItemsFile(oldText);
  const after = parseActionItemsFile(newText);
  const key = (s: string): string => s.trim().toLowerCase();
  const byWords = new Map<string, ActionItemEntry[]>();
  for (const a of after) byWords.set(key(a.what), [...(byWords.get(key(a.what)) ?? []), a]);
  const problems: string[] = [];
  const used = new Map<string, number>();
  for (const b of before) {
    const pool = byWords.get(key(b.what)) ?? [];
    const n = used.get(key(b.what)) ?? 0;
    used.set(key(b.what), n + 1);
    const match = pool[n];
    if (!match) {
      problems.push(`The action “${b.what.slice(0, 60)}” would have been removed. Actions are never deleted: mark one done with a reason instead.`);
      continue;
    }
    if (b.done && !match.done) problems.push(`The action “${b.what.slice(0, 60)}” was done and would have been opened again.`);
    if (!b.done && match.done && match.why.length <= b.why.length) problems.push(`The action “${b.what.slice(0, 60)}” would have been marked done without saying why.`);
  }
  return problems;
}
