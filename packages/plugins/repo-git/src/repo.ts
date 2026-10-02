import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AuditEvent,
  CapabilityAuthorizeContext,
  CapabilityDecision,
  PluginTx,
  RepoCommitIdentity,
  RepoFolderEntry,
  RepoWriteActor,
  RepoWriteOptions,
  RepoWriteChange,
  RepoWriteResult,
} from '@manythreads/sdk';
import {
  FILES_CHANNELS_DIR,
  MAX_REPO_CHANGES_PER_COMMIT,
  MAX_REPO_MESSAGE_LENGTH,
  REPO_BRANCH,
  REPO_MAX_FILE_BYTES,
  REPO_PLACEHOLDER,
  isGuardedRepoPath,
  parseRepoPath,
  type RepoConflict,
} from '@manythreads/shared';
import { repoForbidden, repoInvalid, repoNotFound, notInRepo, RepoError } from './errors.ts';
import {
  GitBlobTooLargeError,
  GitError,
  GitNotFoundError,
  GitPathError,
  type GitChange,
  type GitCommitInfo,
  type GitIdentity,
  type GitLayer,
  type GitTreeEntry,
} from './git/index.ts';
import { initialFiles } from './layout.ts';
import { KeyedQueue } from './queue.ts';
import { checkRepoContent, textOf } from './rules.ts';
import { REPO_COLUMNS, REPO_COMMIT_COLUMNS, REPO_ENTRY_COLUMNS, toRepo, toRepoCommit, toRepoEntry, type RepoCommitRow, type RepoEntryRow, type RepoRow } from './rows.ts';

// The repo service: one writer per team (PLAN P4-02, P4-05). Everything that changes a team repo goes through `write`.
//
//   in-process queue per team  ->  pg_advisory_xact_lock(team) in the caller's transaction  ->  git compare-and-swap  ->  index update
//   + `repo.repo.committed` in the same transaction.
//
// The advisory lock is transaction-scoped: it is held until the request's transaction ends, so a second writer (in this process or on
// another replica) waits at the lock until the first one's index rows are committed, then reads the head it left. The queue only orders the
// writers of one process and stops them from starting git processes they would have to wait for anyway.

/** The tree git knows without an object: what a file is compared with when it did not exist yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a416c4ca7ae7f5fe1c2d8fbc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The e-mail of every identity the writer puts in a commit: the actor id, so a commit maps back to the actor. */
export const ACTOR_EMAIL_DOMAIN = 'actors.manythreads.invalid';
const SYSTEM_IDENTITY: GitIdentity = { name: 'manythreads', email: 'system@manythreads.invalid' };
const ACTOR_EMAIL = new RegExp(`^([0-9a-f-]{36})@${ACTOR_EMAIL_DOMAIN.replaceAll('.', '\\.')}$`);
const actorIdOfEmail = (email: string): string | null => ACTOR_EMAIL.exec(email)?.[1] ?? null;

export type RepoActor = RepoWriteActor;
export type CommitIdentity = RepoCommitIdentity;
export type { RepoWriteChange, RepoWriteResult, RepoWriteOptions, RepoFolderEntry };

export interface RepoServiceDeps {
  /** `MANYTHREADS_REPO_DIR`, absolute. */
  repoDir: string;
  git: GitLayer;
  /** `ctx.capabilities.authorize`: the kernel broker. Bots are checked through it, never by a rule of this plugin. */
  authorize(tx: PluginTx, capability: string, context?: CapabilityAuthorizeContext): Promise<CapabilityDecision>;
  /** `ctx.audit.emit`. */
  emit(tx: PluginTx, event: AuditEvent): Promise<void>;
}

interface TeamInfo {
  id: string;
  slug: string;
  name: string;
  archived: boolean;
}

interface Prepared {
  path: string;
  op: 'put' | 'append' | 'delete';
  content: Buffer | null;
  baseBlobSha: string | null | undefined;
}

const asBuffer = (content: string | Uint8Array): Buffer => (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));

