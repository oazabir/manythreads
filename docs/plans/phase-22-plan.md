# Phase 22 plan: the plan card, the Planner bot and the self-build run

How Phase 22 (PLAN.md §Phase 22, rows P22-01..P22-05) gets built, in packages small enough for one coder each, and how the live run that proves
it is set up. Written 2026-11-10 from the code at `2b4d1ee9` and read-only checks of the live cluster. Words used below:

- **goal**: a row of `app.goals` (tasks plugin): a line of work that several board cards point at.
- **card**: a row of `app.tasks`, a board card. **handoff**: passing a card to another bot or person (`tasks.handoff`).
- **surface**: a screen a bot draws in OpenUI Lang (a small text language for screens, phase 9), stored in `app.surfaces` and shown by a message
  that carries `meta.surfaceRef`.
- **bound part**: a part of a surface whose values are read from a read tool **as the person looking** (data binding, P9-06).
- **plan card**: one surface message in the channel that shows a goal's steps. **working thread**: the thread under the message that gave the goal.
- **run**: one wake-up of a bot (`app.bot_runs`). **runner**: where a bot's run executes (host Hermes gateway, the team's Hermes pod, a Claude pod).

---

## A. What exists today (read from the code)

**A1. Goals.** `app.goals` (`packages/plugins/tasks/migrations/0001_tasks.sql:17`) has `id` (uuid), `team_id`, `title`, `description`,
`status` (`open|done|dropped`), `created_by`, times. There is **no short number** (nothing like `G-27`), **no budget, no spend, no channel or
thread, no stored steps**. Shared type `Goal` in `packages/shared/src/entities/task.ts:52`; mapper `toGoal` in `packages/plugins/tasks/src/rows.ts:91`.
Goals are reachable only by HTTP (`GET/POST /api/teams/:slug/goals`, `PATCH …/goals/:goalId`, `packages/shared/src/api/tasks/goals.ts`) by a team
writer. **No bot tool creates or reads a goal.** A card points at a goal by `tasks.goal_id`; `tasks.create` accepts `goalId` and checks it is a goal
of the bot's team (`capabilities.ts:80`).

**A2. Cards and the three tools** (`packages/plugins/tasks/src/capabilities.ts`).
- `tasks.create`: only a bot of a team; goes through the same door as the route (`insertCard`); with no `boardId` the card lands on the Bot Board of
  the run's channel when it exists; then `app.tasks_link_run_thread` ties the card to the run's thread, so a completion wakes the creator there.
- `tasks.handoff`: target by slug or actor id; allowed only if the slug is in the caller's `handover.mayTag` (`mayHandoffToActor`, `handoff.ts:10`)
  **or the target created the card** (a hand-back is always allowed). Writes the handoff row, emits `tasks.task.handed_off` and
  `tasks.task.updated`, posts the handoff message in the card's thread (`postHandoffCard`), optional sealed `privateNote`.
- `tasks.complete`: `app.tasks_complete`; a `code` card needs a tested sha; emits `tasks.task.completed` + `tasks.task.updated`; drops private notes.
- A card carries `state` (`open|in_progress|verify|waiting_on_person|done`), `rework_count`, `handoff_count`, `blocker_reason`, `thread_root_id`,
  `pullRequest`. `tasks.task.updated` (`emit.ts:5`) carries task id, state, from-state, owner, **not the goal id**.
- `app.bot_runs.task_id` exists (runs woken by a card); `app.llm_spend` (`gateway-llm/migrations/0002_limits.sql:61`) has `run_id`, `team_id`,
  `cost_usd`, and is **readable by workspace admins only**.

**A3. Engineer today** (`templates/engineering/bots/engineer/BOT.md`). Engineer writes the plan itself, creates one `Plan review: <goal>` card and
hands it to Plan reviewer (up to three rounds), then creates work cards and keeps **one checklist message** in the thread by `messages.update`. One
work card travels the chain by handoffs: Coder → Code reviewer → Tester → back to Engineer → Committer → (merge by a person) → Deployer → Web smoke
tester. Engineer has no `surface.*` grant. `handover.mayTag` = plan-reviewer, coder, code-reviewer, tester, committer, deployer, web-smoke-tester,
brain, alert-triage; `toPerson` = `role:on-call`. TEAM.md `dispatch.handover.mayTag` repeats the chain.

