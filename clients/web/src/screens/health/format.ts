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

/** `ok`, `fail` (past its limit), `skipped` (switched off or not measured): the class and word of a check's status. */
export function checkStatus(c: OpsHealthCheck): { tone: 'ok' | 'fail' | 'skipped'; word: string } {
  if (c.breached) return { tone: 'fail', word: 'Over limit' };
  if (c.threshold === 0) return { tone: 'skipped', word: 'Off' };
  if (c.value === null) return { tone: 'skipped', word: 'Unknown' };
  return { tone: 'ok', word: 'Fine' };
}

export const volumeTitle = (v: OpsVolume): string => (v.name === 'blobs' ? 'Attachment store' : v.name === 'repos' ? 'Team repositories' : v.name);
