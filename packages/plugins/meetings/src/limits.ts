import { HttpError, conflict, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { MEETING_ROOM_CAP_DEFAULT, MEETING_ROOM_LINES_PER_MINUTE } from '@manythreads/shared';

// Work package S1 (P15-16, decision C12): the limits on a room. What a device or a speech engine sends is hostile input, so the words are cleaned here before they reach
// the database, and the room's size and the number of lines it takes a minute are capped. Every text function below does one pass over its input (no nested
// quantifier, no backtracking), so a long hostile line costs time in proportion to its length and nothing more (test/hostile-text.test.ts holds a timing check).

// ---- cleaning words ---------------------------------------------------------------------------------------------------------------------

/**
 * True for a code point that must never reach a transcript: the C0 controls (NUL, ESC, the line breaks too, which are turned into spaces by the caller), DEL, the C1
 * controls, the bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069: they let one line re-order the text around it), and a lone half of a surrogate
 * pair (it cannot be stored). The zero-width joiners stay: Bangla, Arabic and the emoji sequences are spelled with them.
 */
function isRemoved(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

/** True for a code point that is a break or a space: it becomes one plain space, and runs of them become one. */
function isSpaceLike(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x85 || cp === 0xa0 || cp === 0x2028 || cp === 0x2029 || cp === 0x3000 || (cp >= 0x2000 && cp <= 0x200a);
}

/**
 * The words of a line as they are stored: control and bidirectional characters removed (line breaks and tabs become a space), runs of spaces made one, the ends trimmed.
 * One pass; the result is never longer than the input.
 */
export function stripHostileText(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (isSpaceLike(cp)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (isRemoved(cp)) continue;
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += ch;
  }
  return out;
}

/**
 * The form two lines are compared in to tell whether two devices heard the same words: NFKC, lower case, only letters, digits and marks, one space between words. One
 * pass over the folded text.
 */
export function comparableText(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of text.normalize('NFKC').toLowerCase()) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch)) {
      if (pendingSpace && out.length > 0) out += ' ';
      pendingSpace = false;
      out += ch;
    } else {
      pendingSpace = true;
    }
  }
  return out;
}

// ---- how many lines a room takes ---------------------------------------------------------------------------------------------------------

/**
 * A sliding window of what each key took in the last minute, in process memory (per replica, like the other limits). `take` records `n` more only if they fit and
 * otherwise answers how many seconds to wait; it never records a refused request.
 */
export class WindowCounter {
  private readonly hits = new Map<string, { at: number; n: number }[]>();

  constructor(private readonly windowMs = 60_000) {}

  take(key: string, n: number, limit: number, now: number): number | null {
    const kept = (this.hits.get(key) ?? []).filter((h) => h.at > now - this.windowMs);
    const used = kept.reduce((sum, h) => sum + h.n, 0);
    if (used + n > limit) {
      this.hits.set(key, kept);
      const oldest = kept[0];
      return oldest ? Math.max(1, Math.ceil((oldest.at + this.windowMs - now) / 1000)) : 1;
    }
    kept.push({ at: now, n });
    this.hits.set(key, kept);
    if (this.hits.size > 5000) this.forget(now);
    return null;
  }

  /** Drops every key with nothing left in the window. */
  forget(now: number): void {
    for (const [key, list] of this.hits) if (!list.some((h) => h.at > now - this.windowMs)) this.hits.delete(key);
  }

  size(): number {
    return this.hits.size;
  }
}

/** One person may send this many lines a minute into a room (a person speaks a line every few seconds; the rest is a loop or an attack). */
export const SPEAKER_LINES_PER_MINUTE = 300;

const lines = new WindowCounter();

/**
 * Counts `n` lines against the room and against the speaker. A room takes `MEETING_ROOM_LINES_PER_MINUTE` a minute, one speaker `SPEAKER_LINES_PER_MINUTE`: so one
 * person cannot use up the room's share. Throws 429 with `retry-after` when either is full.
 */
export function takeRoomLines(meetingId: string, speakerId: string, n: number, now: number = Date.now()): void {
  const speaker = lines.take(`s:${meetingId}:${speakerId}`, n, SPEAKER_LINES_PER_MINUTE, now);
  if (speaker !== null) throw new HttpError(429, 'rate_limited', 'You are sending lines too fast: wait a moment', { 'retry-after': String(speaker) });
  const room = lines.take(`r:${meetingId}`, n, MEETING_ROOM_LINES_PER_MINUTE, now);
  if (room !== null) throw new HttpError(429, 'rate_limited', 'This voice room is taking more lines than it can store: wait a moment', { 'retry-after': String(room) });
}

// ---- how many people a room takes ----------------------------------------------------------------------------------------------------------

/** The most people one room takes in this workspace (`meeting_settings.room_cap`, 25 until an admin sets it). */
export async function roomCap(tx: PluginTx): Promise<number> {
  const row = (await tx.query<{ room_cap: number }>('SELECT room_cap FROM app.meeting_settings WHERE workspace_id = app.workspace_id()')).rows[0];
  return row?.room_cap ?? MEETING_ROOM_CAP_DEFAULT;
}

/** Refuses a new person with 409 when the room already holds as many people as the workspace allows. Somebody coming back into a room they are in is not counted by the caller. */
export async function assertRoomHasSpace(tx: PluginTx, meetingId: string): Promise<void> {
  const people = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meeting_participants WHERE meeting_id = $1::uuid AND left_at IS NULL', [meetingId])).rows[0]?.n ?? 0;
  const cap = await roomCap(tx);
  if (people >= cap) throw conflict(`This voice room is full (${cap} people)`);
}

/** Nothing to register: the limits are functions the join route and the line routes call. Kept so `index.ts` has one place per module. */
export function registerLimits(ctx: PluginContext): void {
  void ctx;
}
