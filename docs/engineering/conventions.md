# Conventions and guardrails

The binding rules every change follows: how data, events, plugins and screens are written, what is forbidden, what the owner decided, and how text is written. Lint and the test suites enforce many of them; the rest are checked in review.

## Conventions (binding)
- **D1 Shared Zod:** every entity, API request/response, event payload and BOT.md frontmatter is a Zod
  schema in `packages/shared` (PLAN.md Appendix B naming rules). No `*Dto`/`*Model`/`*ViewModel` names
  (lint-banned). No `node:` imports, classes or functions-with-side-effects in `shared`. Client-sent
  schemas `.strict()`. Ids are branded. Dates are ISO strings on the wire.
- **One mapper per table** (`.../db/mappers/<table>.ts`) turns a row into the shared type. Nothing else.
- **One DB entry:** `withActor(actor, fn)` (sets `SET LOCAL app.actor_id/app.workspace_id/app.run_id`).
  No bare `pool.query` outside `packages/kernel/src/db/` (lint-enforced). System work uses `withSystem`, which
  connects as the real `manythreads_system` role (`app.is_system()` = `current_user`); never trust a GUC for privilege.
  Three DB roles: `manythreads_owner` (migrations), `manythreads_app` (requests), `manythreads_system` (system/workers).
  Non-system code that must touch system tables calls a narrow SECURITY DEFINER function (e.g. `app.enqueue_job`).
  Inside such definer functions `app.is_system()`/`is_workspace_admin()` are TRUE — check the caller with
  `app.lookup_workspace_role()` / `app.lookup_team_role()` instead.
- **One event registry:** `emit` validates against `packages/shared/src/events/registry.ts`, writes
  `events` + `outbox` in the same transaction. Event types are `domain.noun.verb`.
- **Schema task = triple:** Zod schema + SQL migration with RLS + mapper, in one diff.
- **SQL (D3):** `uuid` PK `DEFAULT uuidv7()`, `timestamptz`, `text` never varchar, enums as text+CHECK,
  every FK indexed, partial indexes for hot filters, BRIN on append-only time columns, UNLOGGED for
  ephemeral (leases, presence, typing). Every team/person-scoped table: `ENABLE` + `FORCE ROW LEVEL
  SECURITY` + a policy. Global tables must be in `global_tables` allowlist with a migration comment.
  Migrations: plain SQL, numbered, forward-only, never edit an applied file. Get-or-create via
  `INSERT … ON CONFLICT … DO SELECT RETURNING` through the one helper.
- Audit rows are content-blind and built only by the `audit` plugin from the event log (docs/plugins/audit.md): a new audited event type is a `MAPPERS` entry there, never message text, file content or a secret in `reason`/`label`.
- Rate limits in process memory (sliding window), per replica. Never in the DB.
- **Credential and session routes (D5):** every route that grants, recovers or changes a credential or a session has an explicit, low limit listed in
  `docs/deploy/rate-limits.md` and in `ABUSE_ROUTES` (`packages/shared/src/common/abuse-limits.ts`) in the change that adds the route. The route reads its number
  with `abuseLimit(method, path)`, sets `rateLimitBy: 'address'` when nobody is signed in (a session cookie must not buy a second counter), and, where a secret is
  guessed, adds a temporary lockout with `createLockout` / `guardRedemption` from `@manythreads/sdk` (never a lock without an expiry). The client address is
  `req.ip`, which trusts `X-Forwarded-For` only for `MANYTHREADS_TRUST_PROXY` hops (or `MANYTHREADS_CLIENT_IP_HEADER`); never read the header yourself, and key a lock on `addressKey(req.ip)` (IPv6 counts by /64). `packages/server/test/abuse.test.ts` bursts every listed route to a 429 with `retry-after`.
- **Visibility sets (RLS performance):** policies never call per-row functions for reads; hoist a uuid[] once per
  statement: `team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`, channels via
  `app.visible_channel_ids('read'|'post')`. The RLS harness fails on per-row policy calls (`findPerRowPolicyCalls`).
