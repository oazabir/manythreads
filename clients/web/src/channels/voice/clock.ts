import { VOICE_MAX_MS } from '@manythreads/shared';

/**
 * The recorder's time words (P14-17), as plain functions: the clock the writer sees ("0:12 / 5:00"), the same time spoken for a screen reader
 * ("12 seconds"), and the limits. Nothing here touches the browser.
 */

/** The shortest clip that is kept (the server refuses less than half a second). */
export const VOICE_MIN_MS = 500;
export { VOICE_MAX_MS };

/** Said when a recording reaches the limit and stops by itself. */
export const LIMIT_NOTE = 'Voice messages stop at 5 minutes.';

/** `0:12`, `12:05`: whole seconds, never rounded up (a clock that says 0:12 has not reached 0:13). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** The recording timer: `0:12 / 5:00`. */
export function clockOfMax(ms: number, max: number = VOICE_MAX_MS): string {
  return `${formatClock(Math.min(ms, max))} / ${formatClock(max)}`;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A length in words, for a screen reader: `42 seconds`, `1 minute 5 seconds`, `5 minutes`. */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return plural(seconds, 'second');
  return seconds === 0 ? plural(minutes, 'minute') : `${plural(minutes, 'minute')} ${plural(seconds, 'second')}`;
}

/** True once the recording has used up the limit. */
export const reachedLimit = (ms: number, max: number = VOICE_MAX_MS): boolean => ms >= max;

/** The warnings said aloud once each while the limit comes near: one minute, then thirty seconds left. */
export const LIMIT_WARNINGS: readonly { atMs: number; text: string }[] = [
  { atMs: VOICE_MAX_MS - 60_000, text: 'One minute left' },
  { atMs: VOICE_MAX_MS - 30_000, text: '30 seconds left' },
];

/** The warning to say now: the latest one passed that was not said yet (`said` is how many were said), or null. */
export function warningAt(elapsedMs: number, said: number): { text: string; said: number } | null {
  let last = -1;
  LIMIT_WARNINGS.forEach((w, i) => {
    if (elapsedMs >= w.atMs) last = i;
  });
  if (last < said) return null;
  return { text: LIMIT_WARNINGS[last]?.text ?? '', said: last + 1 };
}
