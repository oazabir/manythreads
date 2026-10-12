# approvals

The Approvals inbox and the one handler behind it (SPEC §7.3, PLAN P5-20). Two things pause for a person and nothing else
does: a **gate** (before any model call; P5-11) and an **approval** — a call waiting for a person. This plugin owns the second.
`needsApproval` is one mechanism with four ways of being set; every way ends in the same row, the same inbox and the same
decision.

## The four sources

| `source` | Set by | Wired |
|---|---|---|
| `grant` | the per-grant flag: `approvals.needsApproval` in `BOT.md`, compiled into `capability_grants.needs_approval` | P5-20: the MCP gateway and the Hermes runtime's own scope |
| `dlp` | the DLP `require_approval` outcome (SPEC §15) — a bot whose Guard rules carry `dlp:require_approval` — **and the gate** (SPEC §7.3, P5-11; tool `llm.gate`): a guard decided that a model call waits for a person, which is what "held by the guard" means on the card | P5-20: the model call is held in `runtime-hermes`; P5-11: the gate files its hold here too |
| `environment` | an Environment with `protected: true` on every tool tagged with it | phase 6 — the handler already takes it |
| `dispatch` | `dispatch: strict` in `TEAM.md`, on `tasks.handoff` | phase 6 — the handler already takes it |

**Why the gate is `dlp` and not a fifth source.** SPEC §7.3 names four sources and the table's `CHECK` (and every client's label) is those four. The gate is the bot's own Guard
section deciding, before a model call, that it waits for a person — the same family as the DLP hold, with the same hand-back (`resume.kind = 'handoff'`), the same card ("held by the
guard") and the same approvers. It is told apart by its tool, `llm.gate` against `llm.call`, and by `args_preview.stage`. If a later phase needs the sources to be filtered by
mechanism, a fifth value is a migration of one `CHECK` and one enum map; nothing here depends on there being four.

`approvalSourceFor({ environmentProtected, dispatchStrict, dlpRequiresApproval, grantNeedsApproval })` (`@manythreads/shared`)
is the question every caller asks; a call that is several things at once is **one** approval, named by the first source in that
order. Phase 6 only has to pass what it knows; it adds no table, route or screen.

## The handler: `ctx.providers.get<ApprovalProvider>('approvals')`

Extension point `provider.approvals`, types in `@manythreads/sdk` (`src/approvals.ts`). Look it up when a request arrives, not in
`register`. Without the plugin every caller **fails closed** exactly as before P5-20 (the call is refused with `approval_required`);
running a call the grant says a person must approve is the one thing the flag exists to stop.

```ts
const { approvalId, created } = await ctx.runs.asBot(run, (tx) =>
  approvals.request(tx, {
    runId: run.runId,
    source: 'grant',
    tool: 'email.send',
    summary: approvalSummary('email.send', args),         // one line for the inbox
    argsPreview: previewArgs(args),                        // clipped; keys named token/password/key/... are '[hidden]'
    resume: { kind: 'tool', capability: 'email.send', args, trigger: 'mention' },
    dedupeKey,                                             // asking twice for the same pending thing is one approval
  }));
```

* **A run is what an approval hangs from.** The bot, the team, the workspace, the person who asked (the **requester**; the bot itself when
  nobody did) and the thread the run answers in come from the run row (`bot_runs`, bots 0009 adds `channel_id` and `reply_root_id`;
  `ctx.runs.open` takes them). The caller cannot name another bot's run: `app.approvals_request` accepts the system role or the run's own bot in the
  run's own transaction (`app.actor()` is the bot's actor and `app.run_id()` is this run), and refuses anyone else with 42501.
* **One approval per asker.** The dedupe key is scoped by bot *and requester* (`approvals_dedupe (bot_id, requester_id, dedupe_key)`): a second person asking
  for the identical call gets a request of their own and is never folded into the first — otherwise they would be handed a row whose requester is someone
  else and could approve it. The door loops (bounded) if the row it conflicted with was decided meanwhile, so it never answers a missing id.
* `requestToolApproval(ctx, run, tool, input, { approvers? })` (`@manythreads/sdk`) is the `grant` source's one call, used by `gateway-mcp` and `runtime-hermes`: preview, summary, resume and the
  one stable `approvalDedupeKey` are built in one place. It answers null without the plugin (callers fail closed).
* **Reads never wait.** A read runs as the asking person; an approved re-run would run it as the bot. `gateway-mcp` refuses a read tool flagged `needsApproval` (`forbidden`, with the reason).
  The Hermes scope already runs every call as the bot.
