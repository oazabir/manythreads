# pages

Durable pages: reports, saved answers, routine outputs. A page is a **text file under `pages/` of the team repo** ([repo-git.md](./repo-git.md)); `pages.write` is plain file write plus commit
(SPEC section 6.4, PLAN P4-07). A page can also be **edited live** by several people (and a bot) at once over a Yjs document, with one co-authored commit per session (P6-09).
Code: `packages/plugins/pages`. Schemas: `packages/shared/src/{api/pages/write-page,events/pages.page.written}`. Migration `0002_live_pages.sql`.

## The capability and the route

| | |
|---|---|
| Capability | `pages.write` (not destructive: grantable to a bot). Declared in the manifest, so the broker knows the name; its path guard covers it like `files.write` |
| Route | `POST /api/teams/:slug/pages/write`, body `WritePageRequest` (strict): `{ mode: 'create' \| 'replace' \| 'append', path, content, baseBlobSha?, message? }`; 120 per minute |
| Answer | 201 `WritePageResponse` `{ path, mode, sha, parentSha, noop, authorId, blobSha, size }`; **200 `noop: true`** when the page already held exactly that (no commit, no event) |
| For the MCP gateway (phase 5) | `ctx.capabilities.register('pages.write', handler)`: input `{ team, mode, path, content, baseBlobSha?, message? }` as the bot's transaction; answers `{ ok: true, ... }` or `{ ok: false, status, code, message, conflicts? }` |

| Mode | Meaning |
|---|---|
| `create` | the page must not exist: **409** `conflict` (reason `exists`) with its current content when it does |
| `replace` | the whole page becomes `content`; created when missing. With `baseBlobSha`, **409** (`changed`, current content) if the page moved on since the caller read it; without, the last write wins |
| `append` | `content` is added to the end (the page is created when missing), read **inside the writer's lock**, so concurrent appends never lose one |

Each write is **one commit** with the caller as author (`Create page <path>`, `Replace page <path>`, `Append to page <path>`, or `message`), through `RepoProvider.write`, so the repo's own rules apply: text
only (a NUL byte or more than 1 MB is 422 `attachment_not_in_repo`; over HTTP the body limit answers 413 first), strict paths (400), one linear history, the index and `repo.repo.committed` in the same
transaction. The plugin looks the provider up per request (`ctx.providers.get('repo')`); without repo-git the route answers 503.

## Who may, and where

