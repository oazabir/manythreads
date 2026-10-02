# manythreads — Engineering Specification v1.4.1 (handover)

One document, one prototype. Supersedes v1.3. This revision applies the buildability review: Hindsight is now the default memory provider with a git-backed mirror, replacing three memory providers and Memory Exchange, and attachments, clients, deployment and the wait-for-a-person model are all simplified to what the product needs. See the appendix for `BUILDABILITY-REVIEW.md`.

**Prototype:** `mockups-all.html` — twelve sections. References look like `[proto §NN]`.

---

## 0. In one paragraph

A self-hosted, open-source collaboration platform where people and AI agents work in the same channels and threads. Teams own channels, Files as a tree over the team repo and Files storage, memory, connections and bots. Bots are deterministic automations or Hermes Agent profiles whose `BOT.md` is the whole bot. You talk to any bot in a conversation view; every team has a read-only Brain bot that answers from everything the team knows, with citations. The platform is the referee: ownership, freshness, budgets, who may tag whom, and what production requires are enforced whatever a prompt says. Every model call goes through one LLM gateway or a person's own subscription CLI; every external action through one MCP gateway; every byte leaving passes guardrails. Bots configure themselves from a brief, are tested in conversation, learn from corrections, write durable pages, and can hand a person a screen instead of a paragraph. Nothing in the AI stack is built here.

---

## 1. Principles (binding)

1. **One conversation.** Humans, automations and agents share the same primitives. A conversation with a bot is a thread.
2. **The prompt is the policy; the platform is the referee.**
3. **One chokepoint each.** LLM gateway for models, MCP gateway for tools, guardrails for egress. The subscription runtime is the one declared exception and is labelled.
4. **A bot never holds a credential.** Pairing token only; everything else is minted per task or held by a gateway.
5. **A bot can ask for anything and grant itself nothing.** `bots/`, `TEAM.md`, `skills/`, `routines/` are never writable through a bot's file capability — changes to them arrive only as an approved proposal.
6. **Bots do the work.** No modes. A person is involved only where an Environment, a gate list, or a needs-approval flag says so.
7. **Answers are scoped to the asker.** A bot answering a person searches with that person's grants and that person's own connections, and says what it could not reach.
8. **What a person would diff lives in the repo; what they would download lives in Files.**
9. **Integrate, don't build.** See §17.
10. **Self-hosted is the default install.**

---

## 2. Architecture

```
Clients    React (browser) · Tauri 2 desktop shell (macOS, Windows, Linux) · React Native (iOS, Android; reduced surface: channels, threads, conversations, approvals, notifications; a WebView for the rest)
Kernel     identity · event log · plugin host · capability broker · transport · scoped storage   (< 15k lines)
Plugins    channels · direct-messages · threads · conversations · files · pages · boards · rhythms · search · analytics
           notifications · teams · bots · tasks · approvals · memory · knowledge · answer · connections
           surfaces · workshop · inbox-watch
           identity-oidc · identity-password · runtime-hermes · runtime-rules
           memory-hindsight · memory-git-mirror · storage-local · storage-s3 · repo-git
           mcp-server · slack-compat · webhooks · guardrails-dlp · guardrails-egress · audit · retention
Gateways   LLM gateway (LiteLLM) · MCP gateway · SSH / Kubernetes brokers
Services   Postgres 19 (RLS, pg_trgm search, pgvector for knowledge, partitioned analytics; Hindsight's database lives in the same cluster) · LiteLLM · Hindsight   — optional: NATS, a Temporal-class queue, S3/MinIO, OpenBao/KMS, Activepieces
Runtimes   Hermes profiles in per-team containers or on runners; Claude Code / Codex CLIs on runners bound to a person (behind a workspace flag, off by default)
```

- **Server:** Node/TypeScript (Fastify). One language for the plugin SDK, client and server.
- **Event backbone:** a Postgres outbox with `LISTEN/NOTIFY` by default; NATS JetStream is an optional transport plugin for multi-node deployments.
- **Data:** Postgres with row-level security for messages, threads, conversations, read state, ACL, tasks, approvals, audit. A git repo per team for text configuration and durable text pages — bots, skills, routines, knowledge definitions, the memory mirror, pages (§5); attachments live in Files storage, not git.
- **Durable waits:** our own Postgres job and outbox tables (`FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`) and a small state machine per approval/rhythm by default; a Temporal-class queue is an optional plugin for heavier workflow needs. No Redis. Ephemeral state (presence, typing, leases) in UNLOGGED tables; rate-limit counters in process memory, per replica.
- **Shared schemas:** every entity, API payload, event and `BOT.md` frontmatter is a Zod schema in `packages/shared`; server and clients use the same types; no client-side proxy entities.
- **Deployment:** `docker compose up` starts five containers by default — Postgres, LiteLLM, Hindsight, manythreads, Hermes. NATS, a Temporal-class queue, S3/MinIO, OpenBao/KMS and Activepieces are optional plugins. Helm plus a controller that reads the DB manages the same services on k3s/Kubernetes — no CRDs; one namespace with per-team labels and NetworkPolicies by default, namespace-per-team as an option; per-team egress proxy; gVisor RuntimeClass. Air-gapped supported. See `DEPLOY-k3s.md`.

