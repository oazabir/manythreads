# tasks

The task substrate and its board API (PLAN P6-01 … P6-05; SPEC §8, §7.6). A card belongs to a team; its owner claims it, works on it, and
completes or hands it on. Every rule that can be broken by two people at once is a SQL door in `migrations/0001_tasks.sql`, owned by the
system role, and both the HTTP route and the `tasks.*` tool call the same door — a drag on the board and a bot's tool call cannot disagree.

## Tables

| table | what it holds |
|---|---|
| `tasks` | the cards: `state` (`open`/`in_progress`/`verify`/`waiting_on_person`/`done`), `kind` (`code`/`docs`/`review`/`other`), `priority`, owner, branch, `base_sha`, `tested_sha`, `blocker_reason`, `rework_count`, `handoff_count` |
| `task_claims` | one row per claim; `released_at` null means live. A partial unique index on `(task_id) WHERE released_at IS NULL` is what makes one card have one owner |
| `task_events` | the card's history, one row per change (`created`, `claimed`, `released`, `completed`, `reworked`, `handed_off`, `moved`); BRIN on `created_at` |
| `handoffs` | who sent a card to whom, with the note; `approval_id` and `applied_at` for a `dispatch: strict` handover that waits |
| `environments` | deploy targets: `protected` / `needs_approval` (a deploy waits for a person other than the requester), `windows`, `deploy_cap`, `auto_rollback`, `credential_ref` |
| `deploys` | one row per deploy, and the approval it waited on |
| `boards` | a named view; `columns` (jsonb, array order is display order) holds `{id, name, state, title}` for up to 12 columns, where two columns may count as the same state. A column stored before ids existed holds `{state, title}` and reads as id = state, name = title (never rewritten) |
| `board_card_places` | where a card sits on a board when it is not in the first column of its state (a sparse table: no row means the first column). Written only by `app.tasks_board_place`; a trigger drops a card's rows when its state changes, so a tool or bot that changes the state sends the card to the first column of the new state |
| `runners` | a team's runner processes: `name`, `capabilities`, `status`, `last_seen_at` |

Every table carries `team_id` and a hoisted read policy (`team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`); a route is
scoped by team slug, so an id from another team is a 404, never a cross-team leak.

## The rules

- **One live claim per card.** `POST …/claim` inserts a claim and sets the owner in one transaction; the loser's insert hits the partial
  unique index and answers 409 `already_owned` with nothing changed. A claim expires (the `tasks.claim-timeout` job runs
  `app.tasks_expire_claims()` every minute), so a bot that dies mid-task does not hold a card forever.
  **Claiming a card you already hold succeeds and changes nothing**: the route and the `tasks.claim` tool answer ok with the live claim's
  expiry (the tool adds `alreadyYours: true`), write no second claim row and emit no event. Only a different caller gets `already_owned`.
- **Freshness (P6-04).** A `code` card cannot reach `done` without `tested_sha`. A complete that names a `branchHeadSha` different from the
  card's `base_sha` is refused `stale_base` and the reason is written on the card. `rework` and `handoff` are bounded (`rework_count`,
  `handoff_count`); past the bound a person has to look at the card.
