import type { Approval, RunHead, ThreadInboxItem, ThreadMention, ThreadTodo } from '@manythreads/shared';
import { nowLine } from '../channels/run-card/words';
import { currentItem, todoProgress } from '../channels/todo-card/words';

/*
 * The rules of the Threads view (P29, docs/plans/channel-task-view.md section 10c): how the filter box is read and matched, which rows "need you", in which order the list is
 * drawn, what one row says about progress, and where a match is highlighted. Pure, so each rule is tested without a screen.
 */

// ---- the filter -----------------------------------------------------------------------------------------------------------------

/** Case and accent insensitive form of a text ("Été" and "ete" meet). */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface ParsedFilter {
  /** Free words, folded: each must be in the channel's name or in the thread's text. */
  words: string[];
  /** `@name` words, folded, without the `@`: each names a person or a bot the thread must mention. */
  names: string[];
  /** Nothing typed that filters. */
  empty: boolean;
}

/** The text of the filter box: words, and `@name` words that filter by who is mentioned. A lone `@` is nothing yet. */
export function parseFilter(text: string): ParsedFilter {
  const words: string[] = [];
  const names: string[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    if (raw === '') continue;
    if (raw.startsWith('@')) {
      const name = fold(raw.slice(1));
      if (name !== '' && !names.includes(name)) names.push(name);
    } else {
      const w = fold(raw);
      if (w !== '' && !words.includes(w)) words.push(w);
    }
  }
  return { words: words.slice(0, 6), names: names.slice(0, 5), empty: words.length === 0 && names.length === 0 };
}

export interface RosterForNames {
  people: ReadonlyArray<{ actorId: string; name: string; email?: string }>;
  bots: ReadonlyArray<{ actorId: string; slug: string; name: string }>;
}

/** Whether `@name` means this person or bot: it starts the name, one of the name's words, the email's first part or the bot's slug. */
const meansName = (name: string, labels: readonly string[]): boolean => labels.some((l) => fold(l).split(/[\s._-]+/).some((part) => part.startsWith(name)) || fold(l).startsWith(name));

/** The actors each `@name` stands for: every one of the roster that it starts (two people called Sam are both Sam). A name nobody has is `unmatched` (the filter then shows nothing, and says so). */
export function resolveNames(names: readonly string[], roster: RosterForNames): { groups: string[][]; unmatched: string[] } {
  const groups: string[][] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const ids = [
      ...roster.people.filter((p) => meansName(name, [p.name, ...(p.email ? [p.email.split('@')[0] ?? ''] : [])])).map((p) => p.actorId),
      ...roster.bots.filter((b) => meansName(name, [b.name, b.slug])).map((b) => b.actorId),
    ];
    if (ids.length === 0) unmatched.push(name);
    else groups.push([...new Set(ids)].slice(0, 20));
  }
  return { groups, unmatched };
}

/** The `mentions` value the server reads: `,` between names, `|` between the actors one name may mean. Undefined when there is none. */
export const mentionsParam = (groups: readonly (readonly string[])[]): string | undefined => (groups.length === 0 ? undefined : groups.map((g) => g.join('|')).join(','));

export type MatchKind = 'channel' | 'message';

