# ManyThreads — implementation guide for Claude

Written for Claude, running as an orchestrating coding agent, to build ManyThreads. Not written for a person. Every instruction is actionable and checkable against `SPEC-FINAL.md` v1.4 and `mockups-all.html`.

---

## 0. How to use this guide

- **The spec is the contract.** `SPEC-FINAL.md` v1.4 is the source of truth. When this guide and the spec disagree, the spec wins — re-read the relevant spec section before proceeding.
- **The prototype is the look and the copy.** `mockups-all.html` (twelve sections, §01–§12) shows layout, wording, states and component composition. Do not read it in full — grep its headings and read only the section you need.
- **`BUILDABILITY-REVIEW.md` is the rationale.** Why v1.4 is shaped the way it is (Hindsight as default memory provider, no CRDs, React web/desktop over React Native everywhere). Read it when a spec decision looks surprising, not before every task.
- **What "done" means for any task:**
  1. It matches the relevant spec section(s) — cite the section number in the PR description.
  2. It matches the relevant prototype section for layout, copy and states, where the task touches UI.
  3. It has the tests required by §6 (recipe for a plugin) and §7 (referee rules) of this guide.
  4. A fresh Sonnet subagent has reviewed the diff against the requirements and passed it (§1 of this guide).
  5. It does not build anything on the non-goals list (§10 of this guide, drawn from spec §20).
- **Never build a non-goal.** If a task looks like it needs a pipeline designer, a second agent runtime, a bot "mode", a Kubernetes CRD, or anything else on the §20 list, stop and flag it instead of building it.

---

## 1. Operating model for Claude

This is the owner's delegation model. It is not optional and it is not a style preference — follow it for every task in this build.

| Rule | Detail |
|---|---|
| Orchestrator | Opus/Fable only plans, decides and verifies. It does not write code, run commands, or read logs itself. |
| Code >20 lines | Written by a Sonnet subagent, model set explicitly. |
| Commands, build, test, lint, logs, k8s, code search | Sent to a Haiku subagent, model set explicitly. |
| Trivial tasks | One command, one-line edit, or one small file — done directly by the orchestrator, not delegated. |
| Review | Every change is reviewed by a **fresh** Sonnet subagent given only the diff and the requirements — never the same subagent that wrote it, and never given prior conversation. |
| Definition of done | A task is not done until the reviewer subagent passes it. |
| Parallelism | Maximum 3 parallel subagents. |
| Subagent prompts | Always state goal, paths, constraints, and done criteria. |
| Subagent returns | Summary only — result, exact errors, changed paths. Never raw logs or full file contents back to the orchestrator. |
| Large output | Filter before processing; anything over roughly 150K tokens goes to a Sonnet subagent to summarise first. |
| Shell | Bash, not zsh, for every command execution. |

### 1.1 Prompt template — coder (Sonnet)

```
You are writing code for ManyThreads, a self-hosted collaboration platform (see /docs/spec/SPEC-FINAL.md).

Goal: <one sentence — what this change accomplishes>
Paths: <files/directories you may create or edit>
Constraints:
  - Follow SPEC-FINAL.md §<n> exactly. Do not invent behaviour it does not describe.
  - Match prototype mockups-all.html §<NN> for layout/copy/states, if this touches UI.
  - Do not write to: bots/, TEAM.md, skills/, routines/ from plugin code paths that a bot could reach.
  - No pipeline designer, no bot "mode" field, no second agent runtime, no Kubernetes CRDs.
  - Bash, not zsh, for any commands you run.
Done criteria:
  - <list of concrete, checkable outcomes — e.g. "POST /api/threads returns 201 with a thread id", "unit test X passes">
  - Tests added per the recipe in IMPLEMENTATION-GUIDE.md §6.
Return: a summary only — what changed, exact paths touched, any errors. Do not paste full file contents back.
```

### 1.2 Prompt template — reviewer (Sonnet, fresh)

```
You are reviewing a diff for ManyThreads. You did not write this code and have no other context.

Diff: <paste diff only>
Requirements: <paste the coder prompt's Goal, Paths and Constraints verbatim>
Spec section(s) to check against: SPEC-FINAL.md §<n>

Check:
  - Does the diff do what the goal asks, and nothing else?
  - Does it violate any constraint listed above?
  - Does it violate a referee rule in IMPLEMENTATION-GUIDE.md §7 (e.g. writable bots/, TEAM.md, skills/, routines/; a self-named memory bank; person:* outside a conversation/mention run)?
  - Are the required tests present and do they actually test the behaviour (not just exercise the code path)?
  - Any obvious security, RLS or data-leak issue?

Verdict: PASS or FAIL, with a short reason. If FAIL, list exactly what must change.
```