**Week one:** benchmark a 5,000-message list in React Native on a mid-range Android device. This gates the phone client only — the web/desktop client is plain React and is not blocked on it.

---

## 3. Kernel and plugin system

The kernel provides six services: identity, the append-only event log, the plugin host, the capability broker, transport, and scoped storage interfaces. Everything else is a plugin.

**Extension points:** `event.subscribe/emit`, `surface.{nav,screen,card,panel}`, `composer.action`, `settings.page`, `hook.{pre_persist,pre_egress}`, `provider.{identity,memory,bot_runtime,storage,llm,knowledge,viewer}`, `command.register`, `trigger.register`, `component.register`.

**Client plugins** are declarative on every platform — schema-driven navigation, screens, cards and panels. JS client plugins are bundled at build time, in the web/desktop build only; React Native has no restricted realm to load third-party JS into at run time. Run-time loading of third-party JS is deferred until after GA (§20). **Server plugins** are in-process Node modules loaded from a manifest; nothing server-side needs module federation.

**Three kernel services make plugins cohere** `[proto §02]`: the entity-link table; the read-state service; the right panel with a back stack.

**Sidebar contract** `[proto §02, §11, §12]`: Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) · Bots (50). The **Bots header** opens the team roster; **a bot's name** opens its conversation view (§7.6).

---

## 4. Identity and sign-in `[proto §01]`

`identity-oidc` and `identity-password` are plugins; a workspace enables one or more.

| Method | Setup | Notes |
|---|---|---|
| Google Workspace preset | Client ID, secret, allowed domains | OIDC; domain allowlist is the workspace boundary |
| Microsoft 365 / Teams preset | Tenant ID, client ID, secret, allowed domains | Entra ID; covers Teams sign-in; SAML on enterprise track |
| Username and password | Policy (min 12), email verification, self-signup default off | Always available to admins as break-glass |
| Any OIDC provider | Issuer URL, client ID, secret | GitHub, Apple, Okta, Keycloak |

SCIM and group-to-team mapping are on the enterprise track.

---

## 5. Workspaces, teams, and the team repo `[proto §01, §03, §11]`

A **workspace** has people, sign-in methods, workspace-level connections, Environments, the LLM gateway, and teams. A **team** owns a roster of people and bots; channels in groups; a board; rhythms; a repo; a memory bank; knowledge bases; a connections project; policies; servers. Teams are the ACL, memory, connection, repo and namespace boundary. A person may be in many teams. A bot belongs to exactly one team. **Roles:** workspace `owner`, `admin`, `member`, `guest`; team `lead` and `member`, plus role tags set in `TEAM.md` (e.g. `role:on-call`) that approvals and handovers refer to. A guest reads only the channels they are added to and cannot talk to or mention bots. Team leads and workspace admins change `bots/`, `TEAM.md`, `skills/` and `routines/` through the UI (a proposal that commits); everyone else through a PR. A `BOT.md` that fails to load shows a red banner on the bot page and the previous version stays live.

### 5.1 The team repo

```
teams/engineering/
  TEAM.md                        manifest: name, channel groups, defaults, dispatch policy
  bots/<slug>/BOT.md             the bot — frontmatter = spec, body = system prompt
  bots/<slug>/memory.md          private memory (maxLines, compaction)
  bots/<slug>/lessons.md         the Workshop's lessons file
  bots/<slug>/people/<id>.md     per-person notes (Brain, and any bot talking to people)
  skills/<slug>/SKILL.md         team skills
  routines/<slug>.yaml           scheduled tasks with a contract and an output page
  knowledge/<base>/sources.yaml  knowledge base definitions
  memory/journal/<yyyy-mm-dd>.md Hindsight's daily consolidation (a built-in routine writes it)
  memory/facts/<topic>.md        durable facts, human-editable; re-retained into the bank on commit
  pages/…                        durable outputs: reports, specs, briefs, saved answers
  apps/<slug>/index.html         embedded apps
```

The repo holds text configuration and durable text pages only; attachments live in Files storage (§5.2). Every change through the UI is a commit with the actor as author. The History panel diffs and restores any file. A team may push its repo to GitHub or GitLab — configuration and pages, not attachments; a PR to `bots/coder/BOT.md` changes the bot once merged, and the eval harness runs on the PR. One writer service per team serialises commits; the repo is the truth for bot definitions and the DB reloads on commit.

### 5.2 Files `[proto §02, §11]`