1. **Path.** The schema accepts any valid repo path so the server can say why it refuses one. `bots/`, `TEAM.md`, `skills/`, `routines/` are **403 for everybody**, a lead included ("Change by pull
   request ..."): `pages.write` writes pages, and a lead changes configuration through `POST /repo/commit`. Every other path outside `pages/` (and `channels/`, reserved for attachments) is **400**.
2. **A person** needs to be able to post in the team (the repo writer checks the role: a guest or a person of another team is 403, an archived team 409). Nobody signed in is 401.
3. **A bot** goes through the kernel broker twice (the route and the writer): `ctx.capabilities.authorize(tx, 'pages.write', { path })` denies the four guarded paths (case-folded, percent-decoded,
   traversal-proof) and a bot **without a `pages.write` grant**; every denial is a `kernel.capability.denied` event (`capability: 'pages.write'`, `path`), written in its own transaction. A bot that may only
   save pages (Brain's "Save as page") is granted `pages.write` alone: the writer takes `options.capability: 'pages.write'` instead of `files.write` (a delete is always `files.delete`).
   The kernel's `isFilesMutation` lists `pages.write` next to the `files.*` writes for this reason.

Refusals are returned as the error envelope without rolling the transaction back (see repo-git: a refusal never undoes work the request had to do first); the 409 body is `RepoConflictResponse`.

## Live editing (P6-09)

`GET /api/teams/:slug/pages/live?path=pages/…` upgrades to a WebSocket (a plugin socket route; the kernel's `HttpRouteDefinition.ws`). Frames are binary and speak the
standard Yjs protocol: type `0` is sync (step1/step2/update, `y-protocols/sync`) and type `1` is awareness (`y-protocols/awareness`); the server also sends one text frame,
`{ type: 'committed', path, sha, editors }`, when a session commits. Authentication and CSRF are the platform's ordinary hooks on the upgrade; only a **person on the team**
may open a page, the path must be under `pages/`, and the four guarded paths are refused. A socket has no transaction of its own: the plugin opens one with `ctx.db.as(caller, …)`
(a door added with this phase) for the read, the update ledger and the commit.

| table | what it holds |
|---|---|
| `page_docs` | the Yjs snapshot per `(team, path)`, the newest `page_updates` id it contains (`last_update_id`) and the `last_commit_sha` |
| `page_updates` | every update, append-only, `(team, path, id)` and BRIN on time: who changed which page, and the replay tail after a crash |
| `page_awareness` | live cursors (UNLOGGED, 30 s expiry, PK `(team, path, actor)`): a cursor is worth nothing after a failover and the clients send it again |

**The document's text is the markdown source.** Frontmatter is split off on load and re-attached on commit, so the live editor and the committed file hold the same bytes and rich
rendering still works on the file. Loading applies the snapshot then every update after `last_update_id`; a process that died mid-session therefore loses nothing that reached
the ledger.

**One commit per session.** When the last socket closes there is a 2 s grace for a reload, then the session commits (`MANYTHREADS_PAGE_LEAVE_MS`); with editors still present, a
commit happens after 60 s without an update (`MANYTHREADS_PAGE_IDLE_MS`). The commit's author is the first person who edited (else the first editor) and **every other editor
is a `Co-authored-by`**; the message is `Edit <path> live with N editors`. It goes through the ordinary repo writer with `baseBlobSha` from the session, so a commit made outside
the session is a 409 that leaves the room dirty instead of overwriting it. The snapshot and `last_update_id` are then written as the system actor, and `pages.page.written` is
emitted for the commit. A session that ends where it started writes nothing.

**Bots write through the same document.** `pages.write` (route and capability) first asks the live registry; with a room open the change is applied to the same `Y.Text`, broadcast
to the editors, committed at once as the bot (with the session's editors as co-authors) and returned as the ordinary `WritePageResponse`. With no room it is the plain writer
below. A `create` never goes into a live room (the page exists), and a `baseBlobSha` that does not match the session's is left to the ordinary writer to refuse.

**Limits (deliberate, for P10).** Rooms live in one process: two replicas editing one page hold two documents, and the second commit loses the `baseBlobSha` race (the room stays
dirty and retries). Awareness is per process and dies with it. Nothing is applied to the repo until the session commits, so a page is not "saved" on every keystroke.

**Screen.** `clients/web/src/viewers/markdown/live.ts` is the browser end (sync, awareness, a minimal-diff editor that turns a keystroke into one insert/delete, peers and colours)
and `LivePageEditor.tsx` draws the source, the presence chips and the remote carets; the Markdown viewer's **Live** button opens it only when the page has no unsaved edit, and
**Done** hands the committed source back to the viewer.

## Save as page

`POST /api/channels/:channelId/messages/:messageId/answer/page` `{ remove: number[], digest }` writes the masked copy of an answer of the **caller's
own conversation** as `pages/answers/<slug>-<id8>.md` of the answer's team repo, through `writePage` (so the broker, the guarded paths, the
`pages/` prefix, the commit as the person and `pages.page.written` are the ones above; a person cannot save outside their team's repo: the page is
the answer's team's, and the writer's role check applies). The page is team content, so the copy is made for the team's readers by the same rule a
share to a team-wide channel uses ([answer.md](./answer.md#sharing-an-answer-p5-17), target `page`): a source only the asker may open reads
"from Omar's message · not shared" in the file, with no label, snippet or id. The file name is `slugged first sentence + the last 8 hex of the
answer's id` (no day in it), made of `a-z`, `0-9` and `-` only (linear), so the same answer is the same file on any day: saving it again finds
the page and answers 200 `created: false` with the counts of the save that wrote it (nothing is overwritten); another answer never collides. Source
names and quotes are one line each with markdown structure escaped, so a multi-line label cannot open a heading or a link on the team's page. The text is the answer's own with the claims the sharer removed taken out.
The question the person asked is not on the page. Access event: `answer.answer.shared` with `kind: 'page'` (ids and counts, no path, no team).

## Event

`pages.page.written` v1 (`teamId, path, mode, sha, blobSha, size, authorId, actorKind: person | bot | system`), as the author, in the transaction of the commit, next to `repo.repo.committed` (same `sha`).
One per write that changed the page; a refused, conflicting or no-op write emits neither. (PLAN calls it `page.written`; event types are `domain.noun.verb`, so the registered name has three parts.) Never carries content.

## Tests

`test/pages.test.ts` (create/replace/append, 409 with current content, no-op, concurrent appends, linear history, the four guarded paths for people and a bot with audit, a bot with only `pages.write`, a bot with only
`files.write`, team access), `test/events/pages-events.test.ts` (`pnpm test:events`), `test/manifest.test.ts`, `test/live.test.ts` (two editors over the real socket: concurrent text,
awareness with cursors, one commit with both as co-authors and the page's bytes, snapshot reload, idle commit, the three refusals, the update ledger);
`clients/web/test/live-page.test.ts` (diffing, convergence, peers and carets, the socket handshake and the commit notice); `e2e/api/repo/pages-write.spec.ts` (`pnpm e2e --project=api`); Save as page:
`packages/plugins/conversations/test/share.test.ts` and `e2e/conversations/share.spec.ts`.