**A4. `surface.render` / `surface.update`** (`packages/plugins/surfaces/src/tools.ts`). The model never names a place: `app.surface_run_context()`
(`surfaces/migrations/0002_surface_tools.sql:13`) gives the run's `channel_id` and `reply_root_id` (the thread it answers in), and the message is
posted with `threadRootId: run.reply_root_id` (`tools.ts:111`). That is why a surface always lands **in the run's own thread**. The right to write
is checked by `app.channel_actor_can_post(app.actor(), channel)` (`channels/migrations/0008_actor_can_post.sql`): the channel must be readable by
the caller and in `app.visible_channel_ids('post')` evaluated for the bot. `surface.update` may change only a surface of the same bot.

**A5. How a surface is drawn.** `MessageRow.tsx:427` sends any message with `meta.surfaceRef` to `SurfaceMessage`
(`clients/web/src/surfaces/SurfaceMessage.tsx`), which reads the surface as the viewer and re-reads it on the WebSocket push `surfaces.changed`
(`notify.ts` `pushChanged`, sent to `app.channel_audience`). So the **message kind already exists and is drawn**; what is missing is a part that
looks like a plan card. Parts are registered in `packages/shared/src/surfaces/components.ts` (`SURFACE_REGISTRY`, a `platformOnly` flag exists for
parts only the platform may write, used by `Answer`) and drawn by `clients/web/src/surfaces/views.tsx`. There are no links, images or dots in any part.

**A6. Data binding and refresh.** Allowlist `SURFACE_BINDABLE_TOOLS` (`packages/shared/src/surfaces/bind.ts:71`): `tasks.read` (args only
`taskId`), `messages.search`, `files.search`. The page asks `POST /api/channels/:c/surfaces/:s/data/:node {version}` (`surfaces/src/data.ts`); the
gateway runs the tool as the viewer in a read-only transaction (`gateway-mcp/src/viewer.ts` `readForViewer`, which needs the tool in the shared
list **and** as a `read` in `gateway-mcp/src/catalog.ts`). **Refresh is not event driven**: a bound part reads when it appears, every
`refreshSeconds` (10 to 3600), after the viewer's own press (`refreshOn: ["answered"]`) and when the surface gets a new version
(`clients/web/src/surfaces/bound.ts`, `BoundPart.tsx`). A task change sends nothing to a surface. At most 4 values per binding (`into` 1..4).

**A7. Events reach plugins fast.** `ctx.events.subscribe(type, handler)` is fed by the outbox (the queue of events written in the same transaction
as the change): LISTEN plus a 5 s poll (`packages/kernel/src/outbox/index.ts:27`), so a subscriber sees a card change within about 5 s.

---

## B. Work packages

Design choice that shapes everything (decision D1 in §D): **a plan step is not a card**. The goal stores its steps (title + the bots of the step);
the step states are worked out from the cards of the goal and their handoff history. One work card keeps travelling the chain as today, so no chain
bot gains a duty; Engineer adds a second card only where the order needs one (the publish step, see WP5). This is what makes "any bot's
`tasks.complete` or `tasks.handoff` moves the card with no extra step" true.

Step state rule (one pure function, `goalSteps` in `packages/shared/src/tasks/goal-steps.ts`, unit tested with a table of handoff histories):
steps are in order; each names bot slugs and optionally a `cardRef` (`plan`, `work`, `publish`; default `work`). For a step's card, walk its
handoffs in order and keep a pointer `p` = the furthest step whose bots held the card. Steps before `p` are `done`; step `p` is `running`
(`waiting` if the card is `waiting_on_person`, `blocked` if `blocker_reason` is set, `done` if the card is done or the card went back to a bot of
no later step after a step bot held it); later steps are `todo` (grey). `rework N` = handoffs into the step's bots from a bot of a later step. Goal
chip: `stopped` (goal dropped) › `done` (goal done, or every step done) › `waiting for a person` (a step waiting) › `running` (a step running or done)
› `planned`.

### WP1 — Goal fields and goal tools (tasks plugin) · P22-03 · Sonnet, Opus review of the SQL

Files: `packages/plugins/tasks/migrations/0016_goal_plan.sql`, `packages/shared/src/entities/task.ts`, `packages/shared/src/api/tasks/goals.ts`,
`packages/plugins/tasks/src/rows.ts` (mapper), `packages/plugins/tasks/src/goals.ts` (new), `capabilities.ts` (register), `routes.ts` (GET goal
returns the new fields), `packages/shared/src/events/` + `registry.ts` (`tasks.goal.updated`), `packages/plugins/gateway-mcp/src/catalog.ts`
(three entries), `packages/shared/src/tasks/goal-steps.ts` (pure function above).
- Migration (schema triple: Zod + SQL + mapper in one diff): `goals.number int` (per team, assigned by a `BEFORE INSERT` trigger from a per-team
  counter row locked `FOR UPDATE`; unique `(team_id, number)`), `budget_usd numeric(12,2) NULL`, `channel_id uuid NULL` and
  `thread_root_id uuid NULL` (FK `app.messages`, indexed), `steps jsonb NOT NULL DEFAULT '[]'` (CHECK `jsonb_array_length <= 12`), unique partial
  index `(team_id, thread_root_id) WHERE thread_root_id IS NOT NULL`. Backfill numbers for existing goals by `created_at`. RLS unchanged (team read).
