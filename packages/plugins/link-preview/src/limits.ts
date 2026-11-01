// The three process-wide brakes of the link-preview fetcher, all held in memory (per server process, like the other limits of the platform: a restart
// forgets them, which only ever means "try again"):
//
//   - the on/off switch of the whole feature on this server (`MANYTHREADS_LINK_PREVIEW`),
//   - a budget of reads per author and per workspace (one person pasting a hundred links must not fill the queue or the network),
//   - a breaker per host (a site that does not answer is not asked again for a while, whoever links it).

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Whether this server reads links at all. `MANYTHREADS_LINK_PREVIEW=off` (also `0`, `false`, `no`) turns it off, `on` (`1`, `true`, `yes`) turns it on.
 * Unset: on in production, off when `NODE_ENV=test` (a test that posts a link must not start a real network read; the tests of this plugin and the
 * end-to-end stack say what they want). Read at the moment of use, so a test can change it.
 */
export function linkPreviewEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env['MANYTHREADS_LINK_PREVIEW'] ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  return env['NODE_ENV'] !== 'test';
}

// --- the budget of reads -------------------------------------------------------------------------------------------------------------------------------

/** New reads one author may start: this many in a minute, this many in an hour. */
export const AUTHOR_PER_MINUTE = 10;
export const AUTHOR_PER_HOUR = 60;
/** ...and the whole workspace, in an hour. */
export const WORKSPACE_PER_HOUR = 400;

export type BudgetRefusal = 'author' | 'workspace';

export interface LinkBudget {
  /** Counts `links` new reads for this author in this workspace, or says which limit is hit (nothing is counted then). */
  take(authorId: string, workspaceId: string, links: number): { ok: true } | { ok: false; scope: BudgetRefusal };
  reset(): void;
}

export function createLinkBudget(now: () => number = Date.now): LinkBudget {
  const authors = new Map<string, number[]>();
  const workspaces = new Map<string, number[]>();
  const fresh = (stamps: number[] | undefined, cutoff: number): number[] => (stamps ?? []).filter((s) => s > cutoff);
  const sweep = (m: Map<string, number[]>, cutoff: number): void => {
    if (m.size < 2000) return;
    for (const [k, v] of m) if (v.every((s) => s <= cutoff)) m.delete(k);
  };
  return {
    take(authorId, workspaceId, links) {
      const t = now();
      sweep(authors, t - HOUR);
      sweep(workspaces, t - HOUR);
      const a = fresh(authors.get(authorId), t - HOUR);
      const w = fresh(workspaces.get(workspaceId), t - HOUR);
      const lastMinute = a.filter((s) => s > t - MINUTE).length;
      if (lastMinute + links > AUTHOR_PER_MINUTE || a.length + links > AUTHOR_PER_HOUR) return { ok: false, scope: 'author' };
      if (w.length + links > WORKSPACE_PER_HOUR) return { ok: false, scope: 'workspace' };
      for (let i = 0; i < links; i += 1) {
        a.push(t);
        w.push(t);
      }
      authors.set(authorId, a);
      workspaces.set(workspaceId, w);
      return { ok: true };
    },
    reset() {
      authors.clear();
      workspaces.clear();
    },
  };
}

// --- the breaker per host ------------------------------------------------------------------------------------------------------------------------------

export interface BreakerOptions {
  /** Failures in a row that open the breaker. Default 3. */
  threshold?: number;
  /** How long an open breaker refuses. Default 5 minutes. */
  openMs?: number;
  /** Hosts remembered at most. Default 2000 (the oldest go first). */
  max?: number;
  now?: () => number;
}

export interface HostBreaker {
  /** False while the host is cooling down. After the cool-down one read is let through; a failure opens it again at once. */
  allow(host: string): boolean;
  success(host: string): void;
  failure(host: string): void;
  reset(): void;
}

export function createHostBreaker(options: BreakerOptions = {}): HostBreaker {
  const threshold = options.threshold ?? 3;
  const openMs = options.openMs ?? 5 * MINUTE;
  const max = options.max ?? 2000;
  const now = options.now ?? Date.now;
  const hosts = new Map<string, { fails: number; openUntil: number }>();
  return {
    allow(host) {
      const e = hosts.get(host);
      return e === undefined || e.openUntil <= now();
    },
    success(host) {
      hosts.delete(host);
    },
    failure(host) {
      const e = hosts.get(host) ?? { fails: 0, openUntil: 0 };
      e.fails += 1;
      if (e.fails >= threshold) e.openUntil = now() + openMs;
      hosts.delete(host);
      hosts.set(host, e);
      while (hosts.size > max) {
        const oldest = hosts.keys().next().value;
        if (oldest === undefined) break;
        hosts.delete(oldest);
      }
    },
    reset() {
      hosts.clear();
    },
  };
}