### 1.3 Prompt template — ops/Haiku

```
Task: <one of: run a build / run tests / run lint / fetch logs / search code / run a k8s command>
Command(s) to run: <exact command, bash>
Success looks like: <e.g. "exit code 0 and no test failures", "the string X appears in output">
Failure handling: capture exact error text, do not retry more than once, do not modify code.
Return: exit code, pass/fail, and only the relevant lines of output (filter out noise). If output exceeds ~150K tokens, summarise instead of returning it raw.
```

---

## 2. Repository layout

A pnpm TypeScript monorepo. Propose and create this tree:

```
manythreads/
  packages/
    kernel/                  identity · event log · plugin host · capability broker · transport ·
                              scoped storage · entity-link table · read-state service · right-panel back stack
    sdk/                     plugin SDK: manifest types, extension points (spec §3), capability
                              broker client, event types
    server/                  Fastify host: loads server plugins from manifest, exposes HTTP/WS
    plugins/
      channels/  direct-messages/  threads/  conversations/  files/  pages/  boards/  rhythms/
      search/  notifications/  teams/  bots/  tasks/  approvals/  memory/  knowledge/  answer/
      connections/  surfaces/  workshop/  inbox-watch/
      identity-oidc/  identity-password/
      runtime-hermes/  runtime-rules/
      memory-hindsight/  memory-git-mirror/
      storage-local/  storage-s3/  repo-git/
      slack-compat/  webhooks/
      guardrails-dlp/  guardrails-egress/  audit/  retention/
    gateway-mcp/              MCP gateway: mcp-server plugin's runtime, per-bot endpoints, capability
                              scoping, person:* resolution, credential minting
    gateway-llm/              LiteLLM config generation, alias/budget/rate-limit admin, key minting
  clients/
    web/                      React (DOM), Vite — browser
    desktop/                  Tauri 2 shell wrapping clients/web — macOS, Windows, Linux
    mobile/                   React Native — iOS, Android; reduced surface (spec §2, §4)
  deploy/
    compose/                  docker-compose.yml, five containers by default (spec §2)
    helm/                     Helm chart + DB-reading controller; no CRDs
  templates/
    <team>/                   TEAM.md + bots/*/BOT.md per team template (spec §5.3, §13)
  docs/
  CLAUDE.md
```

Each `packages/plugins/<name>` is one npm workspace package: a manifest, server-side extension-point implementations, migrations, and (where it has UI) declarative client screens/cards/panels per spec §3.

### 2.1 Root `CLAUDE.md`

Write this file verbatim at the repository root before any other work starts:

````markdown
# ManyThreads — CLAUDE.md

## Stack
- Server: Node/TypeScript, Fastify. One language for plugin SDK, client and server.
- Data: Postgres 16 + pgvector, row-level security on messages, threads, conversations,
  read state, ACL, tasks, approvals, audit.
- Event backbone: Postgres outbox + LISTEN/NOTIFY by default. NATS JetStream is an
  optional transport plugin for multi-node deployments only — do not add it to the
  default path.
- Durable waits: a Postgres-backed job queue (pg-boss) and a small state machine per
  approval/rhythm. A Temporal-class queue is an optional plugin only.
- Clients: React (DOM) for web and desktop (Tauri 2 wraps the web build). React Native
  for phones, with a deliberately reduced surface per spec §2: channels, threads,
  conversations, approvals, notifications; a WebView for the rest.
- Deployment: docker compose starts five containers by default — Postgres, LiteLLM,
  Hindsight, ManyThreads, Hermes. Every other service (NATS, a Temporal-class queue,
  S3/MinIO, OpenBao/KMS, Activepieces) is an optional plugin, not a default dependency.
  Helm + a DB-reading controller for k3s/Kubernetes. No CRDs, ever.

## Conventions
- One plugin = one package under packages/plugins/<name>, loaded from a manifest.
- Client plugins are declarative (schema-driven nav/screens/cards/panels) on every
  platform. JS client plugins are bundled at build time, web/desktop only. Never add
  run-time loading of third-party JS client plugins.