- `goals.ensure {title, description?, budgetUsd?}` (write): only a bot of a team inside a run; channel and thread come from the run
  (`app.tasks_run_channel()` and the run's reply root, never from the model); get-or-create on `(team, thread_root_id)` through
  `ctx.db.getOneOrCreate`, so a restarted run gets the same goal. Answers `{goalId, ref: "G-27", created}`.
- `goals.plan {goalId, steps:[{title (≤120), bots:[slug] (1..3), cardRef?, done (≤300)}]}` (write): replaces the steps; refused unless each slug is a
  bot of the team; emits `tasks.goal.updated` (ids and counts only). Engineer (adding a missed step) and Planner may call it.
- `tasks.goal {goalId}` (read, bindable): as the caller, answers
  `{plan: {ref, title, chip, spend: {usd, budgetUsd} | null, steps: [{title, bots: [display names], status, dot}], stepNow, stepCount,
  board: {teamSlug, boardId} | null, thread: {replies, lastName, lastAt, faces: [display names ≤3]} | null}}`. Bots by display name, never slug.
  `board` is null when the caller cannot read that board (RLS). Thread numbers read from the thread row as the caller (null when unreadable).
  Spend: a new SECURITY DEFINER function `app.tasks_goal_spend(goal uuid)` that answers the sum of `llm_spend.cost_usd` over runs whose `task_id`
  is a card of the goal or whose `reply_root_id` is the goal's thread, only when `app.lookup_team_role` says the caller reads the team (Opus checks
  the cross-plugin table read; when gateway-llm is absent answer null).
- Tests: `packages/plugins/tasks/test/goals.test.ts` (ensure is idempotent across two runs; numbers per team; plan refuses a foreign slug, 13
  steps), `test/rls/goals-plan.test.ts` (an outsider reads nothing; a channel reader who is not a team member gets `forbidden`), and
  `packages/shared/test/goal-steps.test.ts` (chain, rework 1, waiting for merge, blocked, card back to Engineer, done). `pnpm test:rls`,
  `pnpm test:events`, `pnpm test:schema-compat`.

### WP2 — Bindable goal read and data refresh (shared + gateway-mcp + client) · P22-03 · Sonnet, Opus review

Files: `packages/shared/src/surfaces/bind.ts` (add `tasks.goal`, args `z.strictObject({goalId: z.uuid()})`), `packages/plugins/gateway-mcp/src/viewer.ts`
(nothing new beyond the catalog entry; add a test), `packages/shared/src/api/surfaces/index.ts` (`SurfaceChangedPush` gains optional
`reason: 'data'`), `clients/web/src/surfaces/SurfaceMessage.tsx`, `BoundPart.tsx`, `bound.ts`.
- On a push with `reason: 'data'` for its surface, `SurfaceMessage` bumps a `dataTick` in `SurfaceDataContext`; `useBoundState` calls
  `controller.refresh()` when the tick changes (same pattern as `answered`). The read-in-flight and failure-pause rules stay.
- Tests: `clients/web/test/surfaces/bound-data-tick.test.ts` (fake clock: one push → one read; a burst of five pushes while a read is in flight →
  two reads), `packages/plugins/gateway-mcp/test/viewer-goal.test.ts` (a person reads `tasks.goal`; a bot transaction is refused).
- Can start in parallel with WP1 (it only needs the catalog name and the args schema, agreed above).

### WP3 — Plan card on the channel (surfaces plugin) · P22-03 · Sonnet, **Opus review required**