/** The text a row holds that the filter can see without asking the server: the channel, the first message, the latest reply and the mention. */
const textOf = (item: ThreadInboxItem): { channel: string; rest: string } => ({
  channel: fold(item.channel.name.replace(/^#/, '')),
  rest: fold([item.title, item.lastReply?.preview ?? '', item.mention?.preview ?? '', item.rootAuthor?.displayName ?? '', item.lastReply?.authorName ?? ''].join('\n')),
});

/**
 * How a row matches the free words: `channel` when a word is in the channel's name and every word is somewhere in the row, `message` when every word is in the row's
 * text, null when it does not match. (The server also looks at the older messages of the thread; this is what the loaded rows show, so a match can be drawn.)
 */
export function matchThread(item: ThreadInboxItem, words: readonly string[]): MatchKind | null {
  if (words.length === 0) return 'message';
  const t = textOf(item);
  const all = `${t.channel}\n${t.rest}`;
  if (!words.every((w) => all.includes(w))) return null;
  return words.some((w) => t.channel.includes(w)) ? 'channel' : 'message';
}

/** The loaded rows that match, the channel-name matches first, each group in the order it came (newest first). */
export function filterThreads(items: readonly ThreadInboxItem[], words: readonly string[]): ThreadInboxItem[] {
  if (words.length === 0) return [...items];
  const byChannel: ThreadInboxItem[] = [];
  const byMessage: ThreadInboxItem[] = [];
  for (const it of items) {
    const m = matchThread(it, words);
    if (m === 'channel') byChannel.push(it);
    else if (m === 'message') byMessage.push(it);
  }
  return [...byChannel, ...byMessage];
}

/** Merges the server's answer (the whole story) with the rows already matched here: the server's order wins, a row only the client matched follows. */
export function mergeFiltered(server: readonly ThreadInboxItem[], local: readonly ThreadInboxItem[]): ThreadInboxItem[] {
  const seen = new Set(server.map((i) => i.rootMessageId));
  return [...server, ...local.filter((i) => !seen.has(i.rootMessageId))];
}

export interface Piece {
  text: string;
  hit: boolean;
}

/** The text cut into pieces, the parts that match a word marked (case and accent insensitive). A text with no match is one piece. */
export function highlight(text: string, words: readonly string[]): Piece[] {
  if (words.length === 0 || text === '') return [{ text, hit: false }];
  // fold each character on its own, so a position in the folded text is a position in the original
  let folded = '';
  const at: number[] = [];
  const endAt: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k += 1) {
      at.push(i);
      endAt.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    if (w === '') continue;
    for (let from = folded.indexOf(w); from !== -1; from = folded.indexOf(w, from + w.length)) {
      const start = at[from] ?? 0;
      let end = endAt[from + w.length - 1] ?? text.length;
      while (end < text.length && /\p{M}/u.test(text[end] ?? '')) end += 1;
      for (let k = start; k < end; k += 1) hit[k] = true;
    }
  }
  const out: Piece[] = [];
  for (let k = 0; k < text.length; k += 1) {
    const h = hit[k] ?? false;
    const last = out.at(-1);
    if (last && last.hit === h) last.text += text[k] ?? '';
    else out.push({ text: text[k] ?? '', hit: h });
  }
  return out;
}

// ---- needs you ------------------------------------------------------------------------------------------------------------------

export interface NeedsYou {
  needs: boolean;
  /** The oldest approval waiting in the thread that the person may decide, or null. */
  approval: Approval | null;
  /** The newest unanswered mention (from the server), or null. */
  mention: ThreadMention | null;
  /** The moment the oldest of the two began to wait. */
  since: string | null;
}

export const NOT_NEEDED: NeedsYou = { needs: false, approval: null, mention: null, since: null };

/** The rule of "Needs you": an approval waits and the person may decide it, or somebody named them and they have not answered since (the server's `mention`). */
export function needsYou(item: Pick<ThreadInboxItem, 'mention'>, questions: readonly Approval[]): NeedsYou {
  const approval = [...questions].filter((a) => a.status === 'pending' && a.canDecide).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
  const mention = item.mention ?? null;
  if (approval === null && mention === null) return NOT_NEEDED;
  const times = [approval?.createdAt, mention?.at].filter((t): t is string => t !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { needs: true, approval, mention, since: times[0] ?? null };
}

export type InboxOrder = 'needs' | 'time';

/** The list in two parts: the rows that need the person, the one waiting longest first, and the rest in the order they came (newest first). With `time` there is one part. */
export function orderThreads(items: readonly ThreadInboxItem[], needsOf: (root: string) => NeedsYou, order: InboxOrder): { needs: ThreadInboxItem[]; rest: ThreadInboxItem[] } {
  if (order === 'time') return { needs: [], rest: [...items] };
  const needs: ThreadInboxItem[] = [];
  const rest: ThreadInboxItem[] = [];
  for (const it of items) (needsOf(it.rootMessageId).needs ? needs : rest).push(it);
  needs.sort((a, b) => Date.parse(needsOf(a.rootMessageId).since ?? a.lastReplyAt) - Date.parse(needsOf(b.rootMessageId).since ?? b.lastReplyAt));
  return { needs, rest };
}

// ---- progress -------------------------------------------------------------------------------------------------------------------

export interface RowProgress {
  kind: 'todo' | 'run';
  /** "2 of 4"; a run has none. */
  count: string | null;
  /** Share of the list that is done, 0 to 100; a run has none. */
  pct: number | null;
  /** The item being worked on (or the next one), or what the run does now ("Engineer · Running pnpm lint"). */
  text: string;
  tone: 'working' | 'blocked' | 'waiting' | 'done';
  allDone: boolean;
}

/** What one row says about the work in its thread: its to-do list when it has one, else the run that is going. Nothing when neither has anything to say. */
export function progressOf(todo: ThreadTodo | null, run: { botName: string; head?: RunHead | undefined } | null): RowProgress | null {
  if (todo !== null && todo.items.length > 0) {
    const p = todoProgress(todo.items);
    const cur = currentItem(todo.items);
    const live = run !== null ? ` · ${run.botName}` : '';
    return {
      kind: 'todo',
      count: p.allDone ? `${p.done} of ${p.total} done` : `${p.done} of ${p.total}`,
      pct: Math.round((p.done / p.total) * 100),
      text: cur === null ? todo.title.trim() || 'To do' : `${cur.text}${cur.status === 'working' ? live : ''}`,
      tone: cur === null ? 'done' : cur.status,
      allDone: p.allDone,
    };
  }
  if (run !== null) {
    const line = run.head ? nowLine(run.head.now, run.head.state).text : 'Working';
    return { kind: 'run', count: null, pct: null, text: `${run.botName} · ${line}`, tone: run.head?.state === 'waiting' ? 'blocked' : 'working', allDone: false };
  }
  return null;
}