* **A long call.** The preview is clipped (20 keys, 10 items, 3 levels, 300 characters) and `args_truncated` says so; the card then says the preview is cut short and the Approve button stays
  disabled until the approver has opened the full call (`GET …/args`).
* The row's `tool` equals `resume.capability` for a tool call (a CHECK), so the inbox cannot show one thing and run another.
* `request` writes the row, emits `approvals.approval.requested` and pushes `approval.changed` to the team's people.
* `pendingForRun(tx, runId)`: how many approvals a run is waiting on. `runtime-hermes` ends a run that has any as `stopped`, not `done`.
* `claim(tx, approvalId, { botId, source })`: for a `handoff` (below); system transaction only; answers the payload **once**.

## What approving does

The run that asked has already ended: a model cannot wait for a person and its process is gone. So approving does not "resume the
conversation". It does the one thing that was approved, once, and records what became of it (`outcome`):

* **`resume.kind = 'tool'`** — `grant` approvals (and, in phase 6, `environment` / `dispatch`). The decide route queues the
  `approvals.resume` job in the decision's own transaction. That job only *claims* the row (`queued` → `running`, committed together with the
  `approvals.execute` job it queues — see "Once" below); `approvals.execute` opens a fresh run for the bot (same trigger, same asker while they are still on the team), asks the broker again
  (a grant removed since, or a path the guard now refuses, ends the approval `failed` with the reason), and calls the stored capability as
  the bot inside `ctx.runs.asApproved(run, capability, …)`. `asApproved` waives `needsApproval` for **exactly that capability in that
  transaction** and nothing else (`Actor.approvedCapability`, an in-memory property of the transaction's actor — not a setting SQL can
  change). `asApproved` is behind its own manifest extension, `approval.resume`, which only this plugin declares: another plugin that holds
  `tool.invoke` is refused (`kernel/test/plugins/identity-gate.test.ts`). The job never throws.
* **`resume.kind = 'handoff'`** — `dlp` approvals. Only the runtime that stopped the model call knows how to restart it, so approving
  emits `approvals.approval.decided`, and `runtime-hermes` (a consumer of that event) calls `claim`, gets its own stored payload back
  and puts the run on its queue again with the approval's id. The pre-call check then lets that **one** finding through as written
  (`dlpMode: 'approved'`) — never past a preset that refuses outright (`customer-facing`), and the egress and budget checks still apply.
* **Deny** settles it and nothing runs.

The stored call's real arguments live in `resume`, the one column `manythreads_app` is not granted; the inbox shows `args_preview`.

### Once

The call may be an email or a deploy, so "at most once" is kept by three things together, not by a transaction (a transaction rolls back
after a side effect committed elsewhere, and a retry would repeat it):

1. **Two jobs.** `approvals.resume` claims (`queued` → `running`, `started_at`) and queues `approvals.execute` in the same committed
   transaction, so the claim is durable *before* anything happens and a crash after it leaves a visible `running` row.
2. **No retry.** Both queues are `maxAttempts: 1` (a failed job is dead), and `approvals.execute` refuses to start when it is not the first
   attempt — the kernel's reaper puts a job whose worker died back on its queue whatever the queue's own limit says. The refusal settles the
   row `failed` ("interrupted; it may or may not have been made"); it never re-runs.
3. **A sweep.** `approvals.sweep` (every five minutes) turns an approved call still `queued` or `running` after `APPROVAL_RUN_TIMEOUT_MINUTES`
   (15) into `failed` with a sentence that says what is and is not known, and lets a pending approval lapse at `expires_at`
   (`APPROVAL_TTL_DAYS`, 7) as `expired`. A lapsed-but-unswept approval is already undecidable (`not_pending`). The card stops polling after the
   timeout and says the result never came back.

## Who can see it

An approval's summary, preview (including the redacted excerpt of a DLP hold), requester and channel are made of the conversation it came
from, so the policy is `team readable` **and** (`channel_id IS NULL` or the caller can read that channel — `app.visible_channel_ids`, hoisted
like the team set). An approval raised in a private channel, a DM or a bot conversation is visible to that conversation's people and nobody else
on the team, and an approver who cannot read the channel **cannot decide** (the decide rule answers `not_found`, exactly as for another team's
id). `GET /api/threads/:rootId/approvals` is the same query under that policy, so a thread the caller cannot read answers nothing.

## Who can decide

