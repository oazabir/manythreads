// The little marker in front of a message: whether the thing it reports went well. Read from a word (`status`, `conclusion`, `level`) or a colour.

export type Mark = 'good' | 'bad' | 'warn' | 'info' | 'none';

export const MARKS: Record<Mark, string> = { good: '✅', bad: '❌', warn: '⚠️', info: 'ℹ️', none: '' };

const GOOD = new Set(['success', 'succeeded', 'ok', 'passed', 'pass', 'good', 'resolved', 'fixed', 'healthy', 'up', 'completed', 'merged', 'green', 'done', 'recovered']);
const BAD = new Set(['failure', 'failed', 'fail', 'error', 'errored', 'critical', 'fatal', 'danger', 'firing', 'down', 'alert', 'red', 'timed_out', 'startup_failure', 'broken', 'high', 'page']);
const WARN = new Set(['warning', 'warn', 'medium', 'amber', 'yellow', 'cancelled', 'canceled', 'unstable', 'degraded', 'action_required']);
const INFO = new Set(['info', 'information', 'notice', 'pending', 'started', 'running', 'queued', 'in_progress', 'low', 'debug', 'blue']);

export function markFromWord(word: unknown): Mark {
  if (typeof word !== 'string') return 'none';
  const w = word.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (GOOD.has(w)) return 'good';
  if (BAD.has(w)) return 'bad';
  if (WARN.has(w)) return 'warn';
  if (INFO.has(w)) return 'info';
  return 'none';
}

/** A colour as a sender writes it: a Slack name (`good`, `warning`, `danger`) or `#rgb` / `#rrggbb`. Hue decides: green good, red bad, amber warn, blue info. */
export function markFromColor(color: unknown): Mark {
  if (typeof color !== 'string') return 'none';
  const named = markFromWord(color);
  if (named !== 'none') return named;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m?.[1]) return 'none';
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return 'none'; // grey
  if (max === r && g > 110 && b < 110) return 'warn';
  if (max === r) return 'bad';
  if (max === g) return 'good';
  return 'info';
}

export const markOf = (...candidates: Array<Mark>): Mark => candidates.find((c) => c !== 'none') ?? 'none';
export const withMark = (mark: Mark, text: string): string => (mark === 'none' ? text : `${MARKS[mark]} ${text}`);