export function createRepoService(deps: RepoServiceDeps) {
  const { git, repoDir } = deps;
  const queue = new KeyedQueue();
  const gitDirFor = (teamId: string): string => join(repoDir, `${teamId}.git`);

  async function team(tx: PluginTx, teamId: string): Promise<TeamInfo> {
    if (!UUID.test(teamId)) throw repoNotFound('Team not found');
    const res = await tx.query<{ id: string; slug: string; name: string; archived_at: Date | null }>(
      'SELECT id, slug, name, archived_at FROM app.teams WHERE id = $1',
      [teamId],
    );
    const row = res.rows[0];
    if (row) return { id: row.id, slug: row.slug, name: row.name, archived: row.archived_at !== null };
    // A team the caller cannot see is 403 (existence is not revealed); an admin sees every team, so for them it is missing.
    const admin = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
    if (admin.rows[0]?.admin === true) throw repoNotFound('Team not found');
    throw repoForbidden('You are not a member of this team');
  }

  const takeLock = async (tx: PluginTx, teamId: string): Promise<void> => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`repo-git:${teamId}`]);
  };

  // ---- creating and catching up the repository (always under the team lock) -----------------------------------------------------

  async function authorOf(tx: PluginTx, actor: RepoActor): Promise<{ identity: GitIdentity; authorId: string | null }> {
    if (actor.kind === 'system') return { identity: SYSTEM_IDENTITY, authorId: null };
    let name = actor.name;
    if (!name && actor.kind === 'person') {
      const res = await tx.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = app.person_id()');
      name = res.rows[0]?.display_name;
    }
    if (!name) name = actor.kind === 'bot' ? `bot-${actor.id.slice(0, 8)}` : 'Someone';
    return { identity: { name, email: `${actor.id}@${ACTOR_EMAIL_DOMAIN}` }, authorId: actor.id };
  }

  /** Records one commit in the index tables and emits `repo.repo.committed`, in the caller's transaction. */
  async function record(
    tx: PluginTx,
    t: TeamInfo,
    gitDir: string,
    args: {
      expectedHead: string | null;
      sha: string;
      changes: { path: string; op: 'put' | 'delete'; content?: Uint8Array }[];
      authorId: string | null;
      coAuthorIds: string[];
      stampPending: boolean;
      /** `changes` is the whole tree (a first commit over an index that remembers a lost repository): the file index is replaced. */
      replaceAll?: boolean;
    },
  ): Promise<RepoWriteResult['paths']> {
    const info = await git.commitInfo(gitDir, args.sha);
    const putPaths = args.changes.filter((c) => c.op === 'put').map((c) => c.path);
    const stats = await git.statPaths(gitDir, args.sha, putPaths);
    const upserts = args.changes
      .filter((c): c is { path: string; op: 'put'; content: Uint8Array } => c.op === 'put' && c.content !== undefined)
      .map((c) => {
        const e = stats.get(c.path);
        if (!e || e.type !== 'blob') throw new RepoError(500, 'internal', `committed path "${c.path}" is missing from the new tree`);
        return { path: c.path, blob_sha: e.sha, size: e.size, last_commit_sha: args.sha, text_plain: textOf(c.content) };
      });
    const deletes = args.changes.filter((c) => c.op === 'delete').map((c) => c.path);
    const commits = [
      {
        sha: args.sha,
        parent_sha: info.parents[0] ?? null,
        author_id: args.authorId,
        co_authors: args.coAuthorIds,
        message: info.message,
        committed_at: info.authoredAt,
        paths: args.changes.map((c) => c.path),
      },
    ];
    await tx.query('SELECT app.repo_index_apply($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7, $8)', [
      t.id,
      args.expectedHead,
      args.sha,
      JSON.stringify(commits),
      JSON.stringify(upserts),
      deletes,
      args.replaceAll === true,
      args.stampPending,
    ]);
    await deps.emit(tx, {
      type: 'repo.repo.committed',
      teamId: t.id,
      sha: args.sha,
      parentSha: info.parents[0] ?? null,
      authorId: args.authorId,
      coAuthorIds: args.coAuthorIds,
      subject: info.subject.slice(0, 200),
      paths: args.changes.map((c) => ({ path: c.path, op: c.op })),
    });
    return args.changes.map((c) => {
      const e = c.op === 'put' ? stats.get(c.path) : undefined;
      return { path: c.path, op: c.op, blobSha: e?.sha ?? null, size: e?.size ?? null };
    });
  }

  /** The first commit: TEAM.md (the pending one, the template's, or a minimal manifest) and the section 5.1 layout. */
  async function bootstrap(tx: PluginTx, t: TeamInfo, gitDir: string, dbHead: string | null): Promise<string> {
    const seedRow = (await tx.query<{ seed: Record<string, unknown> | null }>('SELECT app.repo_seed($1) AS seed', [t.id])).rows[0]?.seed;
    if (!seedRow) throw repoNotFound('Team not found');
    const files = initialFiles({
      name: t.name,
      slug: t.slug,
      templateTeamMd: typeof seedRow['templateTeamMd'] === 'string' ? seedRow['templateTeamMd'] : null,
      pending: seedRow['pending'] && typeof seedRow['pending'] === 'object' ? (seedRow['pending'] as Record<string, unknown>) : null,
    });
    const changes = [...files].map(([path, text]) => ({ path, op: 'put' as const, content: Buffer.from(text, 'utf8') }));
    const made = await git.commit(gitDir, {
      expectedOld: null,
      changes: changes as GitChange[],
      message: 'Create the team repository',
      author: SYSTEM_IDENTITY,
    });
    if (made.noop) throw new RepoError(500, 'internal', 'the first commit was empty');
    await record(tx, t, gitDir, { expectedHead: dbHead, sha: made.sha, changes, authorId: null, coAuthorIds: [], stampPending: true, replaceAll: dbHead !== null });
    return made.sha;
  }

  /** Git got ahead of the index (a transaction rolled back after its commit, or the index is new): index every commit after `dbHead` and rebuild the file index. */
  async function reindex(tx: PluginTx, t: TeamInfo, gitDir: string, dbHead: string | null, head: string): Promise<void> {
    const shas = await git.commitsBetween(gitDir, dbHead, head);
    const commits: unknown[] = [];
    const lastTouched = new Map<string, string>();
    for (const sha of shas) {
      const [info, paths] = await Promise.all([git.commitInfo(gitDir, sha), git.commitPaths(gitDir, sha)]);
      for (const p of paths) lastTouched.set(p, sha);
      commits.push({
        sha,
        parent_sha: info.parents[0] ?? null,
        author_id: actorIdOfEmail(info.author.email),
        co_authors: info.coAuthors.map((c) => actorIdOfEmail(c.email)).filter((id): id is string => id !== null),
        message: info.message,
        committed_at: info.authoredAt,
        paths,
      });
    }
    const files = (await git.listFiles(gitDir, head)).filter((e) => e.type === 'blob');
    const previous = new Map(
      (await tx.query<{ path: string; last_commit_sha: string }>('SELECT path, last_commit_sha FROM app.repo_entries WHERE team_id = $1', [t.id])).rows.map((r) => [r.path, r.last_commit_sha]),
    );
    const texts = new Map<string, string | null>();
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      const blobs = await git.readBlobs(gitDir, batch.map((f) => f.sha), REPO_MAX_FILE_BYTES, 256 * 1024 * 1024);
      for (const f of batch) {
        const bytes = blobs.get(f.sha);
        texts.set(f.sha, bytes ? textOf(bytes) : null);
      }
    }
    const upserts = files.map((f) => ({
      path: f.path,
      blob_sha: f.sha,
      size: f.size ?? 0,
      last_commit_sha: lastTouched.get(f.path) ?? previous.get(f.path) ?? head,
      text_plain: texts.get(f.sha) ?? null,
    }));
    await tx.query('SELECT app.repo_index_apply($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], true, false)', [
      t.id,
      dbHead,
      head,
      JSON.stringify(commits),
      JSON.stringify(upserts),
      [],
    ]);
  }

  /** Creates what is missing (the bare repo, the `repos` row, the first commit) and catches the index up. Caller holds the team lock. */
  async function ensureLocked(tx: PluginTx, t: TeamInfo): Promise<{ gitDir: string; head: string }> {
    const gitDir = gitDirFor(t.id);
    const row = (await tx.query<{ head_sha: string | null }>('SELECT head_sha FROM app.repo_register($1, $2)', [t.id, `${t.id}.git`])).rows[0];
    if (!existsSync(join(gitDir, 'HEAD'))) {
      await mkdir(repoDir, { recursive: true });
      await git.initBare(gitDir);
    }
    const head = await git.resolve(gitDir, REPO_BRANCH);
    if (!head) return { gitDir, head: await bootstrap(tx, t, gitDir, row?.head_sha ?? null) };
    if ((row?.head_sha ?? null) !== head) await reindex(tx, t, gitDir, row?.head_sha ?? null, head);
    return { gitDir, head };
  }

  /**
   * The team's repository directory, created on first use. The common case (row, head and directory all there) takes no lock and starts
   * no process. Anyone who can read the team may trigger the creation: it is the same for everyone and idempotent.
   */
  async function ensure(tx: PluginTx, teamId: string): Promise<string> {
    const t = await team(tx, teamId);
    const gitDir = gitDirFor(t.id);
    const row = (await tx.query<{ head_sha: string | null }>('SELECT head_sha FROM app.repos WHERE team_id = $1', [t.id])).rows[0];
    if (row?.head_sha && existsSync(join(gitDir, 'HEAD'))) return gitDir;
    return queue.run(t.id, async () => {
      await takeLock(tx, t.id);
      return (await ensureLocked(tx, t)).gitDir;
    });
  }

  // ---- write ----------------------------------------------------------------------------------------------------------------------

  function plan(changes: readonly RepoWriteChange[], message: string): { prepared: Prepared[]; message: string } {
    if (changes.length === 0) throw repoInvalid('changes: at least one change is needed');
    if (changes.length > MAX_REPO_CHANGES_PER_COMMIT) throw repoInvalid(`changes: at most ${MAX_REPO_CHANGES_PER_COMMIT} changes in one commit`);
    const text = message.trim();
    if (text === '' || text.length > MAX_REPO_MESSAGE_LENGTH || text.includes('\0')) throw repoInvalid(`message: 1 to ${MAX_REPO_MESSAGE_LENGTH} characters, no NUL`);
    const seen = new Set<string>();
    const prepared: Prepared[] = [];
    for (const c of changes) {
      const parsed = parseRepoPath(c.path);
      if (!parsed.ok) throw repoInvalid(`path "${c.path}": ${parsed.reason}`);
      // `channels/<name>/` of the Files tree is where channel attachments appear: a repo file there would be hidden by (or hide) them.
      if (parsed.path.split('/')[0]?.normalize('NFKC').toLowerCase() === FILES_CHANNELS_DIR) {
        throw repoInvalid(`path "${parsed.path}": channels/ is reserved for the attachments of channels; put the page under pages/`);
      }
      if (seen.has(parsed.path)) throw repoInvalid(`path "${parsed.path}" appears twice in one commit`);
      seen.add(parsed.path);
      prepared.push({
        path: parsed.path,
        op: c.op,
        content: c.op === 'delete' ? null : asBuffer(c.content),
        baseBlobSha: c.op === 'append' ? undefined : c.baseBlobSha,
      });
    }
    for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) throw repoInvalid(`paths "${a}" and "${b}" overlap (a file and a folder of one name)`);
    return { prepared, message: text };
  }

  /** Who may write what (PLAN P4-05). Bots go through the kernel broker; people by team role; guests never. */
  async function authorizeWrite(tx: PluginTx, t: TeamInfo, actor: RepoActor, prepared: readonly Prepared[], options: RepoWriteOptions): Promise<void> {
    if (actor.kind === 'system') return;
    const res = await tx.query<{ post: boolean; manage: boolean }>("SELECT app.can('team', $1, 'post') AS post, app.can('team', $1, 'manage') AS manage", [t.id]);
    const row = res.rows[0];
    if (row?.post !== true) throw repoForbidden('You cannot change the files of this team');
    if (t.archived) throw new RepoError(409, 'conflict', 'This team is archived; unarchive it first');
    if (actor.kind === 'bot') {
      for (const c of prepared) {
        const capability = c.op === 'delete' ? 'files.delete' : (options.capability ?? 'files.write');
        const decision = await deps.authorize(tx, capability, { path: c.path });
        if (!decision.allowed) throw repoForbidden(decision.reason);
        if (decision.needsApproval) throw repoForbidden(`Writing "${c.path}" needs a person's approval`);
      }
      return;
    }
    if (row.manage !== true && prepared.some((c) => isGuardedRepoPath(c.path))) {
      throw repoForbidden(
        'Change by pull request: bots/, TEAM.md, skills/ and routines/ are changed directly only by team leads and workspace admins',
      );
    }
  }

  function mapGit(err: unknown): never {
    if (err instanceof RepoError) throw err;
    if (err instanceof GitNotFoundError) throw repoNotFound(err.message);
    if (err instanceof GitPathError) throw repoInvalid(err.message);
    if (err instanceof GitBlobTooLargeError) throw new RepoError(413, 'validation_failed', err.message);
    if (err instanceof GitError) {
      if (err.code === 'ref_conflict') throw new RepoError(409, 'conflict', 'The repository changed while this commit was being made; reload and try again');
      throw new RepoError(500, 'internal', `git ${err.code}`);
    }
    throw err;
  }

  async function write(
    tx: PluginTx,
    teamId: string,
    actor: RepoActor,
    changes: readonly RepoWriteChange[],
    message: string,
    coAuthors: readonly CommitIdentity[] = [],
    options: RepoWriteOptions = {},
  ): Promise<RepoWriteResult> {
    // The author is the transaction's actor: a caller cannot commit as somebody else.
    if (actor.id !== tx.actor.id || actor.kind !== tx.actor.kind) throw repoForbidden('The author of a commit is the actor of the transaction');
    const t = await team(tx, teamId);
    const { prepared, message: text } = plan(changes, message);
    await authorizeWrite(tx, t, actor, prepared, options);
    for (const c of prepared) {
      if (c.content === null) continue;
      const verdict = checkRepoContent(c.content);
      if (!verdict.ok) {
        throw notInRepo(
          verdict.reason === 'binary'
            ? `"${c.path}" is not text: the team repo holds text only, upload it as an attachment in a channel`
            : `"${c.path}" is larger than 1 MB: the team repo holds text pages, upload it as an attachment in a channel`,
        );
      }
    }
    const { identity, authorId } = await authorOf(tx, actor);
    const co: CommitIdentity[] = [];
    for (const c of coAuthors) if (UUID.test(c.actorId) && c.actorId !== authorId && !co.some((x) => x.actorId === c.actorId)) co.push(c);

    return queue.run(t.id, async () => {
      try {
        await takeLock(tx, t.id);
        const { gitDir, head } = await ensureLocked(tx, t);
        return await commitUnderLock(tx, t, gitDir, head, prepared, text, identity, authorId, co);
      } catch (err) {
        return mapGit(err);
      }
    });
  }

  async function commitUnderLock(
    tx: PluginTx,
    t: TeamInfo,
    gitDir: string,
    head: string,
    prepared: readonly Prepared[],
    message: string,
    identity: GitIdentity,
    authorId: string | null,
    co: readonly CommitIdentity[],
  ): Promise<RepoWriteResult> {
    // What the tree holds now at every path (and at each folder above it), in one git call.
    const ancestors = new Set<string>();
    for (const c of prepared) {
      const parts = c.path.split('/');
      for (let i = 1; i < parts.length; i += 1) ancestors.add(parts.slice(0, i).join('/'));
    }
    const stat = await git.statPaths(gitDir, head, [...new Set([...prepared.map((c) => c.path), ...ancestors])]);

    const conflicts: { path: string; reason: RepoConflict['reason']; entry: GitTreeEntry | undefined }[] = [];
    const finals: { path: string; op: 'put' | 'delete'; content?: Buffer }[] = [];
    const toRead = new Map<string, GitTreeEntry>();
    for (const c of prepared) {
      const now = stat.get(c.path);
      const fileAbove = [...ancestors].find((a) => c.path.startsWith(`${a}/`) && stat.get(a)?.type === 'blob');
      if (c.op === 'delete') {
        if (fileAbove || !now) {
          if (c.baseBlobSha) conflicts.push({ path: c.path, reason: 'missing', entry: undefined });
          continue; // nothing to delete
        }
        if (now.type === 'tree') conflicts.push({ path: c.path, reason: 'folder', entry: now });
        else if (c.baseBlobSha !== undefined && c.baseBlobSha !== now.sha) conflicts.push({ path: c.path, reason: c.baseBlobSha === null ? 'exists' : 'changed', entry: now });
        else finals.push({ path: c.path, op: 'delete' });
        continue;
      }
      if (fileAbove) {
        conflicts.push({ path: c.path, reason: 'parent_is_file', entry: stat.get(fileAbove) });
        continue;
      }
      if (now?.type === 'tree') {
        conflicts.push({ path: c.path, reason: 'folder', entry: now });
        continue;
      }
      if (c.op === 'put' && c.baseBlobSha !== undefined) {
        if (c.baseBlobSha === null && now) {
          conflicts.push({ path: c.path, reason: 'exists', entry: now });
          continue;
        }
        if (c.baseBlobSha !== null && !now) {
          conflicts.push({ path: c.path, reason: 'missing', entry: undefined });
          continue;
        }
        if (c.baseBlobSha !== null && now && now.sha !== c.baseBlobSha) {
          conflicts.push({ path: c.path, reason: 'changed', entry: now });
          continue;
        }
      }
      if (c.op === 'append' && now) toRead.set(c.path, now);
      finals.push({ path: c.path, op: 'put', content: c.content ?? Buffer.alloc(0) });
    }

    if (conflicts.length > 0) {
      const withBlobs = conflicts.flatMap((c) => (c.entry?.type === 'blob' ? [c.entry] : []));
      const blobs = await git.readBlobs(gitDir, withBlobs.map((e) => e.sha), REPO_MAX_FILE_BYTES, 16 * 1024 * 1024);
      throw new RepoError(
        409,
        'conflict',
        'The file changed since you opened it: nothing was written. Merge your edit with the current content and try again.',
        conflicts.map((c) => {
          const bytes = c.entry?.type === 'blob' ? blobs.get(c.entry.sha) : undefined;
          return {
            path: c.path,
            reason: c.reason,
            currentBlobSha: c.entry?.type === 'blob' ? c.entry.sha : null,
            currentSize: c.entry?.type === 'blob' ? c.entry.size : null,
            currentContent: bytes ? textOf(bytes) : null,
          };
        }),
      );
    }

    // append: current content + the piece (read inside the lock, so two appends never lose one)
    if (toRead.size > 0) {
      const blobs = await git.readBlobs(gitDir, [...toRead.values()].map((e) => e.sha), REPO_MAX_FILE_BYTES, 64 * 1024 * 1024);
      for (const f of finals) {
        const entry = toRead.get(f.path);
        if (!entry || f.op !== 'put') continue;
        const current = blobs.get(entry.sha);
        if (!current) throw notInRepo(`"${f.path}" is larger than 1 MB: the team repo holds text pages, upload it as an attachment in a channel`);
        f.content = Buffer.concat([current, f.content ?? Buffer.alloc(0)]);
        const verdict = checkRepoContent(f.content);
        if (!verdict.ok) throw notInRepo(`"${f.path}" would be larger than 1 MB after the append`);
      }
    }

    if (finals.length === 0) return { sha: head, parentSha: head, noop: true, authorId, paths: [] };

    const made = await git.commit(gitDir, {
      expectedOld: head,
      changes: finals.map((f) => (f.op === 'put' ? { path: f.path, op: 'put' as const, content: f.content ?? Buffer.alloc(0) } : { path: f.path, op: 'delete' as const })),
      message,
      author: identity,
      coAuthors: co.map((c) => ({ name: c.name, email: `${c.actorId}@${ACTOR_EMAIL_DOMAIN}` })),
    });
    if (made.noop) return { sha: head, parentSha: head, noop: true, authorId, paths: [] };
    const paths = await record(tx, t, gitDir, {
      expectedHead: head,
      sha: made.sha,
      changes: finals.map((f) => ({ path: f.path, op: f.op, ...(f.content ? { content: f.content } : {}) })),
      authorId,
      coAuthorIds: co.map((c) => c.actorId),
      stampPending: false,
    });
    return { sha: made.sha, parentSha: head, noop: false, authorId, paths };
  }

  /** Puts `path` back as it was at commit `sha`, as a new commit (history keeps every old commit). */
  async function restore(
    tx: PluginTx,
    teamId: string,
    actor: RepoActor,
    path: string,
    sha: string,
    coAuthors: readonly CommitIdentity[] = [],
    message?: string,
  ): Promise<RepoWriteResult> {
    const parsed = parseRepoPath(path);
    if (!parsed.ok) throw repoInvalid(`path "${path}": ${parsed.reason}`);
    const gitDir = await ensure(tx, teamId);
    let change: GitChange;
    try {
      change = await git.restoreChange(gitDir, parsed.path, sha, REPO_MAX_FILE_BYTES);
    } catch (err) {
      return mapGit(err);
    }
    const write1: RepoWriteChange = change.op === 'put' ? { path: parsed.path, op: 'put', content: change.content } : { path: parsed.path, op: 'delete' };
    return write(tx, teamId, actor, [write1], message ?? `Restore ${parsed.path} to ${sha.slice(0, 7)}`, coAuthors);
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------------------

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      return mapGit(err);
    }
  }

  /**
   * The files and folders directly below `folder` ('' is the root), from the index: one query, grouped by the next path segment, with the commit that last
   * touched each file (a folder: the newest below it). `.gitkeep` placeholders keep a folder in the list but are not rows themselves.
   */
  async function list(tx: PluginTx, teamId: string, folder: string): Promise<RepoFolderEntry[]> {
    await ensure(tx, teamId);
    const prefix = folder === '' ? '' : `${folder}/`;
    const res = await tx.query<{
      name: string;
      is_dir: boolean;
      blob_sha: string | null;
      size: string | number | null;
      updated_at: Date | null;
      updated_by: string | null;
    }>(
      `SELECT r.seg AS name, r.is_dir,
              CASE WHEN r.is_dir THEN NULL ELSE min(r.blob_sha) END AS blob_sha,
              CASE WHEN r.is_dir THEN NULL ELSE min(r.size) END AS size,
              max(c.committed_at) AS updated_at,
              (array_agg(c.author_id ORDER BY c.committed_at DESC, c.seq DESC))[1] AS updated_by
         FROM (SELECT split_part(substr(e.path, char_length($2::text) + 1), '/', 1) AS seg,
                      position('/' IN substr(e.path, char_length($2::text) + 1)) > 0 AS is_dir,
                      e.blob_sha, e.size, e.last_commit_sha
                 FROM app.repo_entries e
                WHERE e.team_id = $1 AND left(e.path, char_length($2::text)) = $2::text) r
         LEFT JOIN app.repo_commits c ON c.team_id = $1 AND c.sha = r.last_commit_sha
        GROUP BY r.seg, r.is_dir`,
      [teamId, prefix],
    );
    if (res.rows.length === 0 && folder !== '') throw repoNotFound(`"${folder}" is not a folder of this repository`);
    return res.rows
      .filter((r) => r.is_dir || r.name !== REPO_PLACEHOLDER)
      .map((r) => ({
        name: r.name,
        path: `${prefix}${r.name}`,
        kind: r.is_dir ? ('folder' as const) : ('file' as const),
        blobSha: r.blob_sha,
        size: r.size === null ? null : Number(r.size),
        updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
        updatedBy: r.updated_by,
      }))
      .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'folder' ? -1 : 1));
  }

  /** Commits that touched `path` (a file, a folder, or '' for everything), newest first, with what each did to a single file. */
  async function history(tx: PluginTx, teamId: string, opts: { path: string; limit: number; cursor?: string | undefined }) {
    return guarded(async () => {
      const gitDir = await ensure(tx, teamId);
      const page = await git.log(gitDir, { limit: opts.limit, ...(opts.path !== '' ? { path: opts.path } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) });
      const statuses = opts.path === '' ? new Map<string, string>() : await git.pathStatuses(gitDir, page.commits.map((c) => c.sha), opts.path);
      return {
        nextCursor: page.nextCursor,
        commits: page.commits.map((c) => ({
          sha: c.sha,
          parentSha: c.parents[0] ?? null,
          authorId: actorIdOfEmail(c.author.email),
          authorName: c.author.name,
          coAuthorIds: c.coAuthors.map((a) => actorIdOfEmail(a.email)).filter((id): id is string => id !== null),
          subject: c.subject,
          message: c.message,
          committedAt: c.authoredAt,
          change: ({ A: 'added', M: 'modified', D: 'deleted' } as const)[statuses.get(c.sha) as 'A' | 'M' | 'D'] ?? null,
        })),
      };
    });
  }

  /** One file between two commits as a patch. `from` null/absent: the parent of `to` (the empty tree for a first commit). */
  async function diffFile(tx: PluginTx, teamId: string, opts: { path: string; from?: string | undefined; to: string }) {
    return guarded(async () => {
      const gitDir = await ensure(tx, teamId);
      const to = await git.resolve(gitDir, opts.to);
      if (!to) throw new GitNotFoundError(`ref "${opts.to}" does not exist`);
      let from: string | null;
      if (opts.from) {
        from = await git.resolve(gitDir, opts.from);
        if (!from) throw new GitNotFoundError(`ref "${opts.from}" does not exist`);
      } else {
        from = (await git.commitInfo(gitDir, to)).parents[0] ?? null;
      }
      const result = await git.diff(gitDir, from ?? EMPTY_TREE, to, opts.path);
      return { from, to, ...result };
    });
  }

  return {
    gitDirFor,
    ensure,
    write,
    restore,
    list,
    history,
    diffFile,
    /** Folders and files directly below `path` (empty string: the root) at `ref`. */
    tree: (tx: PluginTx, teamId: string, path: string, ref: string) =>
      guarded(async () => git.tree(await ensure(tx, teamId), path, ref)),
    /** One file at `ref`; refuses a file over `maxBytes` (default 1 MB). */
    blob: (tx: PluginTx, teamId: string, path: string, ref: string, maxBytes = REPO_MAX_FILE_BYTES) =>
      guarded(async () => git.blob(await ensure(tx, teamId), path, ref, maxBytes)),
    log: (tx: PluginTx, teamId: string, opts: { path?: string; limit: number; cursor?: string | null }) =>
      guarded(async () => git.log(await ensure(tx, teamId), opts)),
    diff: (tx: PluginTx, teamId: string, a: string, b: string, path?: string) => guarded(async () => git.diff(await ensure(tx, teamId), a, b, path)),
    show: (tx: PluginTx, teamId: string, sha: string) => guarded(async () => git.show(await ensure(tx, teamId), sha)),
    /** The index rows (RLS: whoever reads the team). */
    index: {
      async repo(tx: PluginTx, teamId: string) {
        const res = await tx.query<RepoRow & Record<string, unknown>>(`SELECT ${REPO_COLUMNS} FROM app.repos r WHERE r.team_id = $1`, [teamId]);
        return res.rows[0] ? toRepo(res.rows[0]) : null;
      },
      async entries(tx: PluginTx, teamId: string, prefix = '') {
        const res = await tx.query<RepoEntryRow & Record<string, unknown>>(
          `SELECT ${REPO_ENTRY_COLUMNS} FROM app.repo_entries e WHERE e.team_id = $1 AND left(e.path, $3::int) = $2 ORDER BY e.path`,
          [teamId, prefix, prefix.length],
        );
        return res.rows.map(toRepoEntry);
      },
      async commits(tx: PluginTx, teamId: string, limit = 50) {
        const res = await tx.query<RepoCommitRow & Record<string, unknown>>(
          `SELECT ${REPO_COMMIT_COLUMNS} FROM app.repo_commits c WHERE c.team_id = $1 ORDER BY c.committed_at DESC, c.seq DESC LIMIT $2`,
          [teamId, limit],
        );
        return res.rows.map(toRepoCommit);
      },
    },
  };
}

export type RepoService = ReturnType<typeof createRepoService>;
export type { GitCommitInfo };