- Server plugins are in-process Node modules. Never add module federation server-side.
- The team git repo holds text configuration and durable text pages only: TEAM.md,
  bots/, skills/, routines/, knowledge/*.yaml, memory/journal/, memory/facts/, pages/.
  Attachments live in Files storage (object storage or local disk), tracked in a
  `files` table carrying folder path and channel ACL. Never commit a binary
  attachment to the team repo.
- bots/, TEAM.md, skills/, routines/ are never writable through a bot's file
  capability. Enforce this in the capability broker, not in a prompt. Changes to
  these paths arrive only as an approved proposal (self-setup, Workshop, or a PR).
- A bot never holds a credential. Only a pairing token. Everything else is minted
  per task or held by a gateway.
- Every model call goes through the LLM gateway (LiteLLM) by alias (smart, fast,
  code, local, embed, vision, image, transcribe) — never a hardcoded model name —
  except the subscription runtimes (Claude Code / Codex), which are the one
  declared exception and must be labelled "subscription · bypasses gateway guard".
- Brain's `person:*` grant on mail (Gmail/Outlook) is opt-in per person by default
  (spec §20, still open) — do not default it to on for every team member.

## Delegation rules (binding — full detail in IMPLEMENTATION-GUIDE.md §1)
Orchestrator plans/decides/verifies only; code >20 lines → Sonnet; commands/build/
test/lint/logs/k8s/search → Haiku; trivial edits done directly; every diff reviewed
by a fresh Sonnet subagent before it counts as done; max 3 parallel subagents; bash
not zsh.

## Forbidden
Do not introduce, in code, comments, docs or UI copy: a pipeline designer, a bot
"mode" field, a second agent runtime, Kubernetes CRDs for Team/Bot/Connection/
Environment, attachments committed to git, a bot choosing its own memory bank.

## Where the spec lives
/docs/spec/SPEC-FINAL.md (contract), /docs/spec/BUILDABILITY-REVIEW.md (rationale),
/docs/spec/mockups-all.html (prototype, §01–§12).

## Running tests
pnpm test · pnpm test:rls · pnpm test:events · pnpm test:memory-cross-team ·
pnpm test:runtime-rules · pnpm playwright test — see IMPLEMENTATION-GUIDE.md §8.

## Sidebar contract (every client, every team)
Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) ·
Direct messages (45) · Bots (50). The Bots header opens the team roster; a bot's
name opens its conversation view.

## Default install
docker compose up → five containers: Postgres, LiteLLM, Hindsight, ManyThreads, Hermes.
Nothing else starts by default.
````

---

## 3. Spec → code map

| Plugin (spec §2) | Package | Spec sections | Prototype | Milestone |
|---|---|---|---|---|
| channels | `plugins/channels` | §6.1 | §02 | M1 |
| direct-messages | `plugins/direct-messages` | §6.1, §3 sidebar | §02 | M1 |
| threads | `plugins/threads` | §6.1 | §02 | M1 |
| conversations | `plugins/conversations` | §6.2, §6.3 | §12 | M1 |
| files | `plugins/files` | §5.2 | §02, §11 | M1 |
| pages | `plugins/pages` | §6.4, §5.2, §18 (M2 row) | §11 | M1: plain `pages.write` (file write + commit); M2: Yjs concurrent editing |
| boards | `plugins/boards` | §6.5 | §02, §11 | M1 |
| rhythms | `plugins/rhythms` | §6.5 | §11 | M2 |
| search | `plugins/search` | §12 (search) | — | M1 |
| notifications | `plugins/notifications` | §3 sidebar | §02 | M1 |
| teams | `plugins/teams` | §5 | §01, §03, §11 | M1 |
| bots | `plugins/bots` | §7 | §05, §11, §12 | M1 |
| tasks | `plugins/tasks` | §8 (task substrate) | §04 | M1 |
| approvals | `plugins/approvals` | §7.3 | §11 | M1 |
| memory | `plugins/memory` | §12 | §03, §08, §12 | M1 |
| knowledge | `plugins/knowledge` | §12 | §08 | M2 |
| answer | `plugins/answer` | §12 (Brain, Answer surface) | §12 | M1 |
| connections | `plugins/connections` | §11 | §10 | M2 |
| surfaces | `plugins/surfaces` | §14 | §09 | M2 |
| workshop | `plugins/workshop` | §9 | §07 | M2 |
| inbox-watch | `plugins/inbox-watch` | §13 | §08 | M2 |
| identity-oidc | `plugins/identity-oidc` | §4 | §01 | M1 |
| identity-password | `plugins/identity-password` | §4 | §01 | M1 |
| runtime-hermes | `plugins/runtime-hermes` | §7.1, §10 | §04, §05 | M1 |
| runtime-rules | `plugins/runtime-rules` | §7.1, §8 | §04 | M1 |
| memory-hindsight | `plugins/memory-hindsight` | §12 | §03, §12 | M1 |
| memory-git-mirror | `plugins/memory-git-mirror` | §12 | §03 | M1 |
| storage-local | `plugins/storage-local` | §5.2 | §02 | M1 |
| storage-s3 | `plugins/storage-s3` | §5.2 | §02 | M2 |
| repo-git | `plugins/repo-git` | §5.1 | §11 | M1 |
| mcp-server | `gateway-mcp` | §11 | §10 | M1 |
| slack-compat | `plugins/slack-compat` | §19 (week-3 spike) | — | Spike / M2 |
| webhooks | `plugins/webhooks` | §13, §7.2 triggers | §08 | M2 |
| guardrails-dlp | `plugins/guardrails-dlp` | §15 | — | M1 |
| guardrails-egress | `plugins/guardrails-egress` | §15 | — | M1 |
| audit | `plugins/audit` | §15, §18 (M1 row) | §11 | M1: append-only event log; M3: console and auditor export |
| retention | `plugins/retention` | §15 | — | M2 |

### 3.1 Kernel services (in `packages/kernel`)

| Service | Spec | Purpose |
|---|---|---|
| identity | §3 | who is acting — person or bot |
| event log | §3, §2 | append-only, Postgres outbox + LISTEN/NOTIFY |
| plugin host | §3 | loads server plugins from manifest; declarative client plugins |
| capability broker | §3, §7.3, §11 | resolves and enforces every tool call's allowlist |
| transport | §3 | HTTP/WS between client and server |
| scoped storage | §3 | per-team, per-channel storage interfaces |

### 3.2 Cohesion services (also `packages/kernel`)

| Service | Spec | Purpose |
|---|---|---|
| entity-link table | §3 | links messages/threads/tasks/pages/bots together for the right panel |
| read-state service | §3 | unread/followed state per person per thread |
| right panel with a back stack | §3 | one panel, navigable history, used by threads, files preview, Brain answers |

---

## 4. Build order

### 4.1 First six weeks (spec §19), concrete

| Week | Tasks | Subagent | Artefact | Check |
|---|---|---|---|---|
| 1 | RN 5,000-message benchmark, mid-range Android (spike, §5.1). Kernel API/extension points. Teams/ACL/repo/memory-scope/conversation data model. `BOT.md` schema — derive from §7.1 frontmatter; every §7.2 key required unless §7.1's example omits it; unknown keys rejected. | Coder (Sonnet) for kernel types/schema; Haiku for the RN benchmark build/profile | `packages/kernel` skeleton, `BOT.md` JSON Schema, benchmark numbers | Reviewer passes kernel types against §3; schema rejects an unknown key and a missing required key; benchmark numbers recorded per §5.1 |
| 2 | Monorepo + CI, Compose skeleton, Postgres with RLS, Postgres-backed job queue (pg-boss), LiteLLM container, git repo per team. | Coder for schema/migrations; Haiku for CI/Compose wiring | `deploy/compose/docker-compose.yml`, first RLS migration, `pnpm-workspace.yaml` | `pnpm test:rls` passes on an empty schema; `docker compose up` reaches healthy |
| 3 | `slack-compat` endpoint; a Hermes profile replying in a channel; the per-run tool-scoping spike (§6.2). **Stop and evaluate.** | Coder for the endpoint; orchestrator makes the stop/go call | Spike report answering the tool-scoping question | Spike gates in §5 below both resolved (pass, or documented fallback adopted) |
| 4 | Plugin kernel + capability broker; `channels`, `files`, `conversations` as the first plugins against the public SDK. | Coder | Three working plugins, `packages/sdk` v0 | Reviewer passes each plugin against §6 (recipe) |
| 5 | `mcp-server` with `task` and `answer` tools; `runtime-rules`; a Hindsight bank per team + cross-team recall CI test; `describe_self`; Brain template; Approvals inbox. | Coder for plugins; Haiku for the CI test wiring | `gateway-mcp`, `memory-hindsight`, Brain `BOT.md`, `plugins/approvals` | `pnpm test:memory-cross-team` passes |
| 6 | Guardrails on `pre_egress` and at the gateway; `runtime-rules` counting-benchmark variant; Brain answers a question from the repo with citations. | Coder | `guardrails-dlp`, `guardrails-egress`, working Brain answer with a citation | End-to-end: post to a channel, ask Brain, get a citation back |

### 4.2 M1 (month 5) — ordered feature slices, dependency order

Each slice is the smallest thing that can be demoed on its own.

1. Kernel boots; plugin host loads an empty plugin set.
2. Identity: password sign-in + first-admin bootstrap.
3. Postgres schema + RLS for messages, threads, ACL.
4. `channels` + `threads`: post a message, open a thread in the right panel.
5. `teams` + `repo-git`: create a team, `TEAM.md` committed, one writer per team repo.
6. `files` + `storage-local`: Files tree over repo config/pages and the `channels/<name>/` attachment table; viewers for Markdown, CSV, images.
7. `boards`: five-column board (Open · In progress · Verify · Waiting on a person · Done) over the task substrate.
8. `gateway-llm`: LiteLLM wired with aliases, budgets, guard presets.
9. `bots` + `runtime-hermes`: register a `BOT.md`, pairing token, one Hermes profile.
10. `gateway-mcp`: native tool set (`tasks.*`, `messages.*`, `memory.*`, `files.*`, `pages.write` — plain file write + commit, no Yjs yet — `knowledge.search`), capability broker enforces the allowlist. No knowledge base exists until the `knowledge` plugin ships in M2, so in M1 `knowledge.search` returns an empty result with reason `"no bases configured"` — do not fake or stub a base to make it return content.
11. `conversations`: conversation view, per-bot conversations channel not in the sidebar, thread-as-conversation.
12. `memory-hindsight` + `memory-git-mirror`: one bank per team, `memory/journal/`, `memory/facts/`, cross-team recall test green.
13. Brain template bot + `answer` plugin + Answer surface component (citations, lineage, sources reached, outside scope, hand-to-a-bot chips). `person:*` on mail is opt-in per person by default (spec §20).
14. `approvals`: inbox, `needsApproval` on a grant, gate two-stage before any model call.
15. `guardrails-dlp` + `guardrails-egress`: `pre_egress` hook, `standard`/`strict-egress`/`air-gapped`/`customer-facing` presets.
16. Onboarding flow (spec §16, eight steps) wired to everything above.
17. Team templates (Engineering, Marketing, Research, Product design, Customer support) — each creates channels, a board, default bots, knowledge slots, suggested connections; every template includes Brain.
18. `deploy/compose`: five containers by default.
19. `clients/web` (React) + `clients/desktop` (Tauri wraps web).
20. `clients/mobile` alpha, reduced surface per spec §2: channels, threads, conversations, approvals, notifications only; everything else via WebView.
21. Run the M1 demo script end to end (§9.1) and confirm every step passes.

### 4.3 M2 (month 10) — ordered, lower resolution

Self-setup (§9) → Workshop (Build/Rehearse/Live) → connections + `gateway-mcp` (first-party person connections: Google, Microsoft Graph, Notion) → knowledge (source sync rhythms, content-hash change detection, chunk versions, `answer_only_from`) → email-driven bots (`inbox-watch`, `webhooks`, Support responder, Enquiry bot) → rhythms + upgrade M1's plain `pages.write` to Yjs concurrent editing (§18 M2 row) → org chart view → outcome templates as example repos in docs → surfaces (primitives, `FormFlow`, `ReportBuilder`; `ImageGenerator` stays M3) → orchestration substrate (Orchestrator profile, Environments, shared repos, eval harness on PR) → runners (capability advertisement) → Helm without CRDs → subscription runtimes behind the off-by-default flag.

### 4.4 M3 (month 15–16) — ordered, lower resolution

`ImageGenerator` surface → terminal into a bot's sandbox (admin-only, credentials revoked on open) → plugin registry (`manythreads add owner/template`) → admin console → audit store + signed auditor export → pen-test checklist → App Store and Play Store submissions → docs and SDK publication.

---

## 5. Spike gates

### 5.1 Week 1 — phone message-list benchmark

- **What:** render a 5,000-message list in React Native on a mid-range Android device and scroll it.
- **Pass criteria:** sustained 60 fps scroll (no more than occasional single-frame drops) over the full 5,000-message list.
- **Numbers to record:** frame time p50 and p95 (ms), dropped-frame count over a 10-second scroll, JS-thread and UI-thread split, memory footprint at rest and mid-scroll, device model and Android version used.
- **If it fails:** this gates the **phone client only** — it does not block `clients/web` or `clients/desktop`, which are plain React (spec §2, §19). Reduce the phone surface further (virtualise more aggressively, cap history depth, drop rich previews in the list) and re-test. Do not let this slip the week-4 plugin-kernel start.

### 5.2 Week 3 — `slack-compat` + Hermes in a channel

- **What:** stand up the `slack-compat` endpoint and have a Hermes profile post a reply to a message in a channel through it.
- **Pass criteria:** a message posted to a channel produces a Hermes-generated reply in the same thread, end to end, through `slack-compat`.
- **If it fails:** stop before week 4. Diagnose whether the blocker is `slack-compat`'s endpoint shape or Hermes's channel-trigger handling; do not proceed to the plugin-kernel work until resolved or a documented workaround is in place.

### 5.3 Week 3 — per-run tool scoping in Hermes

- **The question (spec §6.2, A3 in the review):** can the MCP gateway tell which run/session a tool call belongs to, when one Hermes profile serves many sessions from one process? This is checked against the current Hermes source code.
- **How to test:** instrument a Hermes profile handling two concurrent conversation runs for two different people; log the session/run identifier attached to each outbound MCP tool call; confirm the gateway can resolve each call to the correct person's grants and connections.
- **Documented fallback (spec §6.2), if it fails:** each conversation run starts a fresh Hermes session with a per-run MCP URL; the gateway maps URL → run → person. Adopt this fallback immediately rather than spending further time on the ideal path — it is already specified, not a research problem.

---

## 6. Recipe for one plugin

Follow this checklist for every plugin in §3 above.

1. **Manifest** — package.json + a plugin manifest declaring name, kind (server/client/both), and the extension points it uses.
2. **Extension points declared** — from spec §3: `event.subscribe/emit`, `surface.{nav,screen,card,panel}`, `composer.action`, `settings.page`, `hook.{pre_persist,pre_egress}`, `provider.{identity,memory,bot_runtime,storage,llm,knowledge,viewer}`, `command.register`, `trigger.register`, `component.register`. Declare only what the plugin uses.
3. **Storage migrations with RLS** — every table gets a row-level security policy scoped to team/channel/person as appropriate before it ships. No table ships without RLS unless it is genuinely global (e.g. plugin registry metadata) — say so explicitly in the migration comment if so.
4. **Events emitted/consumed** — list them in the manifest; write an event-contract test for each (§8).
5. **Capability names registered** — every native tool the plugin exposes gets a stable name (`namespace.verb`, e.g. `tasks.claim`) registered with the capability broker, with its destructive/non-destructive tag.
6. **Tests** — unit tests for the plugin's logic; an RLS isolation test (person/team A cannot read team B's rows); an event-contract test (emitted events match their declared schema).
7. **Prototype fidelity check** — identify which prototype section(s) the plugin's UI must match; confirm layout, exact copy, and every documented state (empty, loading, error, populated) match.
8. **Docs page** — one page under `docs/` describing the plugin's capabilities, events and extension points, for other plugin authors.

### 6.1 Minimal manifest example

```json
{
  "name": "channels",
  "kind": "server+client",
  "extends": ["event.subscribe", "event.emit", "surface.nav", "surface.screen", "command.register"],
  "capabilities": [
    { "name": "messages.post", "destructive": false },
    { "name": "messages.search", "destructive": false }
  ],
  "events": {
    "emits": ["channel.message.posted"],
    "consumes": []
  }
}
```

### 6.2 Minimal test skeleton

```ts
// packages/plugins/channels/test/messages.test.ts
import { describe, it, expect } from "vitest";
import { createTestTeam, createTestPerson, postMessage } from "@manythreads/test-utils";

describe("channels: messages.post", () => {
  it("posts a message the author can read", async () => {
    const team = await createTestTeam();
    const person = await createTestPerson(team);
    const msg = await postMessage(person, team.channel("#general"), "hello");
    expect(msg.id).toBeDefined();
  });

  it("RLS: a person outside the team cannot read the message", async () => {
    const teamA = await createTestTeam();
    const teamB = await createTestTeam();
    const outsider = await createTestPerson(teamB);
    const msg = await postMessage(await createTestPerson(teamA), teamA.channel("#general"), "secret");
    await expect(readMessageAs(outsider, msg.id)).rejects.toThrow();
  });

  it("event contract: channel.message.posted matches its schema", async () => {
    const event = await captureEvent("channel.message.posted", () => postMessage(/* ... */));
    expect(event).toMatchSchema(channelMessagePostedSchema);
  });
});
```

---

## 7. The referee rules — enforced in code, never in prompts

| Rule | Where enforced | Test that proves it |
|---|---|---|
| Bots never write `bots/`, `TEAM.md`, `skills/`, `routines/` | Capability broker (`packages/kernel`) intercepts every `files.*` call | A bot's `files.write` to `bots/coder/BOT.md` is rejected; lands only via the proposal/PR path |
| Gateway picks the memory bank from the bot's team | `gateway-mcp` resolves the bank from the pairing token, never a caller param | Forged `bank` param is ignored; bank used is always `team:<bot's own team>` |
| Narrowest-source retain rule | `gateway-mcp`, from the run's source log, before `memory.retain` completes | A run that read `person:*` may only retain to `people/<asker>.md`; team-bank retain in that run is rejected |
| `person:*` only in `conversation`/`mention` runs | Capability broker checks trigger type before resolving `person:*` | A `routine`/`heartbeat`/`task_assigned` run using `person:*` is rejected |
| Gate two-stage before model | `runtime-hermes` / `guardrails-dlp` pre-call hook | Regex match blocks before any LLM gateway call is logged; local classifier (`local` alias) runs second, never remote |
| `needsApproval` — single mechanism | `plugins/approvals`, one code path set by Environment `protected: true`, `dispatch: strict`, or DLP `require_approval` | All three sources produce an identical Approvals-inbox row via the same handler |
| `mayTag` compiled to allowlists | `plugins/bots` compiles `mayTag` into the capability allowlist at load | Handover to a bot outside `mayTag` is rejected before it is attempted |
| One owner per branch | `plugins/tasks` claim logic | Two bots claiming the same task/branch — exactly one succeeds |
| Freshness (`base_sha`, `tested_sha`) | `plugins/tasks` | A publish/merge with a stale `base_sha` is blocked |
| Budgets | `gateway-llm`, workspace → team → bot → session | A call exceeding any level's budget is blocked before the model runs |
| Destructive tools never listed | `plugins/connections` at grant/registration | CI lints every tool allowlist; a destructive-tagged tool in a grant fails the build |
| Cross-team recall test | `plugins/memory-hindsight` | Team A bot queries, gets nothing from team B's bank — per-PR CI (§12) |
| Hindsight reachable only from the gateway | `deploy/compose` + `deploy/helm` network policy | A direct Hindsight call from a Hermes container is refused |

