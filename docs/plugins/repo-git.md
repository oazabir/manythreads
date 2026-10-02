# repo-git

The team repo: one bare git repository per team, one writer in front of it, an index in Postgres (SPEC section 5.1, principle 8; PLAN P4-01 to P4-05).
Code: `packages/plugins/repo-git`. Schemas: `packages/shared/src/{entities/repo,entities/repo-paths,api/repo,events/repo.repo.committed}`. Git is the truth;
the tables are an index that is rebuilt from git when it falls behind. Attachments never go to git ([files.md](./files.md)).

## Where it lives

`${MANYTHREADS_REPO_DIR}/<team id>.git` (default `./data/repos`). In the cluster that is the PVC `manythreads-repos` mounted at `/data/repos` (Helm `server.repos.persistence`,
ReadWriteOnce like the blob volume: one server replica); the server image carries the `git` binary. Dev, tests and e2e use a temporary directory per server.
Backups: the repositories are history, back the directory up together with the database (a plain `tar` of a quiet directory is a valid backup: git writes objects first and moves
the branch last). Loose objects pile up with writes; a periodic `git gc` over the directory is safe while the server runs and is a later maintenance job.

## The layout of a new team's repo (SPEC section 5.1, criterion 1)

The first commit (author `manythreads`, subject "Create the team repository") writes `TEAM.md` and the folders of the layout. Git keeps no empty folder, so each is a `.gitkeep`
until it has content; the Files tree hides `.gitkeep`.

```
TEAM.md                       the pending TEAM.md of team creation (team_pending_files, stamped applied_at), else the template's copy, else a minimal manifest
bots/ skills/ routines/ knowledge/ pages/        .gitkeep
memory/journal/  memory/facts/                   .gitkeep
```

It is created by the job `repo-git.init` (one per team, deduplicated), enqueued when `workspace.team.created` or `team.template.applied` is consumed, by the migration for every
team that exists when it is applied, and, as the common safety net, by the first request that needs the repo (a team seeded straight into the database has no event). Everything
is idempotent: the repos row is a get-or-create, the first commit happens only when `main` does not exist, and all of it runs under the team lock.

## One writer per team

`repo.write` is the only way a team repo changes. For other plugins it is `ctx.providers.get<RepoProvider>('repo')` (extension point `provider.repo`, types in `@manythreads/sdk`):

```ts
write(tx, teamId, actor: { id, kind, name? }, changes: RepoWriteChange[], message: string, coAuthors?: { actorId, name }[]): Promise<RepoWriteResult>
// RepoWriteChange = { path, op: 'put', content, baseBlobSha? } | { path, op: 'append', content } | { path, op: 'delete', baseBlobSha? }
// RepoWriteResult = { sha, parentSha, noop, authorId, paths: [{ path, op, blobSha, size }] }
restore(tx, teamId, actor, path, sha, coAuthors?)   // a new commit that puts path back as it was at sha
blob(tx, teamId, path, ref, maxBytes?)  tree(tx, teamId, path, ref)
```

1. **Who.** `actor` must be the actor of `tx`; the author line is `<name> <actor id>@actors.manythreads.invalid`, so a commit maps back to an actor. Co-authors become `Co-authored-by`
   trailers (never the author, never twice; names cannot forge a trailer).
2. **Order.** A queue per team in the process, then `pg_advisory_xact_lock(hash('repo-git:' || team))` in the caller's transaction. The lock lasts until that transaction ends, so a
   writer on another replica (or the next one in this process) waits until the previous writer's index rows are committed, then reads the head it left.
3. **Commit.** Through a temporary index: `hash-object -w`, `update-index --index-info`, `write-tree`, `commit-tree`, then `update-ref <new> <old>`: a compare-and-swap, so a lost race
   changes nothing. A write that leaves the tree as it was is a no-op: no commit, no event (200, `noop: true`).
4. **Conflicts.** A change with `baseBlobSha` is checked against the blob in the tree now. If any change conflicts the whole write is refused, **nothing is written**, and the answer is
   **409 `conflict`** with each path's current blob and text (`reason`: `changed`, `exists` for `baseBlobSha: null`, `missing`, `folder`, `parent_is_file`). Files and folders of one name conflict
   instead of corrupting the tree. `append` reads the current file inside the lock, so two appends never lose one.
5. **Index and event.** In the same transaction: `repos.head_sha`, `repo_entries` (path, blob, size, last commit, `text_plain` for UTF-8 text up to 1 MB), `repo_commits` (author, co-authors,
   message, paths) through the definer function `app.repo_index_apply`, and the event `repo.repo.committed` (ids, subject, changed paths; never content).
6. **Catch-up.** If the transaction rolls back after git committed (or the index is new, or the directory was lost and recreated), git is ahead of `repos.head_sha`; the next write
   indexes the missing commits (authors are read back from the author line) and rebuilds `repo_entries` before it commits. No event is emitted for a commit indexed this way.

