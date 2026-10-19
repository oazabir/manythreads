/**
 * The referee rule (guide §7): bots never write `bots/`, `TEAM.md`, `skills/`, `routines/`. Changes arrive only
 * as an approved proposal. Paths are repo-relative and case-sensitive.
 *
 * Two capabilities write a repo path without being `files.*`: `pages.write` (only ever offered under `pages/`) and `memory.write` — the ONE door a
 * bot writes the OKF bundle through (SPEC §12.1, PLAN P5-26), which is allowed under `memory/**` but not `memory/shared/`, not the platform's
 * `index.md`/`log.md`, and not a non-concept file. Everything else that says it writes a path stays judged like `files.write`.
 */
import { isConceptPath, isGuardedRepoPath, isInboxPath, isMemoryPath, isMemorySharedPath } from '@manythreads/shared';

/** `files.*` verbs that only read. Everything else under `files.` is treated as a write (fail closed). */
const READ_ONLY_FILE_VERBS: ReadonlySet<string> = new Set(['read', 'list', 'search', 'get', 'stat', 'diff', 'history']);

/** Capabilities outside `files.*` that write a repo path: guarded like `files.write` (the rules differ per capability below). */
const PATH_WRITE_CAPABILITIES: ReadonlySet<string> = new Set(['pages.write', 'memory.write']);

/** True for `files.write`, `files.delete`, `files.move`, ... any unknown `files.*` verb, `pages.write` and `memory.write`. */
export function isFilesMutation(capability: string): boolean {
  if (PATH_WRITE_CAPABILITIES.has(capability)) return true;
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

export interface PathVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Decide one path for a bot write. Also checks the percent-decoded form so `%2e%2e/` tricks do not pass.
 *
 * `capability` is the capability the write is made under (`files.write` when absent): `memory.write` is the only one that may reach `memory/`, and
 * only for a concept — `memory/shared/` is people-and-platform only, `index.md`/`log.md` are the platform's, and the bundle holds Markdown concepts.
 */
export function checkBotWritePath(raw: string, capability = 'files.write'): PathVerdict {
  const forms = [raw];
  // Decode repeatedly (double encoding such as %252e%252e), up to 4 layers.
  let current = raw;
  for (let i = 0; i < 4 && current.includes('%'); i++) {
    try {
      current = decodeURIComponent(current);
    } catch {
      return { allowed: false, reason: `path "${raw}" has invalid percent-encoding` };
    }
    forms.push(current);
  }
  for (const form of forms) {
    const normalized = normalizeRepoPath(form);
    if (!normalized.ok) return { allowed: false, reason: `traversal denied: ${normalized.reason}` };
    if (capability === 'memory.write' && !isMemoryPath(normalized.path)) {
      return { allowed: false, reason: `path "${normalized.path}" is not team memory: memory.write writes memory/**.md and nothing else` };
    }
    if (isGuardedRepoPath(normalized.path)) {
      return {
        allowed: false,
        reason: `path "${normalized.path}" is not bot-writable (bots/, TEAM.md, skills/ and routines/ change only through an approved proposal)`,
      };
    }
    if (isMemoryPath(normalized.path)) {
      // PLAN D6 / P5-25, P5-26: a bot writes memory only through `memory.write`; `files.*` (or any other capability) is refused the bundle.
      if (capability !== 'memory.write') {
        return {
          allowed: false,
          reason: `path "${normalized.path}" is team memory: bots write it only through memory.write, never through ${capability}`,
        };
      }
      if (isMemorySharedPath(normalized.path)) {
        return { allowed: false, reason: `path "${normalized.path}" is team memory only people and the platform write (memory/shared/)` };
      }
      if (!isConceptPath(normalized.path)) {
        return {
          allowed: false,
          reason: `path "${normalized.path}" is not a concept: memory.write writes memory/**.md except the platform's index.md and log.md`,
        };
      }
      continue;
    }
    if (isInboxPath(normalized.path)) {
      return {
        allowed: false,
        reason: `path "${normalized.path}" is the team inbox (Files storage), never a repository path`,
      };
    }
  }
  return { allowed: true, reason: 'path allowed' };
}