---

## 8. Testing and CI

| Cadence | Tests |
|---|---|
| Per-PR | unit; RLS isolation; event contracts; cross-team memory test; `runtime-rules` counting-benchmark variant (no model); eval harness, if the diff touches any `BOT.md`; Playwright screenshot comparison against prototype plates, for every M1 screen the diff touches |
| Nightly | model-backed counting benchmark (full `runtime-hermes` variant); full eval suite across all bots |
| Release | pen-test checklist (spec §18, M3 line) |

Commands:

```bash
pnpm test                       # unit tests, all packages
pnpm test:rls                   # row-level security isolation tests
pnpm test:events                # event-contract tests
pnpm test:memory-cross-team     # cross-team Hindsight recall isolation (§12)
pnpm test:runtime-rules         # counting-benchmark variant, no model, per-PR
pnpm test:runtime-rules:nightly # counting-benchmark, model-backed, nightly only
pnpm test:evals -- --bot=<slug> # eval harness for a changed BOT.md
pnpm playwright test            # screenshot comparison against mockups-all.html plates
pnpm test:pen -- --release      # pen-test checklist, release cadence only
```

---

## 9. Definition of done per milestone

### 9.1 M1 demo script

Run this end to end. Every step must pass without manual intervention beyond what is listed.

1. `docker compose up` in `deploy/compose` — five containers reach healthy: Postgres, LiteLLM, Hindsight, ManyThreads, Hermes.
2. Sign in as the first admin (password bootstrap).
3. Create team **Engineering** from the Engineering template.
4. Post a message in **#dev**.
5. Open that message as a thread in the right panel.
6. Open **Files** and see the team repo, including a `memory/` folder.
7. Click **Brain** and ask it a question about something posted earlier.
8. Get back a cited answer, including at least one citation sourced from team memory (not just the repo or a channel message). No knowledge base exists yet in M1 (the `knowledge` plugin is M2, §3), so citations come only from the repo, messages and team memory — not a knowledge-base chunk.
9. Trigger an approval (e.g. a `needsApproval` connection tool call) — it appears in the **Approvals** inbox and can be approved.