## Writer rules (PLAN P4-05)

| Who | May write |
|---|---|
| a team member (lead, member) | any path except the four guarded ones |
| a team lead or workspace admin | also `bots/`, `TEAM.md`, `skills/`, `routines/` (the UI proposal that commits; the pull request flow arrives in phase 7) |
| any other member | the four guarded paths get **403** "Change by pull request: ..." |
| a bot | only through the kernel broker: `ctx.capabilities.authorize(tx, 'files.write' \| 'files.delete', { path })`. The broker's path guard denies `bots/`, `TEAM.md`, `skills/`, `routines/` (case-folded, percent-decoded, traversal-proof) and logs each denial as `kernel.capability.denied`; the bot also needs a `files.write` grant. `files.delete` is declared destructive: never grantable. This plugin has no copy of the guard: the paths live once in `isGuardedRepoPath` (`@manythreads/shared`), which the broker uses |
| a guest, a person outside the team, an anonymous caller | never (403, 403, 401); an archived team takes no write (409) |

Content: **text only**. A NUL byte in the first 8 KB, or more than 1 MB (1,048,576 bytes is allowed), is **422 `attachment_not_in_repo`**; nothing is committed, and a good file in
the same request is not written either. Upload such bytes as a channel attachment. (Through HTTP the JSON body limit is the practical ceiling for text.)

Paths (strict, NFC-normalised, never "fixed"): relative; no `..`, `.` or empty segment; no backslash or control character; no segment `.git` (any case) or `.gitmodules`; no segment that
ends in a dot or a space; at most 1,024 bytes (255 per segment). Refused with 400 `validation_failed`. A file and a folder of one name in one request are refused too.

## The git layer (`src/git`)

The `git` CLI, nothing else, through one runner: argv arrays (never a shell string), an environment built from scratch (no inherited `GIT_*`, `HOME=/nonexistent`, no system or global config),
`-c core.hooksPath=/dev/null -c protocol.allow=never`, a timeout and an output cap on every call (`output_too_large`, or a truncated diff on request), each process in its own group so a
timeout kills its helpers, and at most `MANYTHREADS_GIT_WORKERS` (default 8) processes at once. `MANYTHREADS_GIT_BIN` names the executable. Operations: `initBare` (no templates, so no
hooks), `tree`, `blob` (size checked before it is read), `log` (path filter, cursor), `diff`, `show`, `commit`, `restoreChange`, plus listing helpers. Refs are `main`, `HEAD` or a commit sha;
nothing else reaches git.

## HTTP (minimal; the Files tree, history and restore routes come with P4-06 and P4-08)

| Route | |
|---|---|
| `GET /api/teams/:slug/repo/tree?path=&ref=` | folders first, then files, with size and sha. Anyone who can read the team; another team's tree is 403; an admin gets 404 for a missing slug |
| `GET /api/teams/:slug/repo/blob?path=&ref=` | `{ content, encoding: 'utf8' \| 'base64', blobSha, size, commitSha }`; 413 over 1 MB |
| `POST /api/teams/:slug/repo/commit` | `{ changes: RepoChange[], message }`, strict; `content` is text or `encoding: 'base64'`. 201 `CommitRepoResponse`, 200 for a no-op, 409 `RepoConflictResponse`, 422, 403, 400. 120 per minute |

Refusals are returned as the error envelope without rolling the request back, so a repository the request had to create (its first commit is already in git) keeps its index rows.

## Tables (`migrations/0001_repo.sql`, PLAN A.4)

`repos(team_id PK, path, head_sha, remote, ...)`, `repo_entries((team_id, path) PK, kind, blob_sha, size, last_commit_sha, text_plain)` with GIN trigram on `path` and on `text_plain`, `repo_commits((team_id, sha) PK,
parent_sha, author_id, co_authors uuid[], message, committed_at, paths text[], seq)` with `(team_id, committed_at DESC, seq DESC)`, BRIN on `committed_at` and GIN on `paths`. RLS **T**: readable by whoever
`app.readable_team_ids('read')` holds the team for (one array probe per statement; the trigram indexes serve a member's query under the policy), written by the system role only. The writing side is three
narrow definer functions (`app.repo_register`, `app.repo_seed`, `app.repo_index_apply`) that accept the system or a team member who may post; they check the caller with `app.lookup_can_team`,
because inside them `app.is_system()` is TRUE.

## Tests

`test/git.test.ts` (real git in temp dirs: CAS, hooks and environment ignored, timeouts, caps, pool, paths), `test/repo-api.test.ts` and `test/repo-service.test.ts` (layout, authorship, 20 concurrent writes,
two replicas, conflicts, binary, bot guard through the real broker, catch-up after a rolled-back write, restore), `test/rls`, `test/events`, `test/provider.test.ts`; `e2e/api/repo/{concurrency,bot-path-guard}.spec.ts`.