- **Handover is atomic (P6-03).** `app.tasks_handoff` locks the card, releases the old claim, sets the new owner and state, writes the
  handoff row and the `handed_off` event in one transaction. A bot may only hand to the targets its `tasks.handoff` grant's
  `constraints.mayTag` names — compiled by the bots loader from `BOT.md` `handover.mayTag`; the check is `mayHandoffToActor`, used by the
  route and the tool alike, so a tool call cannot reach a target the board refuses. A bot target is named by slug (`mayTag`). A person target is named by `handover.toPerson`
  (P14-03), which the loader compiles into the same grant's `constraints.toPerson`: `person:<person id>`, or `role:<tag>`, which allows any person who holds that tag **on the bot's team**. The tag is
  resolved by the teams plugin's `role.groups` provider, the same set `@on-call` notifies, so there is one definition of who holds a tag (without that provider a role names nobody). A bot that lists
  neither `mayTag` nor `toPerson` has no `tasks.handoff` grant. The refusal names `handover.toPerson` when the bot has one. Still not built: a tool that picks the on-call person for the bot (the
  bot names the person's actor id; it has no call that lists who holds a tag).
- **The card's thread and the announcement.** A handover (route or tool) posts a message written as the sender: "Orchestrator → @coder: <note>".
  It goes **where the handover was asked for**: the channel and thread a route request names (`channelId`, `threadRootId` in the body), or the
  one the calling bot run answers in (`bot_runs.channel_id/reply_root_id`, read through `app.run_id()`), as a reply in that thread. That place
  must be a channel of the card's team where the new owner may also post (checked with `app.channel_actor_can_post` of the channels plugin, which asks the channel
  visibility rule for that actor). From anywhere else — a DM, a bot's own conversation, a private channel the new owner cannot post in, a place
  the sender cannot read — the card is a short line ("Orchestrator handed “title” to @coder") in the team's first public channel and carries
  **no note**, so text from a private place is never copied into a public one. With no origin at all, the card's own thread
  (`tasks.thread_root_id`) is used, else the first public channel the sender may post in. The message becomes the card's thread root when the
  card had none (`app.tasks_record_card`, which refuses a message that is not the sender's or is outside the card's team).
  The message carries `meta.handoff` (the channels message door accepts that key only from plugin code), which every bot router reads to start
  no run from the @mention in it.
- **When the card cannot be announced or the owner cannot be woken, the history says so.** Every failure leaves the handover standing and writes a
  `not_woken` line on the card (`app.tasks_note_event`) with a reason code: `no_message_door`, `sender_cannot_post`, `no_channel`,
  `post_failed` (a fixed code; the error text is not stored) from the tasks side; `no_thread`, `channel_unavailable`, `receiver_cannot_post`, `wake_limit` from the runtime (event
  `runtime.task.not_woken`, consumed here). Plugins have no logger, so this history and that event are the log.
- **A bot sender is checked by the broker.** The `tasks.handoff` tool (and the route, when the caller is a bot) asks the capability broker for
  `messages.post` before posting; a bot without that grant still hands the card over, posts nothing and gets a `sender_cannot_post` line.
- **A strict handover** posts "would like to hand … (waiting for approval)", with the note only where a full card is allowed, when it is filed.
  When the approval applies it nothing is posted: that runs in a system transaction, there is no door that writes a message as the original
  sender or as the approver, and the system actor has no author row. The wake does not depend on that note: it needs the card's thread, which
  comes from an earlier announcement or from the filing note; a card that has none gets a `no_thread` line.
