// Repo paths (SPEC section 5.1, 7.2): what a path in a team repo may look like, which four places a bot may never write, and the
// directories of a new team's repo. Pure functions over strings: the kernel's path guard, the repo-git writer and the web client share them.

/** Longest repo path in bytes, and longest segment. Git has no limit; these keep rows, URLs and file systems sane. */
export const REPO_PATH_MAX_BYTES = 1024;
export const REPO_SEGMENT_MAX_BYTES = 255;

/** Directories under which a bot never writes, and the one file (SPEC section 7.2: changes arrive only as an approved proposal). */
export const GUARDED_REPO_DIRS: readonly string[] = ['bots', 'skills', 'routines'];
export const GUARDED_REPO_FILES: readonly string[] = ['TEAM.md'];

// Compared case-insensitively and NFKC-folded, trailing dots and spaces trimmed: the repo may be cloned onto a case-insensitive file system
// (macOS, Windows), where `team.md` or `Bots/` is the same file. Fail closed.
const fold = (segment: string): string => segment.normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
const GUARDED_DIR_SET: ReadonlySet<string> = new Set(GUARDED_REPO_DIRS.map(fold));
const GUARDED_FILE_SET: ReadonlySet<string> = new Set(GUARDED_REPO_FILES.map(fold));

/** True for `bots/...`, `skills/...`, `routines/...` and `TEAM.md`. `normalized` is a path with `.`, `..` and empty segments already resolved. */
export function isGuardedRepoPath(normalized: string): boolean {
  const parts = normalized.split('/').map(fold);
  return GUARDED_DIR_SET.has(parts[0] ?? '') || GUARDED_FILE_SET.has(parts.join('/'));
}

export type RepoPathResult = { ok: true; path: string } | { ok: false; reason: string };

const encoder = new TextEncoder();
// Segments git or a checkout would treat as repository metadata (compared folded): `.git` anywhere, and `.gitmodules`.
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.gitmodules']);

/**
 * The strict reading of a path a caller names: NFC-normalised, relative, no `.` or `..`, no empty segment, no backslash or control
 * character, no `.git` segment, no segment that ends in a dot or a space, within the length limits. Unlike the broker's lenient
 * `normalizeRepoPath` it never resolves `..`: it refuses.
 */
export function parseRepoPath(raw: string): RepoPathResult {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'path is empty' };
  const path = raw.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'path contains a control character' };
  if (path.includes('\\')) return { ok: false, reason: 'path contains a backslash' };
  if (path.startsWith('/')) return { ok: false, reason: 'path must be relative (no leading "/")' };
  if (path.endsWith('/')) return { ok: false, reason: 'path names a file, not a folder (no trailing "/")' };
  if (encoder.encode(path).length > REPO_PATH_MAX_BYTES) return { ok: false, reason: `path is longer than ${REPO_PATH_MAX_BYTES} bytes` };
  for (const segment of path.split('/')) {
    if (segment === '') return { ok: false, reason: 'path has an empty segment ("//")' };
    if (segment === '.' || segment === '..') return { ok: false, reason: `path has a "${segment}" segment` };
    if (/[. ]$/.test(segment)) return { ok: false, reason: `segment "${segment}" ends in a dot or a space` };
    if (FORBIDDEN_SEGMENTS.has(fold(segment))) return { ok: false, reason: `segment "${segment}" is reserved by git` };
    if (encoder.encode(segment).length > REPO_SEGMENT_MAX_BYTES) return { ok: false, reason: `segment is longer than ${REPO_SEGMENT_MAX_BYTES} bytes` };
  }
  return { ok: true, path };
}

/** The empty folders of a new team's repo (SPEC section 5.1). Git keeps no empty folder: each holds `REPO_PLACEHOLDER` until it has content. */
export const REPO_LAYOUT_DIRS: readonly string[] = ['bots', 'skills', 'routines', 'knowledge', 'memory/journal', 'memory/facts', 'pages'];
export const REPO_PLACEHOLDER = '.gitkeep';
/** The manifest file at the repo root. */
export const REPO_TEAM_FILE = 'TEAM.md';
/** The one branch of a team repo. */
export const REPO_BRANCH = 'main';
/** The largest text file the writer accepts (bytes), and how much of the start it inspects for a NUL byte. Beyond either it is an attachment. */
export const REPO_MAX_FILE_BYTES = 1_048_576;
export const REPO_BINARY_SNIFF_BYTES = 8192;
