import { TERMINAL_END_WORDS, TERMINAL_LIMITS, type TerminalEndReason, type TerminalLimitsShape, type TerminalSession } from '@manythreads/shared';

/*
 * The small rules and the words of the Terminal view (PLAN P7-09). Pure, so they are tested without a browser. Every sentence a person reads is here or in the view, in plain words.
 */

/** Ctrl+C and Ctrl+D as a terminal sends them: "stop what is running" and "no more input". */
export const KEY_INTERRUPT = '\u0003';
export const KEY_EOF = '\u0004';

/** A line the person typed, ready to send: the shell takes a line when it ends with a newline. */
export const asLine = (text: string): string => `${text}\n`;

/**
 * Cuts text into pieces the server accepts as one frame. A paste of any size becomes several frames, in order. A piece is never cut in the middle of a character that takes two
 * code units (the server reads each frame as text).
 */
export function chunkInput(text: string, max: number = TERMINAL_LIMITS.inputFrameMax): string[] {
  if (text === '') return [];
  const out: string[] = [];
  let piece = '';
  for (const ch of text) {
    if (piece.length + ch.length > max) {
      out.push(piece);
      piece = '';
    }
    piece += ch;
  }
  if (piece !== '') out.push(piece);
  return out;
}

/** The size of the shell's screen for a box of this many pixels, within the limits the server takes. */
export function fitSize(width: number, height: number, cell: { w: number; h: number } = { w: 8.4, h: 18 }): { cols: number; rows: number } {
  const { cols, rows } = TERMINAL_LIMITS;
  const c = Math.floor(width / cell.w);
  const r = Math.floor(height / cell.h);
  return {
    cols: Math.min(cols.max, Math.max(cols.min, Number.isFinite(c) && c > 0 ? c : cols.default)),
    rows: Math.min(rows.max, Math.max(rows.min, Number.isFinite(r) && r > 0 ? r : rows.default)),
  };
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** A length of time in plain words: "5 minutes", "30 minutes", "1 hour", "90 seconds". */
export function spanWords(seconds: number): string {
  if (seconds < 120 && seconds % 60 !== 0) return plural(seconds, 'second', 'seconds');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute', 'minutes');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour', 'hours');
  return plural(minutes, 'minutes', 'minutes');
}

/** What the limits mean for the person at the keyboard. */
export function limitsLine(l: TerminalLimitsShape): string {
  return `It closes by itself after ${spanWords(l.idleSeconds)} without typing, or ${spanWords(l.maxSeconds)} in all.`;
}

/** The sentence for why a terminal ended: the server's own words when it sent some, else the standard one for the reason. */
export function endWords(reason: TerminalEndReason | null, message?: string): string {
  if (message && message.trim() !== '') return message;
  return reason ? TERMINAL_END_WORDS[reason] : 'Closed.';
}

/** The terminal's own states. `closed-page` is the page ending it (navigating away). */
export type Phase = 'checking' | 'unavailable' | 'ready' | 'starting' | 'open' | 'ended' | 'failed';

/** The words a screen reader hears when the phase changes. */
export function phaseWords(phase: Phase, detail?: string): string {
  switch (phase) {
    case 'checking':
      return 'Checking whether a terminal can be opened.';
    case 'unavailable':
      return detail ?? 'A terminal cannot be opened here.';
    case 'ready':
      return 'A terminal can be opened.';
    case 'starting':
      return 'Opening the terminal.';
    case 'open':
      return detail ?? 'The terminal is open.';
    case 'ended':
      return detail ?? 'The terminal is closed.';
    case 'failed':
      return detail ?? 'The terminal could not be opened.';
  }
}

/** Keeps the lines a person typed, newest last, so the arrow keys can bring one back. A line is kept once in a row. */
export function pushHistory(history: readonly string[], line: string, keep = 100): string[] {
  const t = line.trim();
  if (t === '' || history[history.length - 1] === t) return [...history];
  return [...history, t].slice(-keep);
}

/** Moves through the history with the arrow keys: `index` is where the person is now (history.length means "a new line"). Returns the new place and the text to show. */
export function stepHistory(history: readonly string[], index: number, key: 'ArrowUp' | 'ArrowDown', draft: string): { index: number; text: string } {
  if (key === 'ArrowUp') {
    const to = Math.max(0, index - 1);
    return { index: to, text: history[to] ?? draft };
  }
  const to = Math.min(history.length, index + 1);
  return { index: to, text: to >= history.length ? draft : (history[to] ?? draft) };
}

/** One earlier terminal as a row: who opened it, when, and how it ended. */
export function sessionRow(s: TerminalSession): { title: string; meta: string } {
  const when = s.startedAt ?? s.createdAt;
  const day = new Date(when).toISOString().slice(0, 16).replace('T', ' ');
  const how = s.status === 'ended' ? endWords(s.endReason) : s.status === 'open' ? 'Open now.' : 'Waiting to open.';
  return { title: `${s.admin.name || 'An admin'} · ${day} UTC`, meta: how };
}

/** Bytes in plain words for the record line. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