- **Waking the owner.** `tasks.task.handed_off` (and `tasks.task.completed`, for the card's creator) is what starts a bot whose `BOT.md` has
  a `task_assigned` trigger — see "Task assignments" in [runtime-hermes.md](./runtime-hermes.md). The `tasks.handoff` and `tasks.complete`
  tools emit the same events as the routes, so a handover made by a tool wakes the next bot too. The handover bound (five changes of hands)
  is the loop bound for a chain of bots.
- **Strict handovers wait.** `POST …/handoff` with `strict: true` files the handoff (`app.tasks_handoff_pending`, the card does not move),
  asks the approvals plugin for a `dispatch` approval, and answers 202 with `pendingApproval: true`. Approving it runs
  `app.tasks_apply_handoff` exactly once (the handoff row's `applied_at` is the latch); denying it leaves the card with its owner.
- **Protected deploys wait.** `app.tasks_deploy_request` checks the environment's windows and daily cap first, then — for a `protected` or
  `needs_approval` environment — files an `environment` approval and records a `deploy_requests` row. Approving it runs
  `app.tasks_apply_deploy` exactly once; the requester can never approve their own deploy (the approvals plugin's own rule).
- **Waiting on a pull request.** When the project has a GitHub token, the committer (the one bot that publishes; Engineer hands it a tested card) does not complete a card: it publishes the branch and calls
  `tasks.pull_request` with the project, the commit and the pull request number (nothing else comes from the bot). The **server** reads the project's
  token and the address it was issued for from the pod's Secret, asks GitHub for that pull request and requires it to be open, to come from the card's own
  branch (`card-<first 8 characters of the card id>`) of that very repository, to be at the commit the bot says it tested, and to be aimed at the project's main branch (kept in the Secret next to the token) of the same
  repository (not a fork); it makes the pull request's address itself. Only then does `app.tasks_record_pull_request` (tasks migration 0010) make the
  card wait: it keeps its owner, takes the head commit as its tested commit, loses its live claim (so the claim sweep cannot reopen it), goes to
  `waiting_on_person` with the blocker "Pull request #N waits for a person to merge it", and shows a link (`pull_request_*` columns; the shared
  `Task.pullRequest`). The card stores the repository address, branch and commit it was recorded with, so the tasks plugin never reads the projects table.
  The project must be the one the card is about: the project of the card's channel (its board's, else its thread's), and a card with no such link is bound to the
  project of its first pull request. While the pull request is open a **bot cannot complete the card or move it to done** (`waiting_on_merge`): the merge is the
  gate; a person can still move it by hand, which stops the following. A person merging it in GitHub is the approval. The job `tasks.pull-request-sync` (every three minutes, `src/pull-requests.ts`) asks the stored address
  about each open pull request, least recently asked first, 30 at a time, with the token from the Secret (and only if the token is still issued for
  that address). **Merged:** after re-checking branch, target branch, repository and head commit against what was recorded, `app.tasks_resolve_pull_request` marks the
  card `done` (the system, not a bot, finishes it) and writes a `completed` line with the merge commit in `data.mergeSha`. A merge of any other commit
  finishes nothing: the card goes back to its owner and says so. **Closed without a merge:** the card returns to `in_progress` under its owner (or
  `open` if it has none), with a live claim so the owner can go on, the reason on the card and a `pull_request_closed` history line. The door acts only
  while the card is still `waiting_on_person` and the pull request still the open one recorded; a card that moved on by another door (completed,
  handed over, moved on the board, released by a person) has its pull request marked `withdrawn` by a trigger in the same statement, and a later merge
  changes nothing and adds no second completion. A project whose origin fails (an outage, a rate limit, a refused token) waits longer after each failure,
  up to half an hour, or as long as GitHub's `Retry-After` says; the job logs the status code and the project name, never the token or GitHub's reply.
  The origin must start with a prefix in `hermesPods.repoOriginAllow`. A **bot** cannot release or describe a card that waits on a person (that wait is a
  person's to end); a person can still release it from the board.
- **Board moves.** `POST …/boards/:boardId/move` calls `app.tasks_board_move`, which applies the same state-transition table as `PATCH
  /tasks/:id`; a move that the card's rules refuse answers 409 with the reason, never a silent state.

## Routes (`/api/teams/:slug`)

| method | path | who |
|---|---|---|
| GET | `/tasks?state=&kind=&priority=&ownerId=&limit=` | any team reader |
| POST | `/tasks` | team writer (lead or member with `write`) |
| GET | `/tasks/:taskId`, `/tasks/:taskId/events` | any team reader |
| PATCH | `/tasks/:taskId` | team writer |
| POST | `/tasks/:taskId/tick` | a person who can post in the team (P14-19: ticks or unticks one `- [ ]` / `- [x]` box of the description) |
| POST | `/tasks/:taskId/claim`, `/release`, `/complete`, `/rework`, `/handoff` | the owner (a lead may hand over or rework anyone's card; the creator of a card nobody owns may hand it over, since a bot that splits a request creates cards and passes each on without ever holding one) |
| GET/POST | `/environments`, PATCH `/environments/:environmentId` | reader / **lead** (manage) |
| POST | `/environments/:environmentId/deploy` | team writer; protected environments ask a person |
| GET/POST | `/boards`, GET `/boards/:boardId`, POST `/boards/:boardId/move` (`{taskId, columnId}`, or the older `{taskId, to}` = first column of that state) | reader / writer |
| POST / PATCH / DELETE / PUT | `/boards/:boardId/columns`, `/columns/:columnId`, `/columns/order` | **lead or workspace admin** (add, rename, delete, reorder). Delete is refused (409) while the column holds cards, and for a board's last column; reorder must list exactly the board's current ids or it is refused (409), so two tabs never overwrite each other. Each change emits `tasks.board.updated` |
| GET | `/boards/:boardId/places` | reader: where cards sit and how many each column holds |
| GET | `/tasks/activity` | reader: which bots have a run in progress (`running`) or waiting to start (`queued`) on which cards, for the bot icon on a card (`app.tasks_card_activity`; only cards the caller can read). The plugin listens to `bots.run.opened` and `bots.run.closed` and pushes `tasks.activity.changed {teamId}` to the team's people as a hint to read again |
| GET/POST | `/runners`, PATCH `/runners/:runnerId` | reader / manager |

Claim, handoff and deploy are rate limited (120, 120 and 30 per minute per actor). Every route validates its body and its response with the
shared schemas under `packages/shared/src/api/tasks/`.

## The `tasks.*` tools (P6-02)

`tasks.read` names people so a bot can tell its own cards from another's: next to `owner_id` and `created_by` it returns `owner` and `creator`
(a bot by its slug, a person by display name, `unknown` if the actor is gone), and the caller's own entries end in `(you)`, e.g.
`owner: "reviewer (you)"`; the top-level `you` field says who is asking. Names come from `app.tasks_actor_labels` (migration 0005), which
reads only actors of the caller's workspace. A `task_assigned` run's prompt also opens with "You are <name> (@<slug>)."

The plugin declares `tasks.read`, `tasks.create`, `tasks.claim`, `tasks.complete`, `tasks.handoff`, `tasks.pull_request` and `tasks.deploy` (`src/capabilities.ts`).
`tasks.pull_request` takes `taskId`, `project`, `testedSha`, `number` and, for a card published as one commit, `publishedSha` (what `mt-publish.sh` printed as `head_sha`: the one commit it made from the tested tree). The request must then be at `publishedSha`, not at the tested commit; the door `app.tasks_record_pull_request` takes a `p_squashed` flag for it (migration 0017) and the card's commit becomes the published one. The request may be a GitHub pull request or a GitLab merge request (`gitlab.ts` reads it; the project's provider decides). It is granted to the engineering Committer.
`tasks.commit_identity` (`taskId`, `project`) tells the Committer whose name the commit carries, through the door `app.tasks_commit_identity` (migration 0017): `{ ok, commitAs: "bot" }`, or `{ ok, commitAs: "requester", authorName, authorEmail }` for a project that signs as the person who started the work (the writer of the card's thread, else the card's creator; only an active person with an email counts). Answers `no_requester` when a bot started the work, `not_owner` for anyone but the card's owner or a lead, and `wrong_project` for another project.
`tasks.release` and `tasks.describe` (`src/capabilities-turns.ts`) let a bot take a turn on a card several bots share: release gives the card back through the route's door, and describe rewrites the description of a card the caller owns while its claim is live (door `app.tasks_describe`, migration 0011; each rewrite leaves a `described` history line with lengths and a sha256, never the text). Both refuse a finished card (`already_done`), a card that waits on a person (`waiting_on_person`) and a card with a handover waiting for approval (`handoff_pending`); the release route answers those with 409 too. `tasks.read` now returns each card's description.

**Ticking a checklist box (P14-19).** `POST /tasks/:taskId/tick` with `{ nth, checked, text }` (strict; 120 a minute) changes the one character between the brackets of box number `nth` in the description (counted outside code blocks, the same rule the chat uses: `taskItemAt` / `setTaskChecked` in `@manythreads/shared`). `text` is the box's text as the person saw it: when box `nth` now says something else the route answers 409 and writes nothing, so a list a bot rewrote meanwhile never gets the wrong line ticked. The write is the door `app.tasks_tick` (migration 0014): a person only (a bot rewrites with `tasks.describe`), who can post in the card's team, on a card that is not `done`, compare-and-set on the old text (a second tick that raced the first gets 409 and reads the card again). Each tick leaves a `described` history line with `data.tick = { nth, checked }`, the lengths and a sha256, never the text; `tasks.task.updated` is emitted. A box already in the asked state writes nothing. The card panel draws the boxes as real checkboxes (a done card's are not changeable); a message's checklist stays read-only.
They call the same SQL doors as the routes — `tasks.create` and the create route share `insertCard`, so a card a tool made and a card a person
made are the same row with the same `created` history — and the MCP gateway only describes them (`docs/plugins/gateway-mcp.md`), so a granted
bot gets real tools, and a bot without the grant is never offered them. `tasks.create` writes in the calling bot's own team (a tool never names
a team); there is no assign tool, because assignment is `tasks.handoff`. `tasks.handoff` on a bot enforces `mayTag` itself — the board's rule is
not an HTTP-only rule.

## The thread to-do list: `tasks.todo` (P25-10)

A bot that works a request in a thread keeps one checklist for it. `tasks.todo` is a default capability (manifest `default: true`, like `approvals.ask`): every bot is offered it, and a call needs no grant. It is a `write` in the MCP catalogue (`gateway-mcp`), so a rehearsal holds it back.

| call | input | what it does |
|---|---|---|
| `set` | `{action:'set', title?, items:[{id, text, status, taskId?}]}` (1 to 30 items; `text` up to 200 characters; `title` up to 120; `status` is `waiting`, `working`, `done` or `blocked`; `id` is the bot's own, 1 to 40 characters) | replaces the whole list |
| `update` | `{action:'update', id, status}` | changes the status of one item, under the row lock, so two runs of the bot never lose each other's change |

Both answer `{ ok, version, counts, message }` or a plain refusal: `no_thread` (the run is not in a thread, or its channel was archived), `invalid_input` (also a list over 32000 bytes of JSON, or an item that names a card outside the thread's team), `no_list`, `no_item`, `not_owner`, `forbidden` (the bot can no longer post in the channel: this holds for `update` too), `blocked` (the workspace's data rules refuse something in the text), `unavailable` (no data-loss plugin is installed, or messages are not available). `set` also answers `redacted: n` and says so in `message` when n texts held something that looks like a secret and were replaced by a marker; the counts are of the list as kept (items that follow a card are brought to the card's state by the write).

**Who may do what.** `update` (one item's status) is open to any bot with a live run answering in the same thread, so a helper can tick what it did. `set` (the whole list) is the owner's, or another bot's when the owner has no live run in that thread any more: the list then becomes that bot's, and it posts a card of its own (the old card stays in the thread; a bot edits only its own message). While the owner still works in the thread, another bot's `set` is `not_owner`. A person cannot write the list at all. Every call of one thread takes one advisory lock (`pg_advisory_xact_lock(hashtext('todo:' || root))`), so two parallel `set` calls make one card and two versions.

**What is kept.** One row per thread in `app.thread_todos` (migration 0018, `thread_root_id` is the key and cascades with the message): the channel, the team, the bot's actor, the title, the items (jsonb, at most 30 and 40000 bytes), a `version` that goes up on every change, and the id of the thread message that shows it. Readable by whoever can read the channel (`channel_id = ANY(app.visible_channel_ids('read'))`); `manythreads_app` holds SELECT only. Every write goes through doors owned by the system role: `app.todo_run_context()` (the calling bot's live run and the thread root, read from `bot_runs.reply_root_id`; nothing is taken from arguments), `app.todo_write` and `app.todo_set_status`, with `app.todo_bot_is_live` and `app.todo_items_ok` (the door checks the shape of the items itself: only the five known keys, unique ids, texts of at most 200 characters, a status of the four, uuids for `taskId` and `ownerId`). So a bot writes only in the thread its own run answers in.

**One message.** The first `set` posts one thread message carrying `meta.todoRef` (the thread root's id) and rewrites it in place afterwards: the message body is the title (or "To-do list") and is edited only when the title changes; the progress lives in the row, not in the text. A deleted message is posted again. `meta.todoRef` is accepted only from a bot acting inside a run (a person who sends it is refused), and the door checks that the message is the bot's own, in the same thread, and carries that ref. If the door refuses after the post, the message rolls back with the transaction. That first message counts as unread like any message and mentions nobody; the later changes notify nobody.

**Items that follow cards.** An item with a `taskId` follows the card; the card must be a card of the thread's own team. `set` takes the owner and the done state from the card, and the write reads the cards again after the list exists (so a card that finished while the list was being made is not missed by the subscriber that could not see the list yet). `tasks.task.handed_off` makes the item `working` with `ownerId` set to the new owner (never undoing `done`), and `tasks.task.completed` makes it `done`. The follower locks the rows in a fixed order, bumps the version, pushes, and leaves a list alone that the change would push over the size the table allows. A delivery that comes twice, or late, changes nothing.

**Words that leave the server.** The title and all item texts go through ONE `pre_egress` call (destination `channel`, preset `standard`, for this bot and team) before they are kept, so a secret a bot pasted into an item is redacted and one audit line is written (the manifest extends `hook.pre_egress`). Without the data-loss plugin the call is refused (`unavailable`): the other plugins that need a check (the approvals preview, the terminal recorder, the MCP gateway) withhold the same way, and there is no shared pattern list to fall back on. Text is cut at its limit by UTF-16 units without splitting a character, so what is kept reads back whole.

**Read and push.** `GET /api/threads/:rootId/todo` (read only) answers `{ todo }`: `{ rootId, channelId, messageId | null, botActorId, title, items:[{id, text, status, taskId?, ownerId?}], version, updatedAt }`, or `{ todo: null }` for no list or a list in a channel the caller cannot read. After a change the plugin pushes `todo.changed` `{ channelId, rootId, version }` (no items) to the channel's audience; one list is announced at most twice a second (a change inside the gap is covered by one later push that carries the version the list has then), and a refused call pushes nothing. The web reads again when the version is newer than the one it holds (`clients/web/src/todo/`, `useThreadTodo(rootId)`). There is no separate bus event and no per-change history line. The card that draws the list is P25-11.

Tests: `test/todo.test.ts` (default offer, one message rewritten in place, invalid input, `no_item` and `no_list`, one batched redaction with the count, no data-loss plugin, round trip of Arabic, Chinese and emoji, four-byte texts at the limit, a text that grows when redacted, the byte limit, parallel sets, ownership and take-over, helpers ticking an item, a person forging `meta.todoRef`, an archived channel, a bot that can no longer post, the door's `bad_message` and shape checks, who is pushed (private conversation, guest) and no push on a refusal, the push rate, items following a handoff and a completion, several lists on one card, a late or doubled event, a reopened card, a card of another team).

## Channel boards and the Bot Board

A board may belong to one channel (`boards.channel_id`). Such a board shows the cards filed on it (`tasks.board_id`) instead of a saved filter,
and only people who can read the channel can see it (`GET /api/channels/:channelId/boards` lists a channel's boards). The tool `boards.ensure`
gets or creates the channel's board named "Bot Board" in one statement, so two runs asking at once end with one board; it needs a team channel of
the bot's own team that the bot may post in, and it is the only board a bot can create. The answer is `{ ok, created, board, path }`; `path` is the board's address in the web app,
`/t/<team slug>/boards?board=<board id>`, so a bot can link it without knowing the team's slug. `tasks.create` (tool and route) takes an optional
`boardId` of the same team; without one, a bot's card goes to the Bot Board of the channel its run answers in, when that board already exists.
A handover never changes the board. A bot may always hand a card back to the actor that created it, even when its `handover.mayTag` does not
name that actor; every other target must be in the list, and a refusal says "not handed over ... the card is still yours".

## Not built yet

The runner program and its connection are the [runners](./runners.md) plugin and `packages/runner` (P6-06); the shared-repo half of P6-05 (bare mirror, per-bot worktrees,
branch-scoped push tokens, smart-HTTP) are not part of this plugin. The `runners` table and its routes exist so the screen and the
`tasks.claim-timeout` sweep have something to read; the [runners](./runners.md) plugin is what makes a row `online` for real: a runner process connects with a token, says what it can do, and the row follows its connection.
