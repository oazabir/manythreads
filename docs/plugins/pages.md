# pages

Durable pages: reports, saved answers, routine outputs. A page is a **text file under `pages/` of the team repo** ([repo-git.md](./repo-git.md)); `pages.write` is plain file write plus commit
(SPEC section 6.4, PLAN P4-07). Concurrent live editing with Yjs replaces the writer in phase 6 (`pages.write` then writes through the same document).
Code: `packages/plugins/pages`. Schemas: `packages/shared/src/{api/pages/write-page,events/pages.page.written}`. No tables, no migrations.

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

## Event

`pages.page.written` v1 (`teamId, path, mode, sha, blobSha, size, authorId, actorKind: person | bot | system`), as the author, in the transaction of the commit, next to `repo.repo.committed` (same `sha`).
One per write that changed the page; a refused, conflicting or no-op write emits neither. (PLAN calls it `page.written`; event types are `domain.noun.verb`, so the registered name has three parts.) Never carries content.

## Tests

`test/pages.test.ts` (create/replace/append, 409 with current content, no-op, concurrent appends, linear history, the four guarded paths for people and a bot with audit, a bot with only `pages.write`, a bot with only
`files.write`, team access), `test/events/pages-events.test.ts` (`pnpm test:events`), `test/manifest.test.ts`; `e2e/api/repo/pages-write.spec.ts` (`pnpm e2e --project=api`).