The Files section is a view over two stores: the repo's text configuration and pages (git, §5.1), and attachments in Files storage — object storage (S3/MinIO) or local disk by default — tracked in a `files` table carrying the folder path and the channel's ACL. Files posted in a channel land under `channels/<name>/` in that table, not in git; bot outputs land in `pages/`, which is git. Tree column, breadcrumb, file list and right-panel preview don't distinguish the two stores. Visibility follows the folder's channel or the team, enforced by manythreads on every read (principle 8). Viewers: Markdown WYSIWYG (Tiptap) with slash commands and a raw toggle; CSV as an editable table; PDF; Office read-only; Mermaid; images, video, audio; code. A folder with `index.html` and no `index.md` renders as a sandboxed embedded app. A `.md` with `google:` frontmatter shows a link-preview card — not a live embed.

Pages are edited through a server-held Yjs document with Tiptap bindings; edits merge live and the repo gets one commit per editing session (on idle or close) with every contributor as a co-author. Bots write pages through the same document, so a person and a routine cannot clobber each other.

### 5.3 Templates `[proto §01, §11]`

**Team templates** (Engineering, Marketing, Research, Product design, Customer support) create channels, a board, default bots, knowledge slots and suggested connections. **Every team template includes Brain.** **Outcome templates** ("Clear the inbox", "Rank the bug queue", "Build the customer QBR", "Prepare every 1:1", "Answer customers from the manuals", "Ship a release", "Weekly board brief", "Competitor watch") add bots, routines, knowledge slots and connectors to an existing team. A template is a folder of `BOT.md` files, routines and knowledge slots in a git repo. Team templates ship in v1; outcome templates ship as example repos in the docs — the `manythreads add owner/template` registry waits until a third party has published one. Community templates are just repos.

---

## 6. Channels, threads, conversations, pages, boards, rhythms

### 6.1 Channels and threads `[proto §02]`

Channels are collections of messages in groups. A message can have a thread, opened in the right panel with the channel still visible. **Threads** is an inbox: Followed · Unread · Mine (threads the person started or holds a task in). Following a board card follows its thread.

### 6.2 Conversations — talking to a bot `[proto §12]`

Clicking a bot's name opens the **conversation view**: a list of that bot's conversations with you (Mine · Shared · Channel mentions) on the left, the selected conversation on the right, a message box at the bottom. There is no "new conversation" button. Sending a message starts a new thread — your message is the root, the bot replies in it — and the view switches to that thread. The empty state is the message box and a few prompt chips.

Mechanics:

- Every conversation is an ordinary thread in a per-bot conversations channel the sidebar does not list. Following, unread, the right panel, entity links and pages work unchanged.
- Conversations are **private to the person** by default. "Share to #channel" posts the thread into a channel (§6.3 covers private sources).
- A bot @mentioned in a channel gets that thread listed under **Channel mentions** for the person who asked.
- The bot receives a `conversation` trigger carrying the person, their grants and connections. The platform scopes every tool call in that run to the intersection of the bot's capabilities and the person's visibility — a bot with `drive.search` on "the asking person's connections" searches *their* Drive with *their* OAuth.
- Same view for every bot. A bot that acts (Coder) replies here as in a channel thread; handovers go into the thread as always.

**Per-run scoping (week-3 spike):** this assumes the gateway can tell which run a tool call belongs to, inside a Hermes profile that serves many sessions from one process — checked against the current Hermes code in the week-3 spike (§19), alongside the message-list benchmark. Documented fallback if Hermes cannot carry per-session tool auth: each conversation run starts a fresh Hermes session with a per-run MCP URL, and the gateway maps URL → run → person.

### 6.3 Sharing a conversation with private sources

An answer in a private conversation may cite sources only the asker can see (their Drive, a private channel). When shared to a channel:

- Team-scoped citations (repo, team memory, knowledge bases, channels the audience can see) are kept as-is.
- Person-scoped citations are kept in the lineage list as **"from Omar's Drive · not shared"** with the snippet removed; the answer text is unchanged, so readers see that a claim rests on a source they cannot open.
- The sharer sees this preview before confirming and can remove any cited claim first.
- Logged as an access event: who shared, to where, which sources were masked.

### 6.4 Pages `[proto §11]`

Durable outputs. Every routine and every task step may declare `output: { page, mode }`. The thread shows "wrote pages/reports/week-37.md · diff"; the page shows who updated it, when, and its history. Surfaces export to pages by default. Any conversation can be **saved as a page** (`pages/answers/<slug>.md`) with the same masking rule as §6.3 if the page's folder is team-visible. A cross-team digest is a page a routine writes into another team's `knowledge/` folder, approved like any other share.

### 6.5 Boards and rhythms `[proto §11]`

Boards are saved views over the task substrate: Open · In progress · Verify · Waiting on a person · Done. **Rhythms** is the board's third tab: **heartbeat** (a scheduled prompt; the bot decides), **routine** (a scheduled task with a contract and an output page; `routines/<slug>.yaml`), **task** (one prompt, one run, one output). Each rhythm may override `model`/`effort`.

