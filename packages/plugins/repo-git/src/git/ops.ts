import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_BRANCH } from '@manythreads/shared';
import { createGitRunner, GitError, type GitRunner } from './exec.ts';

// The git operations of the repo (PLAN P4-03), all on the `git` CLI through `GitRunner`. Reads name a ref; writes build a commit on a
// temporary index and move the branch with a compare-and-swap, so a lost race changes nothing. Every path is checked before it reaches argv.

const ZERO_SHA = '0'.repeat(40);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;

export class GitNotFoundError extends Error {
  override readonly name = 'GitNotFoundError';
}
export class GitBlobTooLargeError extends Error {
  override readonly name = 'GitBlobTooLargeError';
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`blob is ${size} bytes, the limit is ${limit}`);
  }
}
export class GitPathError extends Error {
  override readonly name = 'GitPathError';
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitTreeEntry {
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  /** Bytes for a blob; null for a tree. */
  size: number | null;
  /** Full path from the repository root. */
  path: string;
  name: string;
}

export interface GitCommitInfo {
  sha: string;
  parents: string[];
  author: GitIdentity;
  authoredAt: string;
  /** Full message including trailers. */
  message: string;
  subject: string;
  coAuthors: GitIdentity[];
}

export type GitChange = { path: string; op: 'put'; content: Uint8Array } | { path: string; op: 'delete' };

export interface GitCommitInput {
  /** Branch to move (default `main`). */
  ref?: string;
  /** The sha the branch is at now (null for an empty repository). The branch moves only if it still is there. */
  expectedOld: string | null;
  changes: readonly GitChange[];
  message: string;
  author: GitIdentity;
  coAuthors?: readonly GitIdentity[];
  date?: Date;
}

export type GitCommitResult = { noop: true; sha: string | null } | { noop: false; sha: string; tree: string; parent: string | null };

export interface GitDiffResult {
  files: { path: string; status: string }[];
  patch: string;
  truncated: boolean;
}

export interface GitLayerOptions {
  runner?: GitRunner;
  /** Longest a single git call may run (ms). */
  timeoutMs?: number;
  /** Cap on the bytes of listings, logs and diffs. */
  maxOutputBytes?: number;
}

/** Git control characters out of an identity or a message line: `<`, `>` and newlines would forge trailers. */
export const cleanIdentityPart = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

const sanitizeIdentity = (id: GitIdentity): GitIdentity => ({
  name: cleanIdentityPart(id.name) || 'unknown',
  email: cleanIdentityPart(id.email).replace(/\s/g, '') || 'unknown@manythreads.invalid',
});

/** A repo path as git sees it. Callers have normalised it with `parseRepoPath`; this refuses what could still do harm in argv or an index. */
export function assertGitPath(path: string): void {
  // eslint-disable-next-line no-control-regex
  if (path === '' || path.startsWith('/') || path.endsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path)) throw new GitPathError(`invalid path "${path}"`);
  if (path !== path.normalize('NFC')) throw new GitPathError(`path "${path}" is not NFC-normalised`);
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || seg.toLowerCase() === '.git') throw new GitPathError(`invalid path "${path}"`);
  }
}

const assertSha = (sha: string, what = 'sha'): void => {
  if (!SHA.test(sha)) throw new GitPathError(`${what} "${sha}" is not a full git sha`);
};
const assertRef = (ref: string): void => {
  if (!REF.test(ref)) throw new GitPathError(`invalid ref "${ref}"`);
};

const TRAILER = /^Co-authored-by:[ \t]*(.+?)[ \t]*<([^<>\s]+)>[ \t]*$/i;

export function parseCoAuthors(message: string): GitIdentity[] {
  const out: GitIdentity[] = [];
  for (const line of message.split('\n')) {
    const m = TRAILER.exec(line.trim());
    if (m) out.push({ name: m[1]!, email: m[2]! });
  }
  return out;
}

