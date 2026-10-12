# approvals

The Approvals inbox and the one handler behind it (SPEC §7.3, PLAN P5-20). Two things pause for a person and nothing else
does: a **gate** (before any model call; P5-11) and an **approval** — a call waiting for a person. This plugin owns the second.
`needsApproval` is one mechanism with four ways of being set; every way ends in the same row, the same inbox and the same
decision.

## The four sources

| `source` | Set by | Wired |
|---|---|---|
| `grant` | the per-grant flag: `approvals.needsApproval` in `BOT.md`, compiled into `capability_grants.needs_approval` | P5-20: the MCP gateway and the Hermes runtime's own scope |
| `dlp` | the DLP `require_approval` outcome (SPEC §15) — a bot whose Guard rules carry `dlp:require_approval` | P5-20: the model call is held in `runtime-hermes` |
| `environment` | an Environment with `protected: true` on every tool tagged with it | phase 6 — the handler already takes it |
| `dispatch` | `dispatch: strict` in `TEAM.md`, on `tasks.handoff` | phase 6 — the handler already takes it |

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
* `request` writes the row, emits `approvals.approval.requested` and pushes `approval.changed` to the team's people.
* `pendingForRun(tx, runId)`: how many approvals a run is waiting on. `runtime-hermes` ends a run that has any as `stopped`, not `done`.
* `claim(tx, approvalId, { botId, source })`: for a `handoff` (below); system transaction only; answers the payload **once**.

## What approving does

The run that asked has already ended: a model cannot wait for a person and its process is gone. So approving does not "resume the
conversation". It does the one thing that was approved, once, and records what became of it (`outcome`):

* **`resume.kind = 'tool'`** — `grant` approvals (and, in phase 6, `environment` / `dispatch`). The decide route queues the
  `approvals.resume` job in the decision's own transaction. The job *claims* the row first (`queued` → `ran` in one statement, so a second
  delivery finds nothing), opens a fresh run for the bot (same trigger, same asker while they are still on the team), asks the broker again
  (a grant removed since, or a path the guard now refuses, ends the approval `failed` with the reason), and calls the stored capability as
  the bot inside `ctx.runs.asApproved(run, capability, …)`. `asApproved` waives `needsApproval` for **exactly that capability in that
  transaction** and nothing else (`Actor.approvedCapability`, an in-memory property of the transaction's actor — not a setting SQL can
  change). The job never throws: a model-side effect is not replayed blindly.
* **`resume.kind = 'handoff'`** — `dlp` approvals. Only the runtime that stopped the model call knows how to restart it, so approving
  emits `approvals.approval.decided`, and `runtime-hermes` (a consumer of that event) calls `claim`, gets its own stored payload back
  and puts the run on its queue again with the approval's id. The pre-call check then lets that **one** finding through as written
  (`dlpMode: 'approved'`) — never past a preset that refuses outright (`customer-facing`), and the egress and budget checks still apply.
* **Deny** settles it and nothing runs.

The stored call's real arguments live in `resume`, the one column `manythreads_app` is not granted; the inbox shows `args_preview`.

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

`app.approvals_block_reason(id)` answers NULL when the caller may decide, else `requester | not_approver | not_pending | not_found`; the
list calls it per row so the screen and the rule cannot differ, and the decide door runs the same function before it writes.

## Tables (migration 0001; PLAN A.5)

`approvals` (`source`, `status` `pending|approved|denied`, `outcome` `none|queued|ran|failed`, `tool`, `summary`, `args_preview`, `resume`,
`resume_kind`, `approver_scope`, `requester_id`, `requester_name`, `bot_id`, `run_id`, `channel_id`, `thread_root_id`, `dedupe_key`) and
`approval_decisions` (one per approval, UNIQUE). Both: RLS enabled and forced, `team_id = ANY (readable_team_ids('read'))` for reads (hoisted),
**no write policy for the request role** — the system role writes, and the two definer doors below. Names are stored on the row (actors are
readable only by themselves, so a list cannot join them).

* `app.approvals_request(run, source, tool, summary, args_preview, resume, approvers, dedupe_key)` — the filing door (above).
* `app.approvals_decide(id, decision, note)` — checks, flips `pending` once (a second decider gets 55000, mapped to 409) and writes the
  decision; approving sets `outcome = 'queued'`.

## Routes

| | |
|---|---|
| `GET /api/teams/:slug/approvals?status=pending\|decided&limit=` | the inbox: items (each with `canDecide` / `blockReason`) and `waiting` |
| `GET /api/teams/:slug/approvals/summary` | `{ waiting, mine }` — the sidebar badge |
| `POST /api/teams/:slug/approvals/:id/approve` and `/deny` | body `{ note? }` → `{ approval }`; 403 for the requester or a non-approver, 409 once decided |
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
* Expiry/escalation of a pending approval (`handover.escalation`) is not implemented.