---

## 7. Bots — the generic model `[proto §05, §11, §12]`

One schema. Hermes only. The platform never learns what "support", "sales" or "brain" means.

### 7.1 `BOT.md`

```yaml
---
name: Coder
role: Owns a task's branch
kind: agent                        # agent | automation
runtime: hermes                    # hermes | rules; hermes may bind a subscription (§10.3)
model: { aliases: [code, fast], effort: medium }
visibility: team                   # team | workspace
triggers:
  - { type: task_assigned }
  - { type: mention, source: { channels: ["#dev", "#releases"] } }
  - { type: conversation }         # present on every bot people may talk to
capabilities:
  # bots/, TEAM.md, skills/, routines/ are never bot-writable
  native: [tasks.read, tasks.claim, tasks.complete, tasks.handoff, messages.*, memory.recall, memory.retain, files.*, pages.write, knowledge.search]
  runtime: [shell, files, git]
  connections:
    - { name: github-kahf, tools: [github.read, github.push_branch, github.pr.create, github.pr.comment] }
knowledge: [{ base: architecture-docs }, { base: runbooks }]
memory: { file: memory.md, maxLines: 2000, people: people/<id>.md, grants: [{ bank: team:engineering, access: readwrite }] }
skills: [git-hygiene, pr-etiquette]
guard: { preset: strict-egress, gate: ["credential rotation", "licence change", "delete production data"] }
approvals: { needsApproval: [], approvers: [role:on-call] }
handover: { mayTag: [reviewer, tester], toPerson: [role:on-call] }
placement: { node: build-01, isolation: shared }
limits: { sessionMinutes: 45, hops: 3 }
contract: { outputs: { sha: string, pr: url } }
evals: { set: coder-20, minScore: 0.9 }
---
# Coder — Engineering
You own a task until you hand it over…
```

### 7.2 Sections

| Section | Holds |
|---|---|
| Identity | name, role, kind, runtime, visibility |
| Behaviour | the body; versioned by git |
| Triggers | `conversation`, `mention`, `routine` (covers heartbeat, empty contract), `task_assigned`, `inbox`, `channel_message`, `webhook` (covers connection events) |
| Capabilities | one allowlist: native, runtime, connection tools; `person:*` means "the asking person's own connections". `bots/`, `TEAM.md`, `skills/`, `routines/` are never bot-writable — changes arrive only as an approved proposal |
| Knowledge | bases; `answer_only_from` |
| Memory | private file with `maxLines`; per-person notes; one team-bank grant (Hindsight, `team:<slug>`) |
| Model | aliases, effort, fallbacks, budgets, rate limit; or a subscription binding |
| Guard | preset; bot rules; gate list |
| Approvals | connection tools flagged `needsApproval`; who approves |
| Handover | `mayTag`, hand-to-person targets, escalation |
| Placement & limits | node or runner; capabilities required; isolation; timeouts; hops |
| Contract | typed outputs when used as a task step |
| Evals | scenario set; min score; run on demand and on PR |
| Audit | runs, tool calls, guardrail decisions, credential mints, approvals, shares, setup thread |

### 7.3 What waits for a person — and nothing else

There are no modes. Two mechanisms pause for a person, and everything else is a way of setting one of them:

- **Gate** — before any model call, on a gate-list topic. Two stages: an exact/regex match first; a small local classifier on the `local` alias (air-gapped safe, sees only the message, never a remote provider) as the second stage.
- **Approval** — a tool call waiting for a person. `needsApproval` on a grant is the one mechanism; everything else sets it: an Environment with `protected: true` sets it on every tool tagged with that environment; `TEAM.md`'s `dispatch: strict` sets it on `tasks.handoff`; the DLP `require_approval` outcome (§15) sets it on that one call.

Everything pending appears in one Approvals inbox `[proto §11]`. Destructive tools are never in any connection's tool list.

### 7.4 Placement `[proto §04]`

In-cluster: `nodeSelector`. Outside: a runner — one binary, one outbound connection, advertising capabilities (`chrome`, `cdp`, `playwright`, `docker`, `gpu`, `ffmpeg`, `windows`, `ios-simulator`, `claude-code`, `codex`). One runner, one team.

### 7.5 Roster, org chart, `visibility` `[proto §02, §11]`

The Bots header opens the **roster**: every bot with kind, runtime, placement, status, an "Open conversation" button and "Configure". The **org chart** view shows leads (bots with `tasks.create` and `tasks.assign`) above specialists with `mayTag` edges. `visibility` is a one-word read scope: `team` (default) or `workspace` — for bots a workspace admin shares across teams.

### 7.6 Handover `[proto §04]`

`handoff_task(task_id, to, note, mode)` transfers ownership atomically, posts an `@mention` with a card, delivers `task.assigned` with a fresh worktree, ends the caller's turn. `mayTag` is compiled into each bot's allowlist. One owner per branch of work.

