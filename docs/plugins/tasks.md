# tasks

The task substrate and its board API (PLAN P6-01 … P6-05; SPEC §8, §7.6). A card belongs to a team; its owner claims it, works on it, and
completes or hands it on. Every rule that can be broken by two people at once is a SQL door in `migrations/0001_tasks.sql`, owned by the
system role, and both the HTTP route and the `tasks.*` tool call the same door — a drag on the board and a bot's tool call cannot disagree.

## Tables

| table | what it holds |
|---|---|
| `goals` | a team's goals; a card may point at one |
| `tasks` | the cards: `state` (`open`/`in_progress`/`verify`/`waiting_on_person`/`done`), `kind` (`code`/`docs`/`review`/`other`), `priority`, owner, branch, `base_sha`, `tested_sha`, `blocker_reason`, `rework_count`, `handoff_count` |
| `task_claims` | one row per claim; `released_at` null means live. A partial unique index on `(task_id) WHERE released_at IS NULL` is what makes one card have one owner |
| `task_events` | the card's history, one row per change (`created`, `claimed`, `released`, `completed`, `reworked`, `handed_off`, `moved`); BRIN on `created_at` |
| `handoffs` | who sent a card to whom, with the note; `approval_id` and `applied_at` for a `dispatch: strict` handover that waits |
| `environments` | deploy targets: `protected` / `needs_approval` (a deploy waits for a person other than the requester), `windows`, `deploy_cap`, `auto_rollback`, `credential_ref` |
| `deploys` | one row per deploy, and the approval it waited on |
| `boards` | a named view of the five columns; a team has one default board |
| `runners` | a team's runner processes: `name`, `capabilities`, `status`, `last_seen_at` |

Every table carries `team_id` and a hoisted read policy (`team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`); a route is
scoped by team slug, so an id from another team is a 404, never a cross-team leak.

## The rules

- **One live claim per card.** `POST …/claim` inserts a claim and sets the owner in one transaction; the loser's insert hits the partial
  unique index and answers 409 `already_owned` with nothing changed. A claim expires (the `tasks.claim-timeout` job runs
  `app.tasks_expire_claims()` every minute), so a bot that dies mid-task does not hold a card forever.
- **Freshness (P6-04).** A `code` card cannot reach `done` without `tested_sha`. A complete that names a `branchHeadSha` different from the
  card's `base_sha` is refused `stale_base` and the reason is written on the card. `rework` and `handoff` are bounded (`rework_count`,
  `handoff_count`); past the bound a person has to look at the card.
- **Handover is atomic (P6-03).** `app.tasks_handoff` locks the card, releases the old claim, sets the new owner and state, writes the
  handoff row and the `handed_off` event in one transaction. A bot may only hand to the targets its `tasks.handoff` grant's
  `constraints.mayTag` names — compiled by the bots loader from `BOT.md` `handover.mayTag`; the check is `mayHandoffToActor`, used by the
  route and the tool alike, so a tool call cannot reach a target the board refuses. A target is a bot slug, `person:<person id>` or a role
  name.
- **Strict handovers wait.** `POST …/handoff` with `strict: true` files the handoff (`app.tasks_handoff_pending`, the card does not move),
  asks the approvals plugin for a `dispatch` approval, and answers 202 with `pendingApproval: true`. Approving it runs
  `app.tasks_apply_handoff` exactly once (the handoff row's `applied_at` is the latch); denying it leaves the card with its owner.
- **Protected deploys wait.** `app.tasks_deploy_request` checks the environment's windows and daily cap first, then — for a `protected` or
  `needs_approval` environment — files an `environment` approval and records a `deploy_requests` row. Approving it runs
  `app.tasks_apply_deploy` exactly once; the requester can never approve their own deploy (the approvals plugin's own rule).
- **Board moves.** `POST …/boards/:boardId/move` calls `app.tasks_board_move`, which applies the same state-transition table as `PATCH
  /tasks/:id`; a move that the card's rules refuse answers 409 with the reason, never a silent state.

## Routes (`/api/teams/:slug`)

| method | path | who |
|---|---|---|
| GET | `/tasks?state=&kind=&priority=&goalId=&ownerId=&limit=` | any team reader |
| POST | `/tasks` | team writer (lead or member with `write`) |
| GET | `/tasks/:taskId`, `/tasks/:taskId/events` | any team reader |
| PATCH | `/tasks/:taskId` | team writer |
| POST | `/tasks/:taskId/claim`, `/release`, `/complete`, `/rework`, `/handoff` | the owner (a lead may hand over or rework anyone's card) |
| GET/POST | `/goals`, PATCH `/goals/:goalId` | reader / writer |
| GET/POST | `/environments`, PATCH `/environments/:environmentId` | reader / **lead** (manage) |
| POST | `/environments/:environmentId/deploy` | team writer; protected environments ask a person |
| GET/POST | `/boards`, GET `/boards/:boardId`, POST `/boards/:boardId/move` | reader / writer |
| GET/POST | `/runners`, PATCH `/runners/:runnerId` | reader / manager |

Claim, handoff and deploy are rate limited (120, 120 and 30 per minute per actor). Every route validates its body and its response with the
shared schemas under `packages/shared/src/api/tasks/`.

## The `tasks.*` tools (P6-02)

The plugin declares `tasks.read`, `tasks.claim`, `tasks.complete`, `tasks.handoff` and `tasks.deploy` (`src/capabilities.ts`). They call the
same SQL doors as the routes; the MCP gateway only describes them (`docs/plugins/gateway-mcp.md`), so a granted bot gets real tools, and a
bot without the grant is never offered them. `tasks.handoff` on a bot enforces `mayTag` itself — the board's rule is not an HTTP-only rule.

## Not built yet

`packages/runner` (P6-06's runner binary and its outbound connection) and the shared-repo half of P6-05 (bare mirror, per-bot worktrees,
branch-scoped push tokens, smart-HTTP) are not part of this plugin. The `runners` table and its routes exist so the screen and the
`tasks.claim-timeout` sweep have something to read; a runner process that registers itself is still to come.