`approver_scope` is resolved when the approval is filed, from the bot's `approvals.approvers` (BOT.md; `bots.approvers`, written by the
loader) or the list the caller passes:

* `role:<tag>` — a holder of that role tag (`app.roles` / `app.role_members`, the `role:on-call` of `TEAM.md`);
* `person:<id>` — that person;
* **nothing named → the team's leads and the workspace owners and admins.**

When a tag or a person is named, the scope is exactly that: a lead who does not hold the tag does not decide. **The requester never
decides their own request**, whatever else they are (including a lead, an admin, or a holder of the named tag): `app.approvals_decide` refuses
them with 42501 and the inbox shows a sentence instead of the buttons. A guest never decides. The decider must also be able to *see* the
approval, which means being on the team (or a workspace admin).

`app.approvals_block_reasons(ids[])` answers, per approval and computed set-wise (the caller's person, tags, led teams and visibility sets are read once,
not once per row), NULL when the caller may decide, else `requester | not_approver | not_pending | not_found`; `approvals_block_reason(id)` is the same for one.
The lists call the set function once, so the screen and the rule cannot differ, and the decide door runs the same function before it writes.

## Tables (migration 0001; PLAN A.5)

`approvals` (`source`, `status` `pending|approved|denied|expired`, `outcome` `none|queued|running|ran|failed`, `tool`, `summary`, `args_preview`, `resume`,
`resume_kind`, `approver_scope`, `requester_id`, `requester_name`, `bot_id`, `run_id`, `channel_id`, `thread_root_id`, `args_truncated`, `expires_at`, `dedupe_key`) and
`approval_decisions` (one per approval, UNIQUE). Both: RLS enabled and forced, `team_id = ANY (readable_team_ids('read'))` for reads (hoisted),
**no write policy for the request role** (it reads every column but `resume` and `dedupe_key`) — the system role writes, and the two definer doors below. Names are stored on the row (actors are
readable only by themselves, so a list cannot join them).

* `app.approvals_request(run, source, tool, summary, args_preview, resume, approvers, dedupe_key)` — the filing door (above).
* `app.approvals_full_args(id)` — the stored arguments of a tool call, for the people who may decide it only (42501 otherwise).
* `app.approvals_decide(id, decision, note)` — checks, flips `pending` once (a second decider gets 55000, mapped to 409) and writes the
  decision; approving sets `outcome = 'queued'`.

## Routes

| | |
|---|---|
| `GET /api/teams/:slug/approvals?status=pending\|decided&limit=` | the inbox: items (each with `canDecide` / `blockReason`) and `waiting` |
| `GET /api/teams/:slug/approvals/summary` | `{ waiting, mine }` — the sidebar badge |
| `POST /api/teams/:slug/approvals/:id/approve` and `/deny` | body `{ note? }` → `{ approval }`; 403 for the requester or a non-approver, 409 once decided |
| `GET /api/teams/:slug/approvals/:id/args` | the whole stored call (secret-named keys still `[hidden]`), for the people who may decide it; 403 for anyone else |
| `GET /api/threads/:rootId/approvals` | the approvals raised in that thread, for the card under its replies |

Live push `approval.changed` `{ teamId, approvalId }` to the team's people when one is raised, settled or finished (a hint to refetch; the lists are
the truth, and the client also polls every two seconds while a card says `queued`).

## Events (registry, version 1)

`approvals.approval.requested`, `approvals.approval.decided`, `approvals.approval.resumed` (`outcome` `ran|failed`). Ids and the tool name
only — never the arguments.

## Web

The sidebar's Approvals entry (order 35) shows the team's pending count and opens the inbox (`/t/:team/approvals`): Waiting (oldest first) and
Decided on the left, the selected card on the right. The same card sits under a thread's replies (`thread-approvals`). Classes are prefixed
`apr-`; the layout reuses the Threads inbox's shared classes.

## Not here

* The **gate** (P5-11) — a gate-list topic stops a run before any model call and creates a pending approval through this handler; not built.
* Environment `protected` and `dispatch: strict` (phase 6) — typed, not wired.
* The conversation is not resumed: an approved tool call runs once and the card says so; the person can ask the bot again.
* A bot loaded before bots 0009 carries no `approvers` until its `BOT.md` next changes; the Hermes runtime passes the definition's own list, the MCP
  gateway reads the column, so such a bot's MCP approvals default to the team's leads.
* Escalation of a pending approval (`handover.escalation`) is not implemented; a pending one lapses after seven days (a column default, not yet a setting).