### 9.2 M2 acceptance list

- Self-setup: "Add a bot" brief produces a graded requirement list (covered/grantable/missing/blocked/unclear) and a proposed `BOT.md` diff; approving it creates the bot.
- Workshop: Build (diffs), Rehearse (sandboxed, writes intercepted and badged), Live (real-run Q&A, admin-only terminal, credentials revoked on open) all work.
- Connections + `gateway-mcp`: team connections via Activepieces; person connections (Google Drive/Gmail/Calendar, Microsoft Graph, Notion) via the first-party token store; GitHub/GitLab MCP servers; SSH and Kubernetes brokers issuing short-lived certs/tokens.
- Knowledge: a source sync rhythm detects a change by content hash, re-indexes, bumps the chunk version; a citation shows "source changed since" when the chunk version differs.
- Email-driven bots: an `inbox` trigger produces one run thread per email thread; Support responder and Enquiry bot work as specified (§13).
- Pages + rhythms: M1's plain `pages.write` is upgraded to a Yjs document — two people editing the same page concurrently merge live; one commit per editing session, all contributors as co-authors.
- Org chart view renders leads (`tasks.create`/`tasks.assign`) above specialists with `mayTag` edges.
- Outcome templates exist as example repos in `docs/`, cloneable into `teams/<team>/`.
- Surfaces: primitives, `FormFlow`, `ReportBuilder` render and export to `pages/` by default.
- Orchestration substrate: handoff transfers ownership atomically, posts the `@mention` card, delivers `task.assigned` with a fresh worktree.
- Runners: one binary, one outbound connection, advertises capabilities; one runner per team.
- Helm deploys without any CRD.
- Subscription runtimes: flag off by default; when on, bound to one person and their bot only, never triggered by a routine/heartbeat/inbox/`task_assigned`.