const parseCommitRecord = (record: string): GitCommitInfo => {
  // %H \x1f %P \x1f %an \x1f %ae \x1f %aI \x1f %B  (the message may hold anything but NUL, even \x1f: split at most five times)
  const parts: string[] = [];
  let rest = record;
  for (let i = 0; i < 5; i += 1) {
    const at = rest.indexOf('\x1f');
    if (at < 0) throw new GitError('failed', 'unexpected git log output');
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  const [sha, parents, name, email, at] = parts as [string, string, string, string, string];
  const message = rest.replace(/\n+$/, '');
  return {
    sha,
    parents: parents === '' ? [] : parents.split(' '),
    author: { name, email },
    authoredAt: at,
    message,
    subject: message.split('\n', 1)[0] ?? '',
    coAuthors: parseCoAuthors(message),
  };
};
const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B';

export function createGitLayer(options: GitLayerOptions = {}) {
  const runner = options.runner ?? createGitRunner();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const run = (gitDir: string, args: readonly string[], opts: Parameters<GitRunner['run']>[1] = {}) =>
    runner.run(args, { gitDir, timeoutMs, maxOutputBytes, ...opts });

  /** Creates the bare repository (idempotent): no templates (so no sample hooks), SHA-1, branch `main`. */
  async function initBare(gitDir: string): Promise<void> {
    await runner.run(['init', '--bare', '--quiet', '--template=', '--object-format=sha1', `--initial-branch=${REPO_BRANCH}`, gitDir], { timeoutMs });
  }

  /** The commit a ref names, or null when it names nothing. */
  async function resolve(gitDir: string, ref: string): Promise<string | null> {
    assertRef(ref);
    if (!existsSync(gitDir)) return null;
    const res = await run(gitDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { okExit: [0, 1] });
    const sha = res.stdout.toString('utf8').trim();
    return res.exitCode === 0 && SHA.test(sha) ? sha : null;
  }

  const parseTree = (stdout: Buffer): GitTreeEntry[] => {
    const entries: GitTreeEntry[] = [];
    for (const record of stdout.toString('utf8').split('\0')) {
      if (record === '') continue;
      const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}) +(-|\d+)\t([\s\S]*)$/.exec(record);
      if (!m || m[2] === 'commit') continue; // a submodule entry cannot be written by the writer; never listed
      const path = m[5]!;
      entries.push({
        mode: m[1]!,
        type: m[2] as 'blob' | 'tree',
        sha: m[3]!,
        size: m[4] === '-' ? null : Number(m[4]),
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
      });
    }
    return entries;
  };

  /** Entries of a folder at a ref (`path` '' is the root). Folders first, then files, each by name. */
  async function tree(gitDir: string, path: string, ref: string): Promise<{ commitSha: string; entries: GitTreeEntry[] }> {
    if (path !== '') assertGitPath(path);
    const commit = await resolve(gitDir, ref);
    if (!commit) throw new GitNotFoundError(`ref "${ref}" does not exist`);
    if (path !== '') {
      const type = await run(gitDir, ['cat-file', '-t', '--end-of-options', `${commit}:${path}`], { okExit: [0, 128] });
      const t = type.stdout.toString('utf8').trim();
      if (type.exitCode !== 0) throw new GitNotFoundError(`"${path}" does not exist at ${ref}`);
      if (t !== 'tree') throw new GitPathError(`"${path}" is a file, not a folder`);
    }
    const res = await run(gitDir, ['ls-tree', '-z', '-l', '--end-of-options', path === '' ? commit : `${commit}:${path}`]);
    const entries = parseTree(res.stdout).map((e) => ({ ...e, path: path === '' ? e.name : `${path}/${e.name}` }));
    entries.sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'tree' ? -1 : 1));
    return { commitSha: commit, entries };
  }

  /** What the tree holds at each named path (exactly those paths: files or folders), in one call. Missing paths are absent from the map. */
  async function statPaths(gitDir: string, commit: string | null, paths: readonly string[]): Promise<Map<string, GitTreeEntry>> {
    const out = new Map<string, GitTreeEntry>();
    if (!commit || paths.length === 0) return out;
    assertSha(commit, 'commit');
    for (const p of paths) assertGitPath(p);
    const res = await run(gitDir, ['ls-tree', '-z', '-l', '--end-of-options', commit, '--', ...paths]);
    for (const e of parseTree(res.stdout)) out.set(e.path, e);
    return out;
  }

  /** One file at a ref, refusing a blob larger than `maxBytes` before reading it. */
  async function blob(gitDir: string, path: string, ref: string, maxBytes: number): Promise<{ commitSha: string; sha: string; size: number; content: Buffer }> {
    assertGitPath(path);
    const commit = await resolve(gitDir, ref);
    if (!commit) throw new GitNotFoundError(`ref "${ref}" does not exist`);
    const entry = (await statPaths(gitDir, commit, [path])).get(path);
    if (!entry) throw new GitNotFoundError(`"${path}" does not exist at ${ref}`);
    if (entry.type !== 'blob' || entry.size === null) throw new GitPathError(`"${path}" is a folder, not a file`);
    if (entry.size > maxBytes) throw new GitBlobTooLargeError(entry.size, maxBytes);
    const content = await readBlob(gitDir, entry.sha, maxBytes);
    return { commitSha: commit, sha: entry.sha, size: entry.size, content };
  }

  /** The bytes of a blob by sha. */
  async function readBlob(gitDir: string, sha: string, maxBytes: number): Promise<Buffer> {
    assertSha(sha, 'blob sha');
    const res = await run(gitDir, ['cat-file', 'blob', '--end-of-options', sha], { maxOutputBytes: maxBytes });
    return res.stdout;
  }

  /** Several blobs in one process: `cat-file --batch`. Blobs over `maxBytesEach` come back as null (the caller does not need their text). */
  async function readBlobs(gitDir: string, shas: readonly string[], maxBytesEach: number, totalCap: number): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    const unique = [...new Set(shas)];
    if (unique.length === 0) return out;
    for (const s of unique) assertSha(s, 'blob sha');
    const res = await run(gitDir, ['cat-file', '--batch'], { input: `${unique.join('\n')}\n`, maxOutputBytes: totalCap });
    const buf = res.stdout;
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0) break;
      const header = buf.toString('utf8', at, nl).split(' ');
      const [sha, type, sizeText] = header;
      if (type === 'missing' || sha === undefined) {
        if (sha) out.set(sha, null);
        at = nl + 1;
        continue;
      }
      const size = Number(sizeText);
      const start = nl + 1;
      out.set(sha, type === 'blob' && size <= maxBytesEach ? Buffer.from(buf.subarray(start, start + size)) : null);
      at = start + size + 1;
    }
    return out;
  }

  /** Every file of a commit, recursively (for rebuilding the index). Capped by the output limit. */
  async function listFiles(gitDir: string, commit: string): Promise<GitTreeEntry[]> {
    assertSha(commit, 'commit');
    const res = await run(gitDir, ['ls-tree', '-r', '-z', '-l', '--end-of-options', commit]);
    return parseTree(res.stdout);
  }

  /**
   * Commits newest first, optionally only those that touched `path`. `cursor` is the sha of the last commit of the previous page: the page
   * starts after it. Returns `limit` commits and the cursor of the next page (null at the end).
   */
  async function log(gitDir: string, opts: { path?: string; limit: number; cursor?: string | null; ref?: string }): Promise<{ commits: GitCommitInfo[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const start = opts.cursor ? opts.cursor : (opts.ref ?? REPO_BRANCH);
    if (opts.cursor) assertSha(opts.cursor, 'cursor');
    else assertRef(start);
    if (opts.path) assertGitPath(opts.path);
    const args = ['log', '-z', `--format=${LOG_FORMAT}`, `-n${limit + 1}`, ...(opts.cursor ? ['--skip=1'] : []), '--end-of-options', start, ...(opts.path ? ['--', opts.path] : [])];
    const res = await run(gitDir, args, { okExit: [0, 128] });
    if (res.exitCode !== 0) return { commits: [], nextCursor: null };
    const commits = res.stdout
      .toString('utf8')
      .split('\0')
      .filter((r) => r !== '')
      .map(parseCommitRecord);
    const more = commits.length > limit;
    const page = commits.slice(0, limit);
    return { commits: page, nextCursor: more ? (page[page.length - 1]?.sha ?? null) : null };
  }

  async function commitInfo(gitDir: string, sha: string): Promise<GitCommitInfo> {
    assertSha(sha, 'commit');
    const res = await run(gitDir, ['log', '-z', `--format=${LOG_FORMAT}`, '-n1', '--end-of-options', sha], { okExit: [0, 128] });
    const record = res.stdout.toString('utf8').split('\0')[0] ?? '';
    if (res.exitCode !== 0 || record === '') throw new GitNotFoundError(`commit ${sha} does not exist`);
    return parseCommitRecord(record);
  }

  const parseNameStatus = (stdout: Buffer): { path: string; status: string }[] => {
    const parts = stdout.toString('utf8').split('\0').filter((p) => p !== '');
    const files: { path: string; status: string }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
    return files;
  };

  /** Changes between two commits (either may be the sha or `ref`), optionally of one path: the file list and a unified patch (truncated at the output cap). */
  async function diff(gitDir: string, a: string, b: string, path?: string): Promise<GitDiffResult> {
    assertRef(a);
    assertRef(b);
    if (path) assertGitPath(path);
    const tail = ['--end-of-options', a, b, ...(path ? ['--', path] : [])];
    const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
    const names = await run(gitDir, [...common, '--name-status', '-z', ...tail]);
    const patch = await run(gitDir, [...common, '--unified=3', ...tail], { onOverflow: 'truncate' });
    return { files: parseNameStatus(names.stdout), patch: patch.stdout.toString('utf8'), truncated: patch.truncated };
  }

  /** One commit with the paths it changed and its patch against its first parent (the whole tree for the first commit). */
  async function show(gitDir: string, sha: string): Promise<GitCommitInfo & GitDiffResult> {
    const info = await commitInfo(gitDir, sha);
    const common = ['diff-tree', '--root', '-r', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-renames'];
    const names = await run(gitDir, [...common, '--name-status', '-z', '--end-of-options', info.sha]);
    const patch = await run(gitDir, [...common, '-p', '--unified=3', '--no-color', '--end-of-options', info.sha], { onOverflow: 'truncate' });
    return { ...info, files: parseNameStatus(names.stdout), patch: patch.stdout.toString('utf8'), truncated: patch.truncated };
  }

  /**
   * What each commit in `shas` did to `path` when it names exactly that one file: sha to `A`, `M` or `D`. A commit that touched other paths below it (a
   * folder) is left out. One process for the whole page of history.
   */
  async function pathStatuses(gitDir: string, shas: readonly string[], path: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (shas.length === 0) return out;
    assertGitPath(path);
    for (const s of shas) assertSha(s, 'commit');
    const res = await run(gitDir, ['log', '--no-walk=unsorted', '--format=%x01%H', '--name-status', '--no-renames', '--end-of-options', ...shas, '--', path]);
    for (const block of res.stdout.toString('utf8').split('\x01')) {
      if (block === '') continue;
      const lines = block.split('\n').filter((l) => l !== '');
      const sha = lines[0];
      const rest = lines.slice(1);
      if (sha === undefined || rest.length !== 1) continue;
      const [status, name] = rest[0]!.split('\t');
      if (name === path && status !== undefined && /^[AMD]$/.test(status)) out.set(sha, status);
    }
    return out;
  }

  /** Paths a commit changed (for the history index). */
  async function commitPaths(gitDir: string, sha: string): Promise<string[]> {
    assertSha(sha, 'commit');
    const res = await run(gitDir, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', '--end-of-options', sha]);
    return res.stdout.toString('utf8').split('\0').filter((p) => p !== '');
  }

  /** Shas from `after` (exclusive, null for the beginning) to `head`, oldest first. */
  async function commitsBetween(gitDir: string, after: string | null, head: string, cap = 2000): Promise<string[]> {
    assertSha(head, 'head');
    if (after) assertSha(after, 'commit');
    const range = after ? `${after}..${head}` : head;
    const res = await run(gitDir, ['rev-list', '--reverse', `--max-count=${cap}`, '--end-of-options', range], { okExit: [0, 128] });
    if (res.exitCode !== 0) return after ? commitsBetween(gitDir, null, head, cap) : [];
    return res.stdout.toString('utf8').split('\n').filter((l) => SHA.test(l));
  }

  /**
   * Builds a commit with a temporary index (`hash-object -w`, `update-index --index-info`, `write-tree`, `commit-tree`) and moves the branch
   * with `update-ref <new> <old>`: a compare-and-swap, so when the branch is no longer at `expectedOld` it throws `GitError('ref_conflict')`
   * and the branch is untouched. A change set that leaves the tree as it was is a no-op (no commit).
   */
  async function commit(gitDir: string, input: GitCommitInput): Promise<GitCommitResult> {
    const ref = `refs/heads/${input.ref ?? REPO_BRANCH}`;
    assertRef(input.ref ?? REPO_BRANCH);
    if (input.expectedOld) assertSha(input.expectedOld, 'expected sha');
    for (const c of input.changes) assertGitPath(c.path);
    if (input.message.includes('\0')) throw new GitPathError('commit message contains a NUL byte');
    const indexFile = join(gitDir, `mt-index-${randomUUID()}`);
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    try {
      if (input.expectedOld) await run(gitDir, ['read-tree', '--end-of-options', input.expectedOld], { env: indexEnv });
      // deletes first: a put of `a` after a delete of `a/b` in one commit must find the folder gone
      const lines: string[] = [];
      for (const c of input.changes) if (c.op === 'delete') lines.push(`0 ${ZERO_SHA}\t${c.path}\0`);
      for (const c of input.changes) {
        if (c.op !== 'put') continue;
        const hashed = await run(gitDir, ['hash-object', '-w', '--stdin'], { input: c.content });
        lines.push(`100644 ${hashed.stdout.toString('utf8').trim()}\t${c.path}\0`);
      }
      if (lines.length > 0) await run(gitDir, ['update-index', '-z', '--index-info'], { env: indexEnv, input: lines.join('') });
      const written = await run(gitDir, ['write-tree'], { env: indexEnv });
      const treeSha = written.stdout.toString('utf8').trim();
      const parentTree = input.expectedOld
        ? (await run(gitDir, ['rev-parse', '--verify', '--end-of-options', `${input.expectedOld}^{tree}`])).stdout.toString('utf8').trim()
        : EMPTY_TREE;
      if (treeSha === parentTree && input.expectedOld) return { noop: true, sha: input.expectedOld };

      const author = sanitizeIdentity(input.author);
      const seen = new Set([author.email]);
      const trailers: string[] = [];
      for (const co of input.coAuthors ?? []) {
        const id = sanitizeIdentity(co);
        if (seen.has(id.email)) continue;
        seen.add(id.email);
        trailers.push(`Co-authored-by: ${id.name} <${id.email}>`);
      }
      const message = `${input.message.replace(/\s+$/, '')}\n${trailers.length > 0 ? `\n${trailers.join('\n')}\n` : ''}`;
      const stamp = `@${Math.floor((input.date ?? new Date()).getTime() / 1000)} +0000`;
      const env = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: stamp,
      };
      const made = await run(gitDir, ['commit-tree', treeSha, ...(input.expectedOld ? ['-p', input.expectedOld] : []), '-F', '-'], { env, input: message });
      const sha = made.stdout.toString('utf8').trim();
      assertSha(sha, 'new commit');
      await run(gitDir, ['update-ref', '-m', `commit: ${message.split('\n', 1)[0]?.slice(0, 100) ?? ''}`, ref, sha, input.expectedOld ?? ZERO_SHA]);
      return { noop: false, sha, tree: treeSha, parent: input.expectedOld };
    } finally {
      await rm(indexFile, { force: true });
      await rm(`${indexFile}.lock`, { force: true });
    }
  }

  /**
   * The change that puts `path` back as it was at commit `sha`: a put of that content, or a delete when the path did not exist there.
   * Committing it (through the writer) is a restore: a new commit, the old ones stay.
   */
  async function restoreChange(gitDir: string, path: string, sha: string, maxBytes: number): Promise<GitChange> {
    assertGitPath(path);
    assertSha(sha, 'commit');
    if (!(await resolve(gitDir, sha))) throw new GitNotFoundError(`commit ${sha} does not exist`);
    const entry = (await statPaths(gitDir, sha, [path])).get(path);
    if (!entry) return { path, op: 'delete' };
    if (entry.type !== 'blob' || entry.size === null) throw new GitPathError(`"${path}" is a folder at ${sha}: restore its files one by one`);
    if (entry.size > maxBytes) throw new GitBlobTooLargeError(entry.size, maxBytes);
    return { path, op: 'put', content: await readBlob(gitDir, entry.sha, maxBytes) };
  }

  return { runner, initBare, resolve, tree, statPaths, blob, readBlob, readBlobs, listFiles, log, commitInfo, diff, show, pathStatuses, commitPaths, commitsBetween, commit, restoreChange };
}

export type GitLayer = ReturnType<typeof createGitLayer>;
