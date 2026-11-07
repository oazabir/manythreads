import {
  RunDeltaPush,
  RunEndedPush,
  RunLookingPush,
  WS_RUN_DELTA,
  WS_RUN_ENDED,
  WS_RUN_LOOKING,
  type ChannelMessage,
  type ChatThreadState,
  type ChatTurn,
  type ChatVariant,
  type ConversationListItem,
} from '@manythreads/shared';

/*
 * The Chat screen's plain data and pure functions (PLAN P20-16): the history rail's groups, the rows of one conversation (which answer of a turn is shown),
 * the live preview of an answer being written, and the Markdown export. Nothing here touches the network or the page, so the tests call it directly.
 */

// ---- the history rail --------------------------------------------------------------------------------------------------------------

export type RailGroupId = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';
export type RailGroup = { id: RailGroupId; label: string; items: ConversationListItem[] };

const LABELS: Record<RailGroupId, string> = { pinned: 'Pinned', today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', older: 'Older' };

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Pinned first, then by the day of the last activity in the reader's own time zone. Empty groups are left out; the order inside a group is the list's own (newest first). */
export function railGroups(items: readonly ConversationListItem[], now: Date = new Date()): RailGroup[] {
  const today = startOfDay(now);
  const day = 86_400_000;
  const groups = new Map<RailGroupId, ConversationListItem[]>();
  for (const item of items) {
    const at = Date.parse(item.lastActivityAt);
    const id: RailGroupId = item.pinned ? 'pinned' : at >= today ? 'today' : at >= today - day ? 'yesterday' : at >= today - 7 * day ? 'week' : 'older';
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return (['pinned', 'today', 'yesterday', 'week', 'older'] as const).flatMap((id) => {
    const list = groups.get(id);
    return list && list.length > 0 ? [{ id, label: LABELS[id], items: list }] : [];
  });
}

/** The name a conversation shows: the title, else the first words of the question, else a plain placeholder. */
export const railTitle = (item: { title: string }): string => (item.title.trim() !== '' ? item.title.trim() : 'New chat');

// ---- the rows of one conversation ------------------------------------------------------------------------------------------------

export type ChatRow =
  | { kind: 'person'; message: ChannelMessage; turnId: string }
  | { kind: 'bot'; message: ChannelMessage; turn: ChatTurn | null; variant: ChatVariant | null; variantIndex: number };

/**
 * The messages of a conversation as the screen shows them: the root and the replies, oldest first. Of the answers to one turn only the chosen one is
 * drawn (the others are reached with the ‹ 2 / 3 › control); a bot message that is not an answer to a turn (a notice) is drawn as it is. Until the
 * server has recorded an answer as a variant (the index trails a new message by a moment) the answer is drawn without the control.
 */
export function buildRows(root: ChannelMessage | null, replies: readonly ChannelMessage[], state: ChatThreadState | null, selfActor: string | null): ChatRow[] {
  const all = root ? [root, ...replies.filter((m) => m.id !== root.id)] : [...replies];
  const variantOf = new Map<string, { turn: ChatTurn; variant: ChatVariant; index: number }>();
  for (const turn of state?.turns ?? []) {
    turn.variants.forEach((variant, index) => variantOf.set(variant.messageId, { turn, variant, index }));
  }
  const rows: ChatRow[] = [];
  for (const message of all) {
    if (message.deletedAt) continue;
    const known = variantOf.get(message.id);
    if (known) {
      if (!known.variant.chosen) continue;
      rows.push({ kind: 'bot', message, turn: known.turn, variant: known.variant, variantIndex: known.index });
      continue;
    }
    // a message of the person's own starts a turn; anything else in the thread is the bot's
    if (selfActor !== null ? message.authorId === selfActor : root !== null && message.authorId === root.authorId) {
      rows.push({ kind: 'person', message, turnId: message.id });
    } else {
      rows.push({ kind: 'bot', message, turn: null, variant: null, variantIndex: 0 });
    }
  }
  return rows;
}

/** Whether the newest thing in the conversation is the person's own message: an answer is on its way. */
export const awaitingAnswer = (rows: readonly ChatRow[]): boolean => rows.at(-1)?.kind === 'person';

/** The variants of a turn in the order they were written, for the ‹ 2 / 3 › control: the position (1-based) and how many there are. */
export function variantPosition(row: Extract<ChatRow, { kind: 'bot' }>): { at: number; of: number } | null {
  if (!row.turn || row.turn.variants.length < 2) return null;
  return { at: row.variantIndex + 1, of: row.turn.variants.length };
}

/** The message to show when ‹ or › is pressed from this row; wraps nowhere (null at either end). */
export function neighbourVariant(row: Extract<ChatRow, { kind: 'bot' }>, step: -1 | 1): string | null {
  if (!row.turn) return null;
  return row.turn.variants[row.variantIndex + step]?.messageId ?? null;
}

// ---- the live preview ------------------------------------------------------------------------------------------------------------

export type Preview = {
  runId: string | null;
  threadRootId: string | null;
  /** The answer so far (only while it is whole: see `partial`). */
  text: string;
  /**
   * A piece went missing (the page was opened or the socket reconnected in the middle of the answer), so `text` would read wrongly. It stays empty and the screen
   * shows the working line until the final message arrives.
   */
  partial: boolean;
  /** What the bot has been looking at, in order, without repeats. */
  looking: string[];
  /** Set when the run ended; the answer itself is then a message of the thread. */
  ended: RunEndedPush['status'] | null;
};

export const NO_PREVIEW: Preview = { runId: null, threadRootId: null, text: '', partial: false, looking: [], ended: null };

export type Frame = { type: 'delta'; push: RunDeltaPush } | { type: 'looking'; push: RunLookingPush } | { type: 'ended'; push: RunEndedPush };

/**
 * One frame into the preview. A frame of another run starts a new preview; a frame for another conversation is ignored. `offset` is how many
 * characters came before the piece: a repeat adds only what is new. A gap (a missed frame, or a page opened in the middle of the answer: the first piece it sees
 * does not start at 0) would make the text read wrongly, so the preview gives up its words and waits for the final message, which replaces it.
 */
export function applyFrame(prev: Preview, frame: Frame, thread: string): Preview {
  if (frame.push.threadRootId !== thread) return prev;
  const same = prev.runId === frame.push.runId;
  const base: Preview = same ? prev : { ...NO_PREVIEW, runId: frame.push.runId, threadRootId: frame.push.threadRootId };
  if (frame.type === 'ended') return { ...base, ended: frame.push.status };
  if (frame.type === 'looking') {
    const label = frame.push.label;
    return base.looking.includes(label) ? base : { ...base, looking: [...base.looking, label] };
  }
  const { offset, text } = frame.push;
  if (base.partial) return base;
  if (offset > base.text.length) return { ...base, text: '', partial: true };
  if (offset + text.length <= base.text.length) return base;
  const fresh = offset < base.text.length ? text.slice(base.text.length - offset) : text;
  return { ...base, text: base.text + fresh };
}

/**
 * The one line a screen reader is told about the answer: when it starts and when it is in. The words are never read out as they arrive (the live region holds
 * this sentence only), so a long answer does not talk over the reader for its whole length.
 */
export function answerStatus(writing: boolean, ended: Preview['ended'], botName: string): string {
  if (writing) return `${botName} is writing an answer.`;
  return ended === 'done' ? `${botName} answered.` : '';
}

/** How many frames are kept for a conversation that has no address yet. */
export const EARLY_FRAMES = 100;

/**
 * A new chat has no thread until the server answers the first message, and the first words of the answer can reach the page before that answer is handled.
 * Frames that come while no conversation is open are kept (the newest `EARLY_FRAMES`) and given to the conversation that opens.
 */
export const holdEarly = (held: readonly Frame[], frame: Frame): Frame[] => [...held.slice(-(EARLY_FRAMES - 1)), frame];

/** The held frames that belong to this conversation, oldest first. */
export const takeEarly = (held: readonly Frame[], thread: string): Frame[] => held.filter((f) => f.push.threadRootId === thread);

/** Whether the preview is for an answer still being written. */
export const previewLive = (p: Preview): boolean => p.runId !== null && p.ended === null;

// ---- export --------------------------------------------------------------------------------------------------------------------------

/** The conversation as Markdown: the title, then each message under the name of who wrote it. The chosen answers only. */
export function exportMarkdown(title: string, rows: readonly ChatRow[], names: { you: string; bot: string }): string {
  const parts = [`# ${title.trim() === '' ? 'Chat' : title.trim()}`];
  for (const row of rows) {
    const who = row.kind === 'person' ? names.you : names.bot;
    parts.push(`**${who}**\n\n${row.message.body.trim()}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** A file name from a title: letters, digits and dashes, never empty. */
export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug === '' ? 'chat' : slug}.md`;
}

/** A live push as a frame, or null when it is another kind of push or does not match the contract. */
export function frameOf(push: { type: string; payload: Record<string, unknown> }): Frame | null {
  if (push.type === WS_RUN_DELTA) {
    const p = RunDeltaPush.safeParse(push.payload);
    return p.success ? { type: 'delta', push: p.data } : null;
  }
  if (push.type === WS_RUN_LOOKING) {
    const p = RunLookingPush.safeParse(push.payload);
    return p.success ? { type: 'looking', push: p.data } : null;
  }
  if (push.type === WS_RUN_ENDED) {
    const p = RunEndedPush.safeParse(push.payload);
    return p.success ? { type: 'ended', push: p.data } : null;
  }
  return null;
}