---

## 8. Orchestration `[proto §04]`

The Orchestrator is a Hermes profile whose `BOT.md` body is the pipeline; no privileged code path, no pipeline designer. The **task substrate** is the referee: goals and tasks; one owner per branch; claims; freshness (`base_sha`, `tested_sha`); the publish boundary; rework, handoff and spend bounds; claim timeouts; wake on `task.updated`. The counting benchmark — twenty bots share one counter task and must each claim, add one and release so the log reads 1→20 exactly, no duplicates, no gaps, within 60 s — runs nightly and on release with Hermes; a `runtime-rules` variant (no model) is the per-PR test of the substrate's locking. **Environments** carry credentials, approval rules, change windows, deploy caps, auto-rollback. **Shared repos:** repository of record → team bare mirror → per-bot worktrees; branch-scoped push tokens per task; merge behind the Environment's approval. **Eval harness** on PR.

---

## 9. Self-setup and the Workshop `[proto §06, §07]`

**Self-setup:** "Add a bot" is a brief. On a setup profile with a small toolset (`describe_self`, read-only `knowledge.search`, `ask_clarification`, `propose_config`), the bot inventories the team, grades each requirement — covered · grantable · missing · blocked · unclear — asks one batched question per gap, and proposes `BOT.md` as a diff. It can propose stricter, never looser. Approve creates the bot; the platform applies grants.

**The Workshop** is the bot's persistent conversation (it lives in the conversation view under a "Workshop" tab) with three modes: **Build** (change requests → diffs), **Rehearse** (real prompt, knowledge and read tools; every write intercepted and badged — a test sandbox), **Live** (ask about real runs; open a recorded **terminal** into the sandbox, admins only, never on production placements — credentials minted for the run are revoked the moment a terminal opens; the person brings their own).

**Learning loop:** a correction files a lesson to `lessons.md`, adds an eval case, and proposes a `BOT.md` rule when a lesson repeats or a person says "make that a rule". Lessons that contradict a gate or guard are refused. When `memory.md` crosses `maxLines`, the Workshop proposes a compaction. Replay is **record/replay of guard and gate decisions only** — deterministic, free — unless a person asks for a full model replay, cost shown first. **Re-assessment** runs when a connection, knowledge base or runner is added or revoked, or an eval score drops.

---

## 10. Models `[proto §01]`

### 10.1 The LLM gateway

Every model call goes through one LiteLLM proxy (MIT) in `manythreads-llm`, except subscription runtimes. Configured once at Workspace → LLM: providers; aliases `smart`, `fast`, `code`, `local`, `embed`, `vision`, `image`, `transcribe`; fallbacks; budgets workspace → team → bot → session; rate limits; guard presets `standard`, `strict-egress`, `air-gapped`, `customer-facing`; caching; observability. Keys are minted and deleted with the bot. The gateway's DLP pre-call hook is the second guardrail. Model-provider domains appear on no team allowlist.

### 10.2 How Hermes reaches it

Each profile's `OPENAI_BASE_URL` points at the gateway with the bot's virtual key. Aliases, never model names.

### 10.3 Subscription runtimes — Claude Code and Codex

A person signs in to Claude Code or Codex at Workspace → LLM → Subscriptions or on their profile, **behind a workspace flag that is off by default**, presented as interactive coding help for one person. Hermes on a runner with the `claude-code` or `codex` capability drives that CLI for bots bound to that person. Rules: bound to one person, that person's bot only; **never bound to anything the platform triggers** — routines, heartbeats, inbox watches and `task_assigned` always use the gateway; the gateway's pre-call guard is bypassed and the bot is labelled "subscription · bypasses gateway guard"; spend is read from the CLI's usage output and shown separately; the workspace owner accepts the provider's terms when they turn the flag on.

---

## 11. Connections and the MCP gateway `[proto §10]`

One MCP endpoint per bot. Behind it: native tools; the team's Activepieces project (MIT; 700+ pieces auto-exposed as MCP; OAuth with limited scopes; credentials encrypted, no read-back) for **team** connections, installed by the "Add connection" flow the first time a team wants a non-first-party app; GitHub MCP server + manythreads GitHub App; GitLab's official MCP server; SSH broker (step-ca or Teleport; certs per task ≤ 1 h); Kubernetes broker (`TokenRequest` per task, 1 h); email connections. **Person** connections are a small first-party set held by manythreads — Google (Drive, Gmail, Calendar), Microsoft Graph (OneDrive/SharePoint, Outlook), Notion — on the same OAuth apps as sign-in where possible, so a Drive grant is an incremental scope on the existing Google app, not a new integration. The MCP gateway resolves `person:*` from manythreads's own token store; a bot with that grant searches those only in a conversation or mention run, never a routine. Each connection: scope, per-bot grants with a tool allowlist and optional `needsApproval`, environment tag, owner, expiry, audit. Onboarding sets up GitHub and GitLab at the workspace level.

