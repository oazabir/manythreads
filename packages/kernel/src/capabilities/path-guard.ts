/**
 * The referee rule (guide §7): bots never write `bots/`, `TEAM.md`, `skills/`, `routines/`. Changes arrive only
 * as an approved proposal. Paths are repo-relative and case-sensitive.
 */

const GUARDED_DIRS: ReadonlySet<string> = new Set(['bots', 'skills', 'routines']);
const GUARDED_FILES: ReadonlySet<string> = new Set(['TEAM.md']);

/** `files.*` verbs that only read. Everything else under `files.` is treated as a write (fail closed). */
const READ_ONLY_FILE_VERBS: ReadonlySet<string> = new Set(['read', 'list', 'search', 'get', 'stat', 'diff', 'history']);

/** True for `files.write`, `files.delete`, `files.move`, ... and any unknown `files.*` verb. */
export function isFilesMutation(capability: string): boolean {
  if (!capability.startsWith('files.')) return false;
  return !READ_ONLY_FILE_VERBS.has(capability.slice('files.'.length));
}

export type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Strip leading `./` and `/`, collapse `.` and `..`, convert backslashes. A path that climbs above the
 * repository root, or contains a NUL byte, is rejected as a traversal attempt.
 */
export function normalizeRepoPath(raw: string): NormalizedPath {
  if (raw.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  const out: string[] = [];
  for (const segment of raw.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return { ok: false, reason: `path "${raw}" escapes the repository root` };
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return { ok: true, path: out.join('/') };
}

const isGuarded = (normalized: string): boolean => {
  const first = normalized.split('/')[0] ?? '';
  return GUARDED_DIRS.has(first) || GUARDED_FILES.has(normalized);
};

export interface PathVerdict {
  allowed: boolean;
  reason: string;
}

/** Decide one path for a bot write. Also checks the percent-decoded form so `%2e%2e/` tricks do not pass. */
export function checkBotWritePath(raw: string): PathVerdict {
  const forms = [raw];
  if (raw.includes('%')) {
    try {
      forms.push(decodeURIComponent(raw));
    } catch {
      return { allowed: false, reason: `path "${raw}" has invalid percent-encoding` };
    }
  }
  for (const form of forms) {
    const normalized = normalizeRepoPath(form);
    if (!normalized.ok) return { allowed: false, reason: `traversal denied: ${normalized.reason}` };
    if (isGuarded(normalized.path)) {
      return {
        allowed: false,
        reason: `path "${normalized.path}" is not bot-writable (bots/, TEAM.md, skills/ and routines/ change only through an approved proposal)`,
      };
    }
  }
  return { allowed: true, reason: 'path allowed' };
}