### 9.3 M3 acceptance list

- `ImageGenerator` surface works via the `image` alias.
- Terminal into a bot's sandbox: admin-only, never on production placements, credentials minted for the run are revoked the instant the terminal opens.
- Plugin registry (`manythreads add owner/template`) lists and installs community templates.
- Admin console covers workspace, teams, connections, budgets, guard presets.
- Audit store records who asked, what was reached, what was withheld, when — plus git history; signed, content-blind auditor export covers a date range.
- Pen-test checklist passed.
- App Store and Play Store submissions accepted.
- Docs and SDK published.

---

## 10. Things Claude must not do

### 10.1 Non-goals (spec §20) — do not build these

Pipeline designer · plugin marketplace with payments · voice/video · end-to-end encryption for agent channels or DMs · hand-building connectors the team-connections tool already covers · a second agent runtime · a browser extension · run-time loading of third-party JS client plugins · memory providers beyond the default provider and its git mirror · a non-linear video-editing surface and a separate board surface duplicating Boards · a standalone cross-team digest subsystem (a digest is a page written into another team's `knowledge/` folder, approved like any share) · live editing of Google Docs/Sheets/Slides inside ManyThreads (link-preview card only) · Kubernetes CRDs for Team/Bot/Connection/Environment · separate trigger types for board changes or connection events beyond task events and `webhook` · a folder-level visibility scope on a bot.

### 10.2 Process anti-patterns — never do these regardless of task

- The orchestrator writing more than 20 lines of code itself instead of delegating to a Sonnet subagent.
- Marking a task done without a fresh reviewer subagent passing it.
- Building anything resembling a pipeline designer, however small — the Orchestrator's `BOT.md` body **is** the pipeline; there is no privileged code path and no visual designer.
- Adding a "mode" field to a bot. There are no modes (spec principle 6, §7.3) — only Gate and Approval pause for a person.
- Adding a second agent runtime alongside Hermes.
- Adding a Kubernetes CRD for Team, Bot, Connection or Environment.
- Committing an attachment (image, recording, PDF, video export) to a team git repo. Attachments always go to Files storage.
- Letting a bot select or pass its own memory bank name. The gateway derives the bank from the bot's team, always.