---

## 12. Memory, knowledge, and Brain `[proto §03, §08, §12]`

**Memory.** Hindsight is the default provider, in the default install (§2). **One Hindsight bank per team**, `team:<slug>` — the shared memory of every AI agent on that team. Hermes profiles read and write only that bank, via `memory.recall`/`memory.retain` at the MCP gateway. Bots also keep the private files from before: `bots/<slug>/memory.md` (`maxLines`) and `bots/<slug>/people/<id>.md`.

Partitioning is enforced by the platform, not the prompt: the gateway derives the bank from the bot's team, which it knows from the bot's pairing token; a bot cannot name a bank; Hermes profiles carry no Hindsight endpoint or key; the Hindsight API is reachable only from the gateway (network policy). A cross-team recall test — a bot in team A gets nothing from team B's bank — is a deterministic per-PR CI test. A deployment option runs one Hindsight instance per team for hard isolation.

The platform feeds team activity into the bank so Brain can answer from what the team did, not just wrote: the `memory` plugin retains team-visible messages and threads, task/board changes, run summaries, approvals, pages, handovers, each tagged with source, actor, time and a link. Private channels, DMs, and any run that touched a `person:*` source are **never** retained to the team bank: a run retains only to memory no wider than the narrowest source it read; a person-scoped run retains only to `people/<asker>.md`. The gateway enforces this from the run's source log; it feeds the audit "what was withheld" record (§15).

The team bank is also files under the team repo's `memory/`: `memory/journal/<yyyy-mm-dd>.md` (Hindsight's daily consolidation, a built-in routine) and `memory/facts/<topic>.md` (durable facts, human-editable). Git is the editable view; Hindsight is the retrieval engine — a commit to `facts/` is re-retained into the bank, a delete forgets it. `memory-git-mirror` is this mechanism, not a separate provider — MemPalace and the standalone Markdown vault are dropped; `provider.memory` stays open for a community plugin.

**Knowledge** is what people give bots: bases in `knowledge/<base>/sources.yaml` — PDFs and manuals, Drive/SharePoint folders, docs sites, repo `docs/`, Notion — indexed in pgvector via `embed`. Every source gets a **sync rhythm** (a routine like any other), content-hash change detection, and a `version` on every indexed chunk; a citation carries the chunk version, and the Answer surface shows "source changed since" when it differs. `answer_only_from` blocks answers with no supporting passage. Unanswerable questions route to `#kb-updates`.

**Search:** one Postgres full-text index over messages, thread titles, page text and file names, filtered by RLS, exposed as `messages.search`/`files.search`. Semantic search is the knowledge plugin's job; there is no separate search service.

**Brain** is the team's read-only question-answering bot, a Hermes `BOT.md` in every team template. Capabilities: `knowledge.search` on all team bases, `files.search` over the repo and Files storage, `memory.recall` on the team's Hindsight bank, `messages.search`, and `person:*` connection reads (`drive.search`, `notion.search`, `gmail.search`) — connected sources are searched with the asker's own OAuth, so sharing rules apply by construction. Its only writes are `messages.post` and `pages.write` ("Save as page"). It keeps `people/<id>.md` notes on how each person likes answers.

Brain replies with the **Answer** surface component (§14): numbered citations, cited by source link (channel message, task, run, or knowledge chunk) so a memory-derived claim stays traceable; a **Lineage** list (source, snippet, age); **Sources reached** with scoped/full markers; **Outside scope** with the reason each source was not reached; an "Answered for <person> · scoped · <alias>" line; and **Hand to a bot** chips. Brain never acts: a chip opens a thread with the question and answer and tags the bot. The `answer` tool is native; any bot may call it, and the surface renders identically in a channel thread. Nothing in the platform knows Brain is special.

---

## 13. Email-driven bots and team templates `[proto §08]`

`inbox` trigger on an email connection: folder, filter, dedupe by thread, one run thread per email thread. Email tools are connection tools. Reference bots: Support responder (manuals KB, `customer-facing` preset, gate list, `email.send` flagged `needsApproval`) and Enquiry bot (classifies, extracts a typed lead, drafts, opens a board card).

| Team | Channels | Default bots |
|---|---|---|
| Engineering | #general #dev #releases #incidents #alerts #standup | **Brain** · Orchestrator · Coder · Reviewer · Tester · Deploy · Standup relay (automation) · Alert triage |
| Marketing | #campaigns #content #social #analytics #brand | **Brain** · Content drafter · Social scheduler (automation) · Analytics digest · Brand reviewer |
| Research | #papers #experiments #notes #reading-group | **Brain** · Literature scout · Summariser · Experiment tracker · Citation checker |
| Product design | #design #feedback #specs #critique | **Brain** · Spec writer · Feedback synthesiser · Design critique · Figma watcher (automation) |
| Customer support | #support #escalations #enquiries #kb-updates | **Brain** · Support responder · Enquiry bot · Escalation router (automation) · KB gardener |