Files: `packages/shared/src/surfaces/tools.ts` (`SurfaceRenderInput`), `packages/plugins/surfaces/src/tools.ts`, `src/plan-card.ts` (new),
`src/index.ts` (subscribe), `migrations/0003_plan_card.sql`, `packages/shared/src/surfaces/components.ts` (part `GoalCard`), the surfaces
`package.json` manifest (`dependsOn` gains `tasks`), `gateway-mcp/src/catalog.ts` (render description).
- `surface.render` takes either `{title, source}` (as today, still into the run's thread) or `{goalId, target: "channel"}`. With `goalId` the
  **server writes the screen**: `root = GoalCard("<goalId>", "<ref> · <title>", {tool: "tasks.goal", args: {goalId: "…"}, into: {plan: "plan"}})`,
  so Engineer writes no OpenUI. `GoalCard` is `platformOnly` (a bot's own text with it is refused, as for `Answer`).
- Where it goes: `run.channel_id` with `threadRootId: null` (the parent channel; for a goal given inside a thread that thread's channel is the same
  `channel_id`). Checks in order: inside a run; the goal is of the bot's team and its `channel_id` is the run's channel (else `not_found`);
  `app.channel_actor_can_post(app.actor(), channel)` (else `forbidden`, nothing written); the channel is a team channel, not a DM or bot
  conversation (else `no_place`).
- One card per goal: `app.surfaces` gains `goal_id uuid NULL` and `message_id uuid NULL`, unique partial index on `goal_id`; insert with
  `getOneOrCreate`. A second call answers the existing `surfaceId` with `created: false` and posts nothing. Test: two calls, a restarted run,
  and two runs racing → one surface, one message.
- Text for old clients: the message body is `Goal G-27 · running · step 2 of 6` (built from the same `goalSteps` answer, plain words, no slug).
- Follow the board: `plan-card.ts` subscribes to `tasks.task.updated`, `tasks.task.handed_off`, `tasks.task.completed`, `tasks.goal.updated`. In a
  system transaction: the card's `goal_id` → the plan surface of that goal → push `surfaces.changed {…, reason: 'data'}` to `app.channel_audience`
  and rewrite the message body when the short line changed (edit as the bot actor through `MessageProvider.edit`; the edit wakes nobody). Opus
  decides whether the edit runs as the bot through `ctx.db.as` or needs a narrow system edit door.
- Engineer's grant: `surface.render` is added to Engineer's BOT.md in WP5; the catalog text says "pass goalId and target channel to post the plan card".
- Tests: `packages/plugins/surfaces/test/plan-card.test.ts` (target channel, refusal when the bot cannot post, one card per goal, a task change
  pushes within one outbox pass, body line follows), `test/rls/plan-card.test.ts`.

### WP4 — The GoalCard drawn in the message list (web client) · P22-03 · Sonnet

Files: `clients/web/src/surfaces/views.tsx` (or a new `goalCardView.tsx`), `clients/web/src/styles/surfaces.css` (classes `sf-goal*` only, tokens
only), `clients/web/src/surfaces/host.ts` (lend `teamSlug` for the board link), `MessageRow.tsx` (no change expected; confirm the plan card message
gets no thread-reply affordance that confuses: the card shows the working thread's replies, not its own).
- Look (mockup `docs/spec/mockups-all.html` section `bots`, grep `G-27`): bordered card; bold `G-27 · <name>`, a state chip, `$1.61 / $12.00` on the
  right (spend alone when no budget; nothing when null); one row per step with a dot (green done, amber running or rework, grey todo, red blocked),
  the step words with the bots, status right in mono (`done`, `rework 1`, `waiting`, `blocked`); footer chip `Board card G-27` that links
  `/t/<teamSlug>/boards?board=<id>` only when `board` is not null (the link is built by the page from ids, never from bot text); under the card
  `7 replies · Tester, 2m ago` with up to three faces (initials from the names), opening the working thread.
- Before data arrives: the written placeholder (`Loading data…`), and for a reader who may not read the goal: the message body line only.
- One column at 390 px (no side-by-side spend; rows wrap); dark mode by tokens; ProIcons only; copy lint clean.
- Tests: `clients/web/test/surfaces/goal-card.test.tsx` (each status, no link when `board` null, 390 px class), W baselines
  `channel/plan-card-running`, `channel/plan-card-done`, `channel/plan-card-waiting` (light, dark, 1440, 390) via `pnpm vt:update`.
- Needs only the `tasks.goal` answer shape (fixed in WP1), so it runs in parallel with WP1–WP3 against a fixture.

### WP5 — Planner bot and the Engineer change (templates) · P22-01 + P22-02 · Sonnet, Opus reads the BOT.md text

Files: `templates/engineering/bots/planner/BOT.md` + `evals/planner.yaml` (new), `templates/engineering/bots/engineer/BOT.md` + `evals/engineer.yaml`,
`templates/engineering/bots/deployer/BOT.md`, `web-smoke-tester/BOT.md` (one paragraph each), `templates/engineering/TEAM.md` (dispatch
`mayTag` and the working agreement), `templates/engineering/template.yaml` (bots list), `tools/devbox/sync-engineering-bots.mjs` (`CHAIN` gains
`planner`), tests that list template bots: `packages/kernel/test/templates.test.ts:35,78`, `packages/plugins/bots/test/templates.test.ts:261,443,508`,
`packages/plugins/teams/test/teams-api.test.ts:47`.
- **Planner** (kind agent, runtime hermes, triggers `task_assigned`, `mention`): native `tasks.read`, `tasks.claim`, `tasks.describe`,
  `tasks.handoff`, `goals.plan`, `messages.post`, `messages.search`, `files.search`, `knowledge.search`, `memory.recall`; runtime `shell`, `files`,
  `git` (to read the repository; it writes nothing); `handover.mayTag: [engineer]`. It reads the goal and the repo, writes the plan on the plan card
  (`tasks.describe`: goal in one sentence, at most 12 steps, each with its bot, what done looks like, depends on), sets the steps with `goals.plan`,
  and hands the card back to Engineer. It only plans steps for bots in Engineer's `mayTag`; a goal that touches `clients/web` ends with
  deployer then web-smoke-tester; it asks no question the repo answers.
- **Engineer**: first act on a goal is `goals.ensure` → `boards.ensure` → `tasks.create "Plan: <goal>"` (with `goalId`) → handoff to `planner`.
  When Planner hands it back, hand the same card to Plan reviewer as today (rounds unchanged). When Plan reviewer completes it: post the plan card
  once (`surface.render {goalId, target: "channel"}`), create the work card (`goalId`), hand it to Coder. The thread checklist message is dropped:
  the plan card replaces it (Engineer still posts short news in the thread). The order follows the plan: when the work card comes back to
  Engineer after Tester, hand it to the bot of the next step in the plan (for the self-build run: Deployer). When the work card is done and the plan
  has a publish step, create a `Publish: <goal>` card naming the tested commit and hand it to Committer (its branch rule already covers a card whose
  branch does not exist yet). Engineer adds a missed step with `goals.plan` and says so in the thread. Grants added: `goals.ensure`, `goals.plan`,
  `surface.render`, `tasks.read` stays; `mayTag` gains `planner`.
- **Deployer / Web smoke tester**: "complete the card only when you are the plan's last step on that card; otherwise hand it to the next step's bot
  or back to Engineer". (Today Deployer completes, then hands to the smoke tester.)
- Evals (static mode can only judge required calls, `docs/plugins/bots.md#evals-p7-08`; the word rules need `model` mode):
  `planner.yaml` ≥ 8 cases, min 0.9: requires `goals.plan` and `tasks.handoff`; forbids `tasks.create`, `files.write`, `tasks.deploy`,
  `tasks.complete`; a web goal ends with deploy + browser check; never a step for `brain` or another team's bot. `engineer.yaml` gains: first call is
  `goals.ensure` then a handoff to `planner`; requires `surface.render` after approval; forbids `messages.update` of a checklist and a second
  `surface.render` for the same goal.

### WP6 — Seed v22, specs, docs (P22-05) · Sonnet · after WP1–WP5

Files: `packages/test-utils/src/seed-selfbuild.ts` (opt-in `MANYTHREADS_STACK_SEED=selfbuild`: Engineering team with the chain incl. planner, a
mapped project on `fake-github.ts`, a goal with steps and cards in three states), `e2e/surfaces/plan-card.spec.ts` (tasks change through the API →
card follows within 10 s; one card only; hidden from a non-member; no board link for a channel reader who cannot read the board),
`e2e/bots/planner-evals.spec.ts`, `docs/plugins/tasks.md` (goal fields and tools), `docs/plugins/surfaces.md` (channel target, GoalCard, `reason:
'data'`, update the binding list), `docs/plugins/bots.md` (Planner), `docs/retro/phase-22.md` (written after the live run: time, spend, every
manual step).

### WP7 — Self-build harness (P22-04) · Sonnet · after WP6

Files: `tools/self-build/run.sh` (preflight checks of §C7 step 1, then posts the goal as a person through the API and polls), `e2e/self-build/
self-build.spec.ts` (stack mode with stand-in models and fake GitHub; live mode reads `SELF_BUILD_BASE`, never the live namespace for deploys),
screenshot names in §C7.

### Order and parallel work

| Wave | Packages (different files, safe in parallel) | Gate |
|---|---|---|
| 1 | WP1 (tasks plugin, shared task entity, catalog goal entries) · WP4 (web view against a fixture) · WP5 text of `planner/BOT.md` only | WP1 migration reviewed by Opus before merge |
| 2 | WP2 (bind list, push schema, client refresh) · WP3 (surfaces plugin) — both edit `gateway-mcp/src/catalog.ts`: WP3 owns it in this wave, WP2 only adds its test | Opus review of WP3 (permissions, uniqueness, message edit) |
| 3 | WP5 rest (engineer, deployer, smoke tester, TEAM.md, tests listing bots, sync script) | evals pass `pnpm test:evals -- --bot=planner` and `--bot=engineer` |
| 4 | WP6, then WP7 | `pnpm lint`, `pnpm typecheck`, touched tests; deploy live; `e2e/surfaces/plan-card.spec.ts` green |

Shared file owners, so two coders never touch one file: `packages/shared/src/entities/task.ts` and `events/registry.ts` → WP1;
`packages/shared/src/surfaces/*` → WP3 (WP2 gets `bind.ts` only); `catalog.ts` → WP1 in wave 1, WP3 in wave 2. Opus reviews: WP1 SQL (counter, definer
spend function, RLS), WP3 whole, the final Engineer/Planner text, and the order change in D3.

---

## C. The live self-build run (P22-04)

### C1. test.manythreads.kahf.to today and why curl fails
- DNS: `test.manythreads.kahf.to` → CNAME `ubuntu.kahf.to` → `<devbox-address>`, DNS-only (good for the HTTP-01 challenge, the check Let's Encrypt makes
  over plain HTTP). The live name is behind Cloudflare; the test name is not.
- Namespace `test-manythreads` is a ready **deploy target** (made by the chart: ServiceAccount and Role `deployer`, Secret `deployer-token`, six
  NetworkPolicies, quota, admission rule `manythreads-deploy-target-guard`), but **nothing is installed**: no Ingress, Issuer or Certificate.
- So Traefik has no route for that host and answers TLS with its default certificate, which belongs to the live release (`CN=manythreads.kahf.to`).
  The name does not match → curl exit 60. Over HTTP it answers 404. **Nothing is broken; the Deployer's `helm upgrade --install` with
  `deploy/preview/values-preview.yaml` creates the namespaced Issuer and Certificate (`tls.mode=letsencrypt`, `wildcard=false`,
  `defaultStore=false`) and cert-manager gets a real certificate in a minute or two.** The same path worked on 2026-10-28 (before the cluster wipe).
- Set up once / check before: port 80 open from the internet (it is: Traefik answered 404); the registry pod is Running (one is, two old ones are
  `ContainerStatusUnknown`, harmless); `/etc/rancher/k3s/registries.yaml` has the `registry.local:5000` mirror (it does). For trial installs use
  `--set tls.letsencrypt.server=staging`; do not `helm uninstall` between runs (each fresh install asks Let's Encrypt again; 5 duplicate
  certificates a week).

### C2. How the Deployer builds and installs the second copy
`deploy/preview/README.md` (P10-11, used by ENG-01 on 2026-10-28, commit `fe701f8d`): `git format-patch` of the tested commits into a ConfigMap;
`deploy/preview/build-job.yaml` fetches the base commit **from GitHub** and checks the tree matches, then kaniko (builds images in a pod, no Docker,
no root on the host) builds server and web into the in-cluster registry; `helm upgrade --install manythreads` with the chart and
`values-preview.yaml` **of `origin/main`**. The copy has **its own database**: the chart's CNPG `Cluster` (CloudNativePG, the operator that runs our
Postgres) inside `test-manythreads`, with Secrets from `deploy/preview/secrets.sh`, plus mailpit and the demo seed (omar, nadia, … `@kahf.example`).
Consequences: the base commit must already be on GitHub `main` (push the Phase 22 work before the run), and a build needs up to 10 GiB of node disk
and 4 GiB memory. **The node is at 78% disk (22 GB free); MISTAKES says free to about 60% before a build or the kubelet evicts live pods.**

### C3. How Web smoke tester signs in on the copy
Deployer sets a disposable password for a demo person in the copy (`kubectl --context test-manythreads exec -i deploy/manythreads-server -- pnpm
--filter @manythreads/server admin set-password omar@kahf.example`, password on stdin) and passes it **only** in the handover's `privateNote`
(sealed). Web smoke tester reads it with `tasks.private_note`, writes a Playwright test in its home, signs in through the real form at
`https://test.manythreads.kahf.to/`, runs headless Chromium (installed in the workbench image), saves `~/shots/<card>-*.png`, posts results.

### C4. How Committer pushes to GitHub
`deploy/images/workbench/mt-publish.sh`, run as `sudo -u repo` inside the **Hermes pod's workbench**: the token sits in `/run/mt-push/<project>`
(0400, owner `repo`, synced from the lead's saved token on the Projects page); the bot never sees it (GIT_ASKPASS, masked output). It pushes only
the branch `card-<first 8 of card id>`, never `main`, never forced, opens a pull request, and `tasks.pull_request` records it; the platform polls
GitHub and completes the card when a person merges (`tasks/src/github.ts`). A Claude pod uses the same script through its publisher container
(`deploy/images/claude-pod/mt-publish-client.sh`, P19-09). **The design supports a pull request from `card-xxxxxxxx` merged by a person, not a push
to main and not a `self-build/<goal>` branch name.** Recommendation: keep that. The human merges the PR on GitHub (fast-forward or merge), then on
the devbox `git pull` and `tools/devbox/deploy.sh`. What must be true: project `manythreads` mapped in Engineering (repo
`https://github.com/oazabir/manythreads`, branch `main`, channel `#dev`) — **live has no project today** (`GET /api/teams/engineering/projects` → empty);
a fine-grained GitHub token (contents + pull requests, that one repo) saved by a lead on the Projects page; the bots on a runner with the publisher
(Hermes pod or Claude pod).

### C5. Runner the Engineering bots use today
Live Engineering bots are all `placement.gateway.connection: host`, profiles `mt-engineering-<bot>` in `/root/.hermes/profiles` (mode A, the Hermes
gateway on the host, running as **root**, cwd `/srv/hostdev`). On that runner: no `repo` user, no `/workspace/repos`, no `mt-publish.sh` → **Committer
cannot publish**; the deployer profile sets no `KUBECONFIG`, and root's kubectl is the cluster admin → **a host Deployer would have cluster-wide rights**,
which breaks the "one namespace only" rule. The team's managed pod exists but is stopped (`deployment/hermes-engineering` 0/0;
`hermes-engineering-deployer` Secret holds `deployer.kubeconfig` and `deployer.host.kubeconfig`). `claudePod.enabled` is false on live (owner-blocked).
What must change: run 1 — move the chain to the pod: `TEMPLATE_PLACEMENT=1 node tools/devbox/sync-engineering-bots.mjs engineering` (as an admin),
which also adds `planner`; the controller then scales the pod. Run 2 "Claude Code runner" — either turn on `claudePod` and add a `claude_cli` runner
(owner's yes, a second Claude login, `docs/plugins/claude-pods.md`) or use the host bridge, which has no publisher and would need the owner to copy
`deployer.host.kubeconfig` into the profile and set `KUBECONFIG`. Only the Claude pod gives the full chain.

### C6. Candidate features (web only, no migration, browser-checkable)
1. **Jump to latest in the side thread** (gap of P21-05, PLAN row: "Thread panel has no Jump to latest"): `clients/web/src/channels/ThreadPanel.tsx`
   already tracks "stuck to bottom" (`stuck` ref, line ~198); add the channel's button (`ChannelView.tsx:366`, class `jump`). ~40 lines + a unit test.
2. **Thread panel on the phone keeps its place** (P21-26 gap "the phone loses t…"): needs a design call; riskier.
3. **Channel details "Created by"** (P21-06 gap): needs the server's `createdBy`, so not web-only. Rejected.
4. **Copy link in the thread header** (ThreadCard has it; the panel head has Follow and Open channel only): tiny, but weak as a proof.

**Recommended: 1.** Visible, real, small, no server or data change, easy to prove in a browser, cannot hurt live. Goal text to post in `#dev`:

> @engineer Goal: in a thread opened on the side, a person who has scrolled up sees a "Jump to latest" button, the same look and words as the one
> in the channel, and pressing it scrolls to the newest reply; the button hides again at the bottom. Web client only
> (`clients/web/src/channels/ThreadPanel.tsx`), no server change, no migration. Ship it with a unit test. Done when lint, typecheck and the web
> tests pass, it is deployed to https://test.manythreads.kahf.to and a browser check there opens a thread with at least 30 replies, scrolls up,
> sees the button, presses it and lands on the last reply. Then open a pull request for a person to merge. Budget $15.

### C7. The run, step by step
Person posting: **nadia** (`NADIA_EMAIL` / `NADIA_PASSWORD` in `~/manythreads.passwords.env`, member of Engineering; signs in, checked 2026-11-10).
The admin steps need **omar**, whose password in that file is **stale** (sign-in 401 today): reset it with `admin set-password` as before (owner
allowed this) and update the file. Never print either.
1. Preflight (`tools/self-build/run.sh --check`): Phase 22 deployed live and pushed to GitHub `main`; disk ≤ 65%; `hermes-engineering` can start
   (memory: pod ~1.5 GiB + workbench + a 4 GiB kaniko build + the copy ~4 GiB on a 15 GB node with live running); the LLM gateway has a
   provider (the 2026-10-31 reinstall did not restore the provider key: check the admin Models page); project mapped and GitHub token saved
   (Projects page, Pull requests box shows "ready").
2. As omar: `TEMPLATE_PLACEMENT=1 DEMO_EMAIL=… DEMO_PASSWORD=… node tools/devbox/sync-engineering-bots.mjs engineering` (adds planner, moves
   the chain to the pod); wait until the bots page shows every chain bot "Ready" on the team pod.
3. As nadia: post the goal in `#dev` (top level). Watch the working thread.
4. Expected chain: Engineer `goals.ensure` → Plan card → Planner → Engineer → Plan reviewer (≤3 rounds) → **plan card appears in `#dev`** →
   Coder → Code reviewer (one rework allowed) → Tester → Engineer → Deployer (build 10–25 min, install, cert, `/healthz`) → Web smoke tester →
   Engineer → `Publish:` card → Committer → pull request → card `waiting for a person`.
5. Human: review and merge the PR on GitHub; the card completes, the plan card shows `done`. Then on the devbox: `git pull`, free disk, 
   `tools/devbox/deploy.sh`, open https://manythreads.kahf.to as nadia, open a long thread, check the button.
6. Screenshots (1440 and 390, `docs/retro/phase-22/`): `01-goal-posted`, `02-plan-card-initial` (Plan done, rest grey, chip `running`),
   `03-card-after-code` (Code done), `04-card-rework` (if one happens), `05-card-after-test`, `06-card-after-deploy`, `07-test-site-feature`
   (from the smoke tester's shots), `08-card-waiting-merge` (chip `waiting for a person`), `09-pr-on-github`, `10-card-done`,
   `11-live-feature` (after the human deploy), plus the working thread at the end. Each card shot is taken after the dot changed with no
   message from Engineer (proves acceptance 3).

---

## D. Risks and decisions for the lead (most important first)

1. **Runner (blocks the run).** Today's host runner cannot publish and would give the Deployer cluster-admin. Decide: run 1 on the Hermes pod
   (recommended, proven 2026-10-28); run 2 on the Claude pod needs the owner's yes (`claudePod.enabled`, second Claude login). Without it the
   "twice" in P22-04 cannot be met.
2. **D1 — a step is not a card.** Recommended above (steps stored on the goal, states from handoffs). PLAN P22-01 says Planner "creates the todo
   list as board cards through `tasks.create`"; doing that makes Planner the creator, so every completion would wake Planner instead of Engineer
   and every chain bot would need new hand-on rules. If the lead keeps the PLAN wording, WP5 doubles. PLAN.md text needs a dated note either way.
3. **D3 — order: deploy and browser check before the pull request** (the owner's order) vs. today's chain (pull request → merge → deploy). The
   owner's order works because the preview build uses patches, not GitHub; it needs the Deployer/smoke-tester "do not complete unless last step"
   change and the separate `Publish:` card. Recommended: the owner's order.
4. **Disk and memory on the one node.** 78% used; a build plus the copy can evict live pods (6.5 minutes of 502 on 2026-11-09). Free to ~60% first,
   watch `df`, one build at a time, tear down old build Jobs.
5. **Missing live setup after the 2026-10-31 wipe:** no project, no GitHub token, LLM provider key not confirmed, Hermes pod stopped, omar's password
   stale. Each is a manual owner/lead step; list them in the retro.
6. **Spend on the card.** Only runs through the LLM gateway leave spend lines; a Claude subscription runner shows $0. Budget is display only (no stop).
   The spend function reads an admin-only table through a definer function; Opus must check it cannot be used to read spend outside the goal.
7. **Board link and thread faces inside a surface** add the first link and the first "derived from another message" values in a part; the link is
   built by the page from ids and shown only when the viewer may read the board. Opus reviews.
8. **Message body edit by a subscriber** (old-client text) runs without a run; if acting as the bot is unwelcome, keep the body as posted and accept
   a stale fallback line.
9. **Team copies go stale**: template changes reach Engineering only through the sync script; Delivery and other teams keep the old chain.
10. **Static evals judge only required calls**; the plan-shape rules need a `model` run (costs tokens). Decide whether `minScore 0.9` is measured
    static or model.
11. **Let's Encrypt limits** if the copy is reinstalled often; use staging for trials.
12. **Guard blocks** (one key-like string ends a run, ENG-01): long kaniko and test logs; the BOT.md redaction rules stay.

Open questions: currency on the card (`$`, the ledger is USD; the mockup shows `£`); whether goal status is set to `done` by Engineer (`goals.plan`
does not do it; a tiny `goals.close` tool) or only derived; whether the plan card should also be pinned in `#dev`.
