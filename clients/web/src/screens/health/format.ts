import type { OpsHealthCheck, OpsVolume } from '@manythreads/shared';

/** `95 s`, `12 min`, `26 h`, `4 d` for a length of time. */
export function formatSeconds(value: number): string {
  if (value < 120) return `${Math.round(value)} s`;
  if (value < 2 * 3600) return `${Math.round(value / 60)} min`;
  if (value < 2 * 86400) return `${Math.round((value / 3600) * 10) / 10} h`;
  return `${Math.round((value / 86400) * 10) / 10} d`;
}

export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

/** A check's reading, or "not measured" when its section could not be read. */
export function formatCheckValue(c: OpsHealthCheck): string {
  if (c.value === null) return 'not measured';
  return c.unit === 'percent' ? `${Math.round(c.value * 10) / 10} %` : formatSeconds(c.value);
}

export function formatLimit(c: OpsHealthCheck): string {
  if (c.threshold === 0) return 'off';
  return c.unit === 'percent' ? `${c.threshold} %` : formatSeconds(c.threshold);
}

export type CheckTone = 'ok' | 'warn' | 'down' | 'off';

/**
 * One status per check: `ok` "Fine" (green), `warn` "Over limit" (amber), `down` "Down" (red: the check is on but the part it reads cannot be
 * measured at all), `off` "Off" (switched off, so it says nothing).
 */
export function checkStatus(c: OpsHealthCheck): { tone: CheckTone; word: string } {
  if (c.threshold === 0) return { tone: 'off', word: 'Off' };
  if (c.value === null) return { tone: 'down', word: 'Down' };
  if (c.breached) return { tone: 'warn', word: 'Over limit' };
  return { tone: 'ok', word: 'Fine' };
}

/** Rank of a tone when the list is sorted: the worst first, a switched-off check last. */
const TONE_RANK: Record<CheckTone, number> = { down: 0, warn: 1, ok: 2, off: 3 };

/** The checks with the problems first (Down, then Over limit), then Fine, then Off; checks of the same tone keep the server's order. */
export function sortChecks(checks: readonly OpsHealthCheck[]): OpsHealthCheck[] {
  return checks
    .map((c, i) => ({ c, i, rank: TONE_RANK[checkStatus(c).tone] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);
}

/** The line on top of the page: "All fine", or how many checks have a problem ("1 problem", "3 problems"). */
export function healthSummary(checks: readonly OpsHealthCheck[]): { problems: number; text: string } {
  const problems = checks.filter((c) => {
    const t = checkStatus(c).tone;
    return t === 'down' || t === 'warn';
  }).length;
  return { problems, text: problems === 0 ? 'All fine' : problems === 1 ? '1 problem' : `${problems} problems` };
}

export const volumeTitle = (v: OpsVolume): string => (v.name === 'blobs' ? 'Attachment store' : v.name === 'repos' ? 'Team repositories' : v.name);