Every template bot ships with an eval set and a setup prompt in the house style.

---

## 14. Surfaces `[proto §09, §12]`

OpenUI (MIT) for bot-generated UI: `surface.render/update/event`; data binding through the MCP gateway; primitives, manythreads-aware components, and app components (`ImageGenerator`, `FormFlow`, `ReportBuilder`, **`Answer`**). Surfaces export to `pages/` by default and can be pinned to a channel.

---

## 15. Security and guardrails

Encryption at rest — envelope keys behind a `provider.kms` interface, Postgres-stored keys by default, OpenBao or a cloud KMS optional — TLS and mTLS. `guardrails-dlp` at `pre_egress`, the LLM gateway pre-call, and the MCP gateway; outcomes `allow`, `redact`, `require_approval`, `block`. Team namespace isolation, per-team egress proxy, gVisor, one runner per team. Two rules are enforced by the platform regardless of the prompt: a run may retain memory no wider than the narrowest source it read (§12); `bots/`, `TEAM.md`, `skills/`, `routines/` are never bot-writable (§7.2). The audit store records who asked, what was reached, **what was withheld**, and when — for every retrieval, answer, share and action — plus git history for the repo. A signed, content-blind **auditor export** covers a date range.

---

## 16. Onboarding journey `[proto §01]`

| Step | The person does | Required |
|---|---|---|
| 0 · Sign in | The first admin bootstraps with a password | Yes |
| 1 · Sign-in methods | Google Workspace / Microsoft 365 presets, password policy, optional OIDC | Yes |
| 2 · Models | Provider keys or local Ollama; guard preset; caps; optionally Claude Code / Codex sign-in | Yes |
| 3 · Code | GitHub App on repos; GitLab as a service user | No |
| 4 · Infrastructure | k8s manifest; one `sshd_config` line | No |
| 5 · Teams | Templates, names, invitations | ≥ 1 |
| 6 · Bots | Defaults pre-ticked (Brain always); in-cluster or runners | No |
| 7 · Servers | Optional runner install | No |
| 8 · Launch | Summary; one first goal per team; checklist | — |

The first goal for every team is a question to Brain, so the first thing a new team sees is a cited answer from their own material.

---

## 17. Licensing

| Component | Licence |
|---|---|
| Hermes Agent, Hindsight, LiteLLM, Activepieces core, OpenUI | MIT |
| step-ca | Apache-2.0 |
| OpenBao | MPL-2.0 |
| Teleport Community | AGPL-3.0 |
| Claude Code, Codex CLIs | Provider terms; the customer's own subscription, never redistributed |
| **manythreads** | **AGPL-3.0 + CLA** |

---

## 18. Estimate

Same method as before: unassisted engineer-weeks, then a per-phase automation factor blending to roughly 43% off the total.

| Phase | Unassisted EW | With Claude |
|---|---|---|
| Foundations, kernel, plugin SDK | 51 | 30 |
| Identity: OIDC presets, password, any-OIDC, break-glass | 8 | 4 |
| Core messaging: channels, threads inbox, boards, search, notifications | 54 | 30 |
| Files and team repo: git config+pages, Files storage, history/diff/restore, viewers, editor, apps, GitHub/GitLab push | 25 | 14 |
| Pages and rhythms (incl. Yjs editing) | 11 | 6 |
| Clients: React web, Tauri desktop, RN phones (reduced surface) | 50 | 30 |
| Teams, team templates; outcome templates as docs examples | 17 | 9 |
| Bots (`BOT.md`), handover, substrate, evals (on PR), runners, browser tool, org chart, `visibility`, roster | 73 | 40 |
| Conversations view; Brain template; `answer` tool/surface; person scoping; share masking | 14 | 8 |
| Approvals: gate + approval model, inbox | 3 | 2 |
| Self-setup | 12 | 7 |
| Workshop incl. terminal | 26 | 14 |
| LLM gateway: guards, keys, budgets, admin | 8 | 4 |
| Subscription runtimes (flag, off by default) | 3 | 2 |
| Connections, MCP gateway, Activepieces (team-only), code hosts, person connections, SSH/k8s brokers | 34 | 18 |
| Memory: Hindsight default + git mirror, partition test, source sync, knowledge | 32 | 17 |
| Email-driven bots | 12 | 7 |
| Surfaces (no VideoEditor, no Board) | 29 | 15 |
| Onboarding, first-goal flows, checklist | 14 | 8 |
| Security: guardrails, withheld record, A4/A5 enforcement, auditor export, encryption, pen test | 66 | 46 |
| Admin, ops, Helm, controller (no CRDs), backup, observability | 36 | 22 |
| Open source, docs, SDK, governance | 34 | 14 |
| QA | 15 | 8 |
| **Total** | **627** | **355** |