- Plugin SDK services (use them, don't re-implement): `ctx.db.getOneOrCreate`, `ctx.audit.emit`, `ctx.templates`,
  `ctx.readState`, `ctx.links`, `ctx.realtime.pushToPerson`, `ctx.jobs.register/enqueue` (extension `job.register`),
  `ctx.providers.get('storage')`, `ctx.providers.get<RepoProvider>('repo')` (team repo: write/restore/blob/tree/list — the only git writer),
  `ctx.access.readableTeamIds/readableChannelIds`, `ctx.realtime.pushToPeople/pushMany` (one statement per fan-out),
  `ctx.capabilities.authorize`, `ctx.capabilities.preview` (the broker's decision with no audit row and no effect; for "what would happen" questions; needs the manifest door `capability.call`), `ctx.runs.logDecision` (one content-blind decision line of the run), `ctx.jobs.register({ cron })`. A route that must never write says so with `readOnly: true`: the server opens its transaction `BEGIN READ ONLY`, so a write fails with 25006; the SDK statement filter refuses `SET`, `set_config` and statements that end or restart the transaction (`COMMIT`, `END`, `ABORT`, `BEGIN`, a plain `ROLLBACK`), and it is a stopgap, not a sandbox. Plugins can't import each other: reuse another plugin's behaviour via its HTTP route
  shape or an SDK service, never by copying.
- Server-side text processing must be linear-time (no nested regex quantifiers); add hostile-input timing tests.
- Plugins import only `@manythreads/sdk` and `@manythreads/shared`, never kernel internals. Plugin HTTP routes mount at
  their declared absolute path (e.g. `/api/channels/:id/messages`); duplicates fail at load.
- Test-only HTTP actor: header-based dev actor only with `NODE_ENV=test`, never `system`. Sessions (cookie + CSRF header) are the real
  auth; local e2e may use `POST /api/test/session` (only with `MANYTHREADS_TEST_AUTH_TOKEN`, refused in production). Live
  screenshots (`screenshots.yml`, runs after each release, commits to branch `screenshots`) set a per-run password via
  the admin CLI `pnpm --filter @manythreads/server admin set-password <email>` (stdin) and sign in through the real form.
- Capability names `namespace.verb` with a destructive tag. The broker denies bot actors writes to
  `bots/`, `TEAM.md`, `skills/`, `routines/` (and `files.*` writes to `memory/`, `inbox/`: bots write memory only via
  `memory.write`); `person:*` only for `conversation`/`mention` triggers.
- Team repo is text only (no attachments in git); guarded paths come from `isGuardedRepoPath` (@manythreads/shared) — never re-list them.
  `channels/` is reserved in the repo for the attachment folders of the Files tree, and so is `inbox/` (each team's memory
  inbox, spec §12.2). `memory/` is an OKF v0.2 bundle (spec §12.1, plan D6): every file has a `type`; the writer refuses the rest. Git runs argv-only with `GIT_LITERAL_PATHSPECS=1`.
- Embedded apps: `sandbox="allow-scripts"` (never `allow-same-origin`), CSP set by the route handler itself; server hooks key on
  `req.routeOptions.url`, never the raw URL (percent-encoding bypass, see MISTAKES).
- CSS: screen stylesheets prefix their classes (e.g. `f*` for Files); never redefine a shared class (`.linkish`, `.btn`) in a screen file.
- Fonts are self-hosted (`clients/web/public/fonts`); never load Google Fonts at runtime (breaks visual baselines).
- Design tokens only from `tokens.css` and the generated `styles/themes/*.css` (raw hex anywhere else fails lint). Fonts are the palette's faces, self-hosted: `--sans`, `--font-display` (titles only) and `--mono` (code only); a screen names a token, never a face. A theme (palette) is the `data-palette` attribute beside `data-theme` (light or dark); its values live in `tools/design/themes.mjs` and `node tools/design/build-themes.mjs` writes the stylesheets (a test fails when they differ). Text on a filled colour reads an `--on-*` token, a focus ring reads `--focus`, a field border reads `--control-border`.
- Icons are ProIcons (`@proicons/react`, MIT), never hand-drawn SVG or a text glyph (×, ✓, ←, ★). Import the name from `clients/web/src/shell/icons.tsx` (or `meetings/icons.tsx` for the call bar); to add one, wrap it there with `proIcon()` (`components/proicon.tsx` sets colour, stroke and `aria-hidden`). Emoji people pick or type (statuses, reactions) stay emoji.
- Screens carry `data-testid="app-frame"`; dynamic regions `data-vt-mask`; landmarks `data-landmark`.
- Commit messages start with the task id, e.g. `P1-03: migration runner`.

## Full access for Claude Code and Codex (where it is allowed)
"Full access" means the agent runs commands and edits files without asking (Codex: `--dangerously-bypass-approvals-and-sandbox`; Claude Code: `--dangerously-skip-permissions`, `bypassPermissions`, without `--restricted`). **Owner, 2026-11-20: on by default for Claude Code and Codex; an admin can switch it off per runner** (P35-01, `docs/plans/full-access-default.md`). It is allowed in exactly two places, and nowhere else (no Hermes, no host bridge):
- **An agent pod:** on by default; an admin can switch it off. Many teams may share the runner: each team has a pod of its own (P26-21), and full access applies to that team's pod only. The pod itself is the sandbox (it reaches the site and port 443, no other address in the cluster).
- **An enrolled server:** it needs **two keys**: the machine's own config allows it (the installer allows it by default from P35-01, `--no-full-access` refuses; the site can never widen a machine's sandbox)
  and the runner's `full_access` switch is on (on by default from P35-01, an admin can switch it off). A server without team users (`teamUsers`) never gets full access. The site sends `manythreads.fullAccess` only for a runner whose switch is on; the bridge honours it only when its config says `allowed`.
- **No one-team rule for pods:** a team's pod holds only that team's files, key, push token and deploy login, so a runner with full access may serve any number of teams. The deploy login and a full-access agent are per team (pod or, on a server, Unix user), never shared. The teams of a runner share its one sign-in folder (accepted, and said on the Runners page). On a server the same holds because every team's runs are a Unix user of their own (`mt-team-<team>`, started by the root helper through a sudo rule that allows two commands; P26-22, `docs/agent-bridge.md`): a full-access Codex there reads its own team's files, its own Codex home `<root>/work/<team>/.codex` (its sessions, and for the run a copy of the server's one Codex sign-in that the root helper copies in and a renewal of which it copies back, P31-01) and Claude's shared sign-in folder (with every team's Claude transcripts), never another team's home or Codex home, the server's main Codex copy (the bridge user's, 0700), the bridge's key or its state. Every team still holds a working copy of the one sign-in, so a full-access team could use or leak the account (owner 2026-11-20: accepted for now; one sign-in per team on a shared server is P35-10). A server installed before P26-22 runs every bot as one user and must not be given full access to many teams.
- Never give the host bridge on the devbox full access: it runs as root with the host's secrets.
- Claude Code with full access runs without `--restricted` (the CLI refuses a bypass with it) and is never given `IS_SANDBOX`: a root adapter that does not offer `bypassPermissions` fails the run (the mode check in `acp/session.ts` is the guard).
- A change to existing runners' `full_access` is an audited data step (`packages/plugins/bot-runners/src/data-steps.ts`, the system actor through `emit()`), never SQL in a migration.
Code: `packages/plugins/bot-runners/src/resolve.ts` and `routes.ts` (the site's half), `tools/agent-bridge/src/full-access.ts`, `acp/adapter.ts` and `config.ts` (the bridge's half). Plan: `docs/plans/agents-anywhere.md` section 4, `docs/plans/full-access-default.md`.

## Forbidden (spec §20 non-goals)
Voice and video are no longer forbidden: the owner lifted that non-goal on 2026-10-24 (PLAN.md D7 — on-device transcription first, phases 14–18;
amended 2026-10-27: a note-taker bot may listen to a call and transcribe on the server, but a bot never speaks in a call).
Bots run on Hermes (a customer's own gateway, or the team's managed Hermes pod) or, by owner request, on the Claude Code / Codex CLI
through `tools/agent-bridge`; every bot calls the one MCP address `https://<host>/mcp`. The bridge drives an agent either through its own
command line (`driver: cli`, Claude Code and Codex) or through the Agent Client Protocol (`driver: acp`): Claude Code, Codex, Hermes
(`hermes acp`) and, by owner decision of 2026-11-14, **OpenCode** (`opencode acp`). OpenCode is allowed as a bridge profile only: it is
**refused at run time** ("OpenCode cannot run yet") until it has been measured the way the other three were (`docs/spikes/acp-measured.md`:
how its tools are held to the bot's grants, its sign-in, its steps); it is then enabled in the bridge, never in a bot's definition. An ACP
adapter is installed by the operator at a pinned version and never fetched by the bridge. No other agent runtime.
Pipeline designer; bot "mode" field; any agent runtime beyond the above; Kubernetes CRDs of our own;
attachments committed to git; a bot choosing its own memory bank; run-time loading of third-party JS
client plugins; E2E encryption; plugin marketplace with payments; browser extension.

## Sidebar contract (every client, every team)
Summaries (2) · Chat (5) · Files (10) · Boards (20) · Org chart (23) · Jobs (26) · Threads (30) · Approvals (35) · channel groups (40) ·
Direct messages (45) · Bots (50) (`clients/web/src/shell/nav.ts`). The Bots header opens the team's bot roster at `/t/<team>/bots`; a row opens the bot's page
(`/t/:team/bots/:botSlug`, the fourteen SPEC §7.2 tabs). The roster and page read the bots plugin's
`GET …/bots[/:botSlug]`; the definition is `bots/<slug>/BOT.md` in the team repo (read via `repo/blob`, saved as a
proposal (`POST …/proposals` with `baseBlobSha`; P7-01, docs/plugins/proposals.md) — the team's lead and a workspace admin may "Propose and apply" an existing bot in one step (a non-lead member is offered the file instead of Save and proposes from Files); only an admin adds or removes a bot. Nobody commits `bots/`, `TEAM.md`, `skills/` or `routines/` directly: the repo writer refuses it with 403, and a bot can only propose.

## Owner decisions (durable)
- Approved: the orchestrator merges its own phase PRs into `main` without asking.
- `bots/` (BOT.md): a team lead edits a bot that already exists; only a workspace admin adds or removes one (SPEC §3
  set by owner request). In the Files screen `bots/` stays admin-only for everyone — a bot is edited on its Bots page.
  `TEAM.md`, `skills/` and `routines/` stay lead-or-admin.
- PROPOSED, for the owner to confirm or reverse (P7-02): the `workshop` plugin (the Add a bot helper) runs its own small tool loop
  (`packages/plugins/workshop/src/loop.ts`), a third agent loop beside the `model` runtime and Hermes. Why: both of those serve a
  bot's run and need a bot, a runner and a run; while a bot is being set up none exists, and a throwaway bot would put an actor
  in the roster nobody approved. Only about 30 lines overlap with the model runtime, so no code is shared. If the owner prefers
  one loop, the alternative is a platform-owned setup bot with its own runner assignment.
- Mobile = web app inside Capacitor (not React Native). The RN benchmark gate is replaced by a Capacitor
  WebView check in phase 11.
- Owner asked for free-form ops workflows (any command / any SQL); the permission classifier blocks committing
  them, so they stay out of the repo until the owner adds a permission rule.

## Plain language (every reply, doc, commit and UI string)
- **Never repeat text verbatim.** Do not echo the request, the prompt, a previous message or this file back at the reader.
  Paraphrase it, or leave it out. No filler openers, no restating the plan you were handed, no "as requested above".
- **No undefined jargon.** Define every term of art in plain words the first time it appears in a reply, a doc page or a
  commit message, even when this file already uses it — one clause, at the point of use: "the outbox — the queue of events
  written in the same transaction as the change that caused them". A reader who has not read `PLAN.md` or the spec must
  still follow the sentence.
- **The project's own shorthand counts as jargon** and gets the same treatment: outbox, task substrate, run, provider,
  capability, RLS (row-level security), persona, plate, definition / `BOT.md`, guardrail, memory bank, OKF bundle. If a
  term cannot be defined in one clause, the sentence is doing too much work — split it.
- A plugin doc page opens by saying what the plugin is and what a reader needs in order to use it, not by naming its phase.