Plus 15% buffer: **~408 EW planned.** Eight people (≈ 6.5 delivering): **15–16 months to GA**, usable alpha at month 5, roughly **£1.1–1.2M** at London loaded cost.

### Milestones

| | Contents |
|---|---|
| **Spike — week 3** | `slack-compat` endpoint + a Hermes profile answering in a channel; the per-run tool-scoping question (§6.2, §19) |
| **M1 — month 5** | Kernel; sign-in; channels, threads, boards; Files on a team repo with history (config+pages in git, attachments in Files storage); `BOT.md` bots on Hermes via MCP; **conversation view and Brain with the Answer surface**; LLM gateway; **Hindsight (default) with the git memory mirror**; basic guardrails; append-only audit log (the console and auditor export are M3); Approvals inbox; onboarding; team templates; Compose self-host (five containers); React web + Tauri desktop; RN phone clients (alpha, reduced surface) |
| **M2 — month 10** | Self-setup, Workshop, connections + MCP gateway incl. first-party person connections, knowledge (source sync, chunk versions), email bots, pages and rhythms (Yjs editing; M1 ships plain `pages.write` so Brain's Save as page and routine outputs work), org chart, outcome templates as example repos, surfaces (primitives, FormFlow, ReportBuilder), orchestration substrate, runners, Helm without CRDs; subscription runtimes ship as a flag, off the critical path |
| **M3 — month 15–16** | ImageGenerator, terminal into sandbox (credentials revoked on open), plugin registry, admin console, audit and auditor export, pen test, App Store and Play, docs, SDKs |

### Cheaper shape

M1 only, four engineers, six months, roughly £250k. Ship it AGPL and see who self-hosts. M1 now includes Brain and Hindsight, so from five containers a self-hoster can ask their own team a question and get a cited answer.

---

## 19. First six weeks

1. **Week 1** — RN message-list benchmark (phone client). Kernel API and extension points. Teams, ACL, repo, memory-scope and conversation data model. `BOT.md` schema.
2. **Week 2** — Monorepo, CI, Compose skeleton, Postgres with RLS, a Postgres-backed job queue, LiteLLM, a git repo per team.
3. **Week 3** — `slack-compat` endpoint; a Hermes profile talking in a channel; the per-run tool-scoping spike question (§6.2). **Stop and evaluate.**
4. **Week 4** — Plugin kernel and capability broker; `channels`, `files` and `conversations` as the first plugins against the public SDK.
5. **Week 5** — `mcp-server` with task and `answer` tools; `runtime-rules`; a Hindsight bank per team plus the cross-team recall CI test; `describe_self`; Brain template; Approvals inbox.
6. **Week 6** — Guardrails on `pre_egress` and at the gateway; the `runtime-rules` counting-benchmark variant; Brain answering a question from the repo with citations.

---

## 20. Non-goals and open questions

**Non-goals:** pipeline designer; plugin marketplace with payments; voice/video; E2EE for channels with agents or for DMs; hand-building connectors Activepieces has; any second agent runtime; a browser extension (personal MCP keys cover the coding-tool case; revisit after GA); run-time loading of third-party JS client plugins (until a plugin marketplace exists); MemPalace and memory providers beyond Hindsight and the git mirror (`provider.memory` stays open to a community plugin); a non-linear `VideoEditor` surface and a separate `Board` surface (duplicates the Boards plugin); Memory Exchange as a subsystem (a digest is now a page share, §6.4); Google Docs/Sheets/Slides live editing inside manythreads (link preview only, §5.2); Kubernetes CRDs for `Team`/`Bot`/`Connection`/`Environment` (a DB-reading controller replaces them); `board_change`/`connection_event` as separate trigger types (merged into task events and `webhook`); `visibility: folder` on a bot (undefined scope; `team`/`workspace` cover it).

**Open:** whether Brain should be allowed `person:*` on mail by default; until decided, the build default is opt-in per person.

---

## Appendix — document map

| File | Role |
|---|---|
| `SPEC-FINAL.md` | This document |
| `mockups-all.html` | The complete prototype, twelve sections; §12 is conversations and Brain |
| `BUILDABILITY-REVIEW.md` | Why v1.4 differs from v1.3; its Part C prototype edits are pending |
| `CABINET-REVIEW.md`, `HEYBRAIN-REVIEW.md` | Teardowns; superseded by §6.2, §6.3, §12 |
| `BOT-MODEL.md`, `BOT-SELF-SETUP.md`, `WORKSHOP.md` | Bot rationale (pre-v1.2 mode language superseded by §7.3) |
| `SURFACES.md`, `CONNECTIONS.md`, `SHARED-REPOS-AND-LLM-GATEWAY.md`, `DEPLOY-k3s.md`, `PLUGIN-COMPOSITION.md` | Component rationale |
| `PLAN-v2.md`, `PLAN-v3.md` | Estimate method; orchestration rationale |
