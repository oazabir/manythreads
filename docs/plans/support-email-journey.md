# The support-email journey — a customer-support bot answering mail from a knowledge base

**Status:** plan, not started. **Tracked in `PLAN.md` as P7-11 and P8-28 … P8-36**, in phase 7 (the setup and the test) and
phase 8 (everything else) — this document is the detail behind those rows, and the phase table is the source of truth
for what is planned to be built.
**Shape:** a vertical slice of PLAN phase 8 (P8-01, P8-07, P8-08, P8-09, P8-10, P8-12) — the smallest honest version of the
story in SPEC §13 and PLAN's phase-8 goal ("two email bots work end to end").
**Proved by:** one Playwright journey spec (`e2e/email/support-journey.spec.ts`) and one screenshot journey
(`e2e/screens/task.p8-email.shots.ts`), plus vitest suites for every new piece.

---

## 0. The words used here

A reader who has not read `PLAN.md` or the specification should still be able to follow this document.

- **A bot** — a program that joins a team's channels and answers. What it may do, and when it wakes up, is written in
  one file: its **definition**, `bots/<slug>/BOT.md` in the **team repo** (the team's git repository). The file's
  frontmatter holds the settings; the prose under it is the bot's instructions.
- **A run** — one turn of a bot: it wakes, reads, calls tools, replies, and the turn is recorded as a **run row**.
- **A trigger** — the rule in the definition that says when the bot wakes up ("when someone writes `@it` in
  `#support-inbox`", "when a mail arrives on the mail connection").
- **A tool** — one thing a bot's model may ask the platform to do ("post a message", "search the knowledge base",
  "send a mail"). A **grant** is the row that says a particular bot may call a particular tool; the **broker** is the
  gate in the kernel that checks that row before the call runs.
- **The MCP gateway** — the one endpoint a bot's model calls to use its tools, one per run, so every call can be
  attributed to the bot and to the person who asked.
- **A connection** — a team's link to an outside service (here: a mailbox). It carries **connection tools** (`email.send`
  and friends), and a bot may hold them only if its definition asks for them.
- **A knowledge base** — a named folder of documents a bot may read; the files are converted to text and indexed, so a
  search returns passages with their source. A **base** is short for it.
- **A persona** — one of the seven seeded people of the demo workspace (Omar, Sameera, …); the tests act as them.
- **The outbox** — the queue of events written in the same transaction as the change that caused them.
- **RLS (row-level security)** — the database rules that decide which rows a caller may see, so a bot never sees another
  team's mail.
- **A delegation** — one bot waking another by naming it with `@its-slug`, allowed only when the naming bot's
  definition lists the target.

---

## 1. The story the test tells

One test tells the whole story, in this order. Every step is asserted; nothing is asserted on a mock.

| # | What happens | Asserted by |
|---|---|---|
| 1 | Omar (workspace admin) opens the Bots page and starts a **customer-support bot**: the definition is a new `bots/customer-support/BOT.md` in the team repo. | one commit by Omar in the repo history; the roster shows the bot |
| 2 | He writes the behaviour in BOT.md: the body (the prose the runtime uses as `SOUL.md`), the `mention` trigger scoped to `#support-inbox`, `knowledge.search` + `messages.post`, the base `manuals` with `answer_only_from`, and `handover.mayTag: [support-email]`. | the file in the repo; the loader's row (`status='active'`, triggers, native, may_tag) |
| 3 | He configures the **knowledge base**: uploads three files of different formats (a PDF manual, a Markdown FAQ, a CSV price list) into the base's folder. | the upload route's answers; the converted markdown in `knowledge/manuals/` in the team repo (so the **Files** tree shows it); `app.knowledge_documents` rows with a content hash; `app.knowledge_chunks` rows |
| 4 | He **tests** it: a question in the bot's own conversation; the bot answers from the base and cites the passage. | the answer message in the bot's conversation; the citation names the chunk and its version; the run row is `done` |
| 5 | He **deploys**: one action that commits the definition, activates the base and enables the mail connection. | three outcomes reported by the action; the bot's row is `active`; the base is `active`; the connection is `enabled` |
| 6 | The test pushes a customer email into the **dummy mail connector**. | the connector's mailbox row (inbound); one run with `trigger='inbox'` |
| 7 | The **support-email bot** posts the email into `#support-inbox` and tags `@customer-support`. | the message in the channel, authored by the support-email bot, naming the customer and the subject; the mention is in the body; the customer-support bot's run exists |
| 8 | The **customer-support bot** searches the base, answers from it, and (in the answering case) tags `@support-email`; in the other case it escalates to a person instead. | the reply in the thread; the `knowledge.search` tool call in the run's source log; the answer's citation; the escalation: an Approvals row (or a `role:support-agent` mention) and **no** reply to the customer |
| 9 | The support-email bot, mentioned, sends the reply **back through the connector**. | an **outbound** row in the connector's mailbox, addressed to the customer, carrying the answer; the run is `done` |
| 10 | The whole journey is screenshotted. | `temp/screenshots/p8-email-*.png` + the gallery `temp/screenshots/index.html` |

The escalation branch (step 8) is a second test in the same spec, not a flag in the first: one journey answers, one
journey escalates, and only the first one ends with mail in the customer's inbox.

---

## 2. Decisions (taken, so the work does not re-open them)

**D1 · Scope.** Build the real thing, minimum: a `connections` plugin (with a dummy mail transport), a `knowledge`
plugin, the `inbox` trigger, the two bots, the bot page's Knowledge tab, and the journey test. **Not** in this slice:
real IMAP/Gmail/OAuth, Activepieces, person connections, the memory inbox, memory sharing, analytics, `webhooks`,
vector embeddings (lexical retrieval only — see D4), a new top-level screen.

**D2 · "Deploy" means three things, one action.** The bot page's **Deploy** button (a) commits the definition through
the one repo writer, (b) activates the knowledge base (its documents are converted and indexed), (c) enables the mail
connection. It reports each of the three, and refuses when one of them fails. It is *not* a new lifecycle state: the
bot's liveness is the loader's (`bots.status`), the base's is `knowledge_bases.status`, the connection's is
`connections.status`. A "deploy" that changed nothing would be a button that lies.

**D3 · Test shape.** A Playwright spec on its own stack (the repo's rule: a spec that writes data gets its own
stack) + vitest for the plugin halves + a live-shots file for the gallery. Three new visual baselines, because three
screens change: the bot page's **Knowledge tab** (`bots/knowledge`), its **Deploy** result (`bots/deploy`) and the
**Test** action (`bots/test`). The journey itself is a flow, not a screen, so it gets a spec and a gallery, not a
baseline.

**D4 · A knowledge base is a folder in the team repo, and its documents are text.** `knowledge/<base>/` is already a
reserved repo layout dir (`REPO_LAYOUT_DIRS`) and already visible in the **Files** tree. The uploaded originals (PDF,
DOCX, CSV) live in the platform's blob storage; the **converted** text is written into the repo folder as markdown
(`knowledge/<base>/<slug>.md`, with frontmatter: title, source name, sha256, version). Text-only repo, git-versioned
documents, Files-visible, and the repo is the truth (SPEC §12.4's "bases in `knowledge/<base>/sources.yaml`" shape,
with `sources.yaml` listing what was ingested).

**D5 · Retrieval is lexical for this slice.** `knowledge_chunks` carries `text` + `version` and a **nullable**
`embedding vector(768)`. Search is Postgres full text (`tsvector`, GIN) plus trigram for fuzzy titles; the vector path
exists but is only filled when the workspace has an `embed` alias configured. A base indexed without embeddings is
searchable, and the answer says so ("lexical only — this workspace has no embedding model"). Embeddings are never
required for the journey to pass.

**D6 · The mail connector is a transport interface with a dummy implementation.**
`EmailTransport { list, fetch, send, draft }`. The dummy keeps its mailbox in the database (`app.connection_messages`)
and takes mail through an admin-only door (`POST /api/teams/:slug/connections/:conn/mail`). A real IMAP transport
implements the same interface later; the dummy is the one the test pushes mail into ("a dummy email connector").

**D7 · The customer of a reply is platform-owned, not model-chosen.** `email.send` without a `to` answers the mail the
run's thread came from: the connector links the inbound mail to the channel message the support-email bot posted, so
the reply's recipient is the address the platform received, not a string the model copied out of a message body.

**D8 · The two bots talk by `@mention`, through the platform's existing delegation path.** The support-email bot's
`handover.mayTag: [customer-support]` and the customer-support bot's `handover.mayTag: [support-email]` are what make
the tag work (`tasks.handoff` grant constraints → `mayTagSlugs` → `routeDelegation`). No new bot-to-bot protocol.

**D9 · Sending to a customer waits for a person.** `email.send` is granted with `needs_approval` (SPEC §13, §7.3), so
the journey has Sameera (`role:support-agent`) approve the reply in the Approvals inbox. The approval is the platform's
existing `grant` source — no new approval path.

---

## 3. What exists today (the seams this slice uses)

| Existing | Used for |
|---|---|
| The bots loader (`packages/plugins/bots/src/loader.ts`) — strict `BOT.md` parse, `bots.bot.loaded` / `bots.bot.invalid`, compiled `capabilities.native` grants, `handover.mayTag` → `tasks.handoff` constraints | the definition, the invalid banner, the compiled allowlist |
| The bot page (`clients/web/src/screens/bots/*`) — 14 tabs, draft state, Save = one `repo/commit` as the person | the setup journey's first half (Identity/Behaviour/Triggers/Capabilities/Knowledge tabs) |
| The `Knowledge` tab (`tabs.tsx:251`) — edits the `knowledge:` bases list | the base names; the slice adds the documents behind them |
| The run path (`packages/plugins/runtime-hermes/*`) — router (`matchTrigger`), delegation (`routeDelegation`), run job, `meta.runId` on a run's post, approvals hold/resume | the whole bot-to-bot conversation |
| The MCP gateway (`packages/plugins/gateway-mcp/*`) — per-run endpoint, `tools/list` at grant level, `tools/call` authorized with the call's own arguments, `run_source_log` per hit | how the model calls `knowledge.search` and `email.send` |
| The broker (`packages/kernel/src/capabilities/broker.ts`) — grant lookup, `needsApproval`, destructive refusal, path guard | connection tools are capabilities; nothing new to teach it |
| `provider.knowledge` — a **declared but unimplemented** provider kind (`packages/sdk/src/types.ts:41`) | the knowledge plugin's seam |
| The channels provider (`ctx.providers.get('messages')`) — one posting path for a person and a bot, `meta.runId` | the mail post, the replies, the mentions |
| The `repo` provider — the one git writer, `blob`/`commit`/`tree` | writing the converted knowledge documents, committing BOT.md |
| The storage provider (`ctx.providers.get('storage')`) — the blob store the Files screen uses | the uploaded originals |
| The approvals plugin + `ctx.providers.get('approvals')` | `email.send` waiting for a person |
| The Files tree (`packages/plugins/files/src/tree.ts`) — the repo's folders and the channel attachment folders | the base's folder is visible to a person |
| `tools/fake-llm` + the stand-in Hermes in `runtime-hermes/test/run.test.ts` | the scripted "model" for the journey (no provider key needed) |

---

## 4. What is new

### 4.1 `packages/plugins/connections` (new plugin)

Owns connections, their grants, the mail transport and the `inbox` watch.

* `migrations/0001_connections.sql` — `app.connections`, `app.connection_grants`, `app.connection_messages`.
* `src/email/transport.ts` — the `EmailTransport` interface; `src/email/dummy.ts` — the dummy (mailbox in the database);
  `src/email/tools.ts` — the `email.read` / `email.draft` / `email.send` capability handlers.
* `src/watch.ts` — the `inbox-watch` job: poll, dedupe by thread, open one run per mail thread.
* `src/compile.ts` — on `bots.bot.loaded`, read the definition and write the connection grants (the plugin boundary
  rule: the bots loader does **not** write the connections plugin's tables).
* The `ToolSource` seam: SDK `packages/sdk/src/connections.ts` (`ToolSource { slug, capabilities(), call() }`), a new
  extension registry in `packages/kernel/src/plugins/registries.ts` (`toolSources`), and `ctx.toolSources` in the SDK —
  the gateway's `tools/list` asks the registry for the tools of the bot's connections, and `tools/call` dispatches to
  the owning source **after** the broker authorized the call.

### 4.2 `packages/plugins/knowledge` (new plugin)

Owns bases, documents, chunks and `knowledge.search`.

* `migrations/0001_knowledge.sql` — `app.knowledge_bases`, `app.knowledge_sources`, `app.knowledge_documents`,
  `app.knowledge_chunks`.
* `src/extract/` — **one** extractor interface (`extract(bytes, kind) → { text, metadata }`, bounded in size and time):
  Markdown/text, CSV, PDF (pdfjs **legacy** build, per MISTAKES). DOCX/XLSX/PPTX and the rest of PLAN P8-16 are later;
  the interface is written so they slot in.
* `src/ingest.ts` — the upload route → extractor → converted markdown → the one repo writer → chunks + hash + version.
* `src/search.ts` — the real `knowledge.search`: lexical (tsvector + trigram) over the chunks of the **granted bases**,
  citations carrying the chunk version. The stub in `gateway-mcp/src/catalog.ts` gives way to this plugin (the
  gateway's own comment says so: "when their plugins land they take the declaration over").
* `provider.knowledge` — the SDK's declared provider kind, implemented here.

### 4.3 The `inbox` trigger (in the connections plugin; the runtime gains the case)

* `BotTrigger` already has `{ type: 'inbox', connection, folder, filter }` (shared) and `BotRunTrigger` already has
  `'inbox'`; the runtime's `RunPayload.trigger` (a local enum in `run-job.ts:38`) gains `'inbox'`, and `replyRootId`
  becomes optional for it (the thread's root is the message the bot posts, which does not exist yet when the run
  starts).
* The watch job: for every enabled mail connection with an `inbox` trigger, list what is new since the cursor, skip
  what it has seen (dedupe by `connection + thread_key + message id`), and for the first mail of a thread start **one**
  run whose prompt carries the mail (from, to, subject, body) and whose target channel is the bot's `placement.channel`
  (or the trigger's configured channel).
* The connector links the inbound mail to the channel message the bot posts: it subscribes to `channel.message.posted`,
  reads `meta.runId`, and when that run is one of its inbox runs, records `root_message_id` for the mail's thread.
  That link is what D7 needs.

### 4.4 The bot page: Knowledge tab, Test, Deploy

* The **Knowledge** tab gains, per base: the documents (name, kind, size, hash, version, indexed/pending/failed with
  the reason), an **Upload** control, a **Re-sync** action, and a **Test** box.
* **Test** posts the question into the bot's own conversation (the `conversation` trigger) as the signed-in person and
  shows the answer with its citations. No new machinery: the conversations plugin and `answer.post` already do this.
* **Deploy** does D2's three steps and reports each.
* The Capabilities tab already edits `capabilities.connections`; it gains a picker of the team's connections and marks
  which tools wait for a person.
* No new sidebar entry (the sidebar contract is fixed): the base's files are reached through the **Files** tree's
  `knowledge/` folder, and the base itself through the bot page.

### 4.5 The two bots (templates)

* `templates/customer-support/bots/support-email/BOT.md` — `inbox` trigger on connection `support-mail`,
  `messages.post`, `email.read`, `email.send` (needs approval), `handover.mayTag: [customer-support]`. Its body says:
  post the mail into `#support-inbox` with the sender, the subject and the text, then tag `@customer-support`; when
  mentioned with a resolved answer, send it to the customer.
* `templates/customer-support/bots/customer-support/BOT.md` — `mention` trigger in `#support-inbox`,
  `knowledge.search` on base `manuals` (`answer_only_from`), `messages.post`, `handover.mayTag: [support-email]`,
  `handover.toPerson: [role:support-agent]`. Its body says: search the base, quote the section; if nothing supports
  an answer, hand it to a person and do not answer the customer; when the answer is ready, tag `@support-email`.
* `templates/customer-support/template.yaml` — the `#support-inbox` channel and the two bots.
* Both ship with an eval set (`bots/<slug>/evals/*.yaml`) in the house style, for when the eval harness (P7-08) lands.

---

## 5. Data model

All tables: `uuid` PK `DEFAULT uuidv7()`, `timestamptz`, `text` never varchar, every FK indexed, RLS enabled and
forced, a policy per operation, and the read policies hoisted (no per-row function call in a read policy — the RLS
harness `findPerRowPolicyCalls` fails the build).

```
app.connections        (id, workspace_id, team_id, slug, kind, scope, owner_id, status, environment,
                        expires_at, secret_id, created_at)            unique(team_id, slug)
app.connection_grants (id, connection_id, actor_id, tool, needs_approval, constraints)  unique(actor_id, tool, connection_id)
app.connection_messages(id, connection_id, direction, thread_key, message_id, from_address, to_address,
                        subject, body, sent_at)                       -- the dummy's mailbox: in and out
app.knowledge_bases    (id, workspace_id, team_id, slug, name, status, created_at)   unique(team_id, slug)
app.knowledge_sources  (id, base_id, kind, ref, cadence, status, last_synced_at, error)
app.knowledge_documents(id, base_id, source_id, path, name, mime, sha256, size, version, text, indexed_at)
app.knowledge_chunks   (id, document_id, base_id, ordinal, text, version, embedding vector(768) null)
```

* RLS: `connections` readable by the team's readers, written by workspace admins; `connection_grants` readable by the
  bot's team and admins; `connection_messages` readable by the team (the dummy's inbound door is admin-only);
  `knowledge_*` readable by the team's readers, written by the platform (system) and by the ingest route as the
  uploading person.
* The `knowledge_chunks` text is bounded (2,000 characters a chunk) — a claim that a search operator is LEAKPROOF
  needs the input bounded by a constraint, not by application code (MISTAKES, P3 review).
* The `embedding` column stays nullable and is only filled when an `embed` alias exists; the vector index is created
  only then (HNSW), so a deployment without embeddings carries no dead index.

---

## 6. Tasks

The rows below are the detail behind the PLAN.md rows: **P7-11** and **P8-28 … P8-36** are the work this slice adds;
the rows marked *existing* are PLAN tasks this slice leans on and does not re-specify.

### Group A — the connections plugin

| PLAN ID | Task | Where | Done when |
|---|---|---|---|
| P8-01 *existing* | Schema triple: `connections`, `connection_grants`, `connection_messages` + mappers + shared entities/API + RLS + the enum map + schema-compat snapshots + `docs/plugins/connections.md` | `packages/plugins/connections`, `packages/shared` | the migration applies, the RLS suite passes, the plans are hoisted |
| P8-28 | The `ToolSource` seam: the SDK interface, the kernel registry, `ctx.toolSources`, and the gateway's `tools/list` / `tools/call` support for a source's tools (at grant level for a listing, with the call's own arguments for a call); the connections plugin compiling `capabilities.connections` from the definition on `bots.bot.loaded` into `connection_grants` + the broker's `capability_grants` (constraints `{ connection }`), and refusing a tool that is also in `capabilities.native` (the bots loader refuses it too, with a field path) | `packages/sdk`, `packages/kernel`, `packages/plugins/gateway-mcp`, `packages/plugins/connections/src/compile.ts`, `packages/plugins/bots/src/loader.ts` | a bot with a connection grant is offered the connection's tools, and a call without the grant is refused (`no grant for "email.send"`); a definition with both is invalid with the field named; a definition with only the connection gets exactly the tools it named |
| P8-29 | The `EmailTransport` interface + the **dummy** transport (mailbox in the database) + the admin-only inbound door + the `email.read` / `email.draft` / `email.send` handlers, with `email.send` resolving the recipient from the run's mail context (D7) | `packages/plugins/connections/src/email` | a mail pushed into the dummy is readable by `email.read`; `email.send` from a run whose thread has a mail answers that mail's address; a run with no mail context and no `to` is refused |
| P8-30 | The `inbox-watch` job: poll, dedupe by thread, one run per mail thread, the prompt carries the mail, the link from the mail to the bot's post (via `meta.runId`); the runtime's run payload takes `inbox` and the reply root becomes optional | `packages/plugins/connections/src/watch.ts`, `packages/plugins/runtime-hermes/src/run-job.ts` | one mail → one run; a second mail in the same thread → the same thread; a mail that arrives twice → one run |

### Group B — the knowledge plugin

| PLAN ID | Task | Where | Done when |
|---|---|---|---|
| P8-07 *existing* | Schema triple: `knowledge_bases`, `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` + mappers + shared entities/API + RLS + `docs/plugins/knowledge.md` | `packages/plugins/knowledge`, `packages/shared` | as P8-01 |
| P8-31 | Ingestion: the upload route (streamed, its own context, slots, idle + total deadlines, size cap) → extract → converted markdown → the one repo writer → document + chunks (hash, version); the base is a folder in the team repo, so it is in the Files tree and in git (D4) | `packages/plugins/knowledge/src/ingest.ts`, `packages/plugins/files` | an uploaded PDF appears as `knowledge/manuals/<slug>.md` in the repo and in the Files tree, and its chunks are searchable |
| P8-32 | The extractor interface + Markdown/text, CSV and PDF extractors, bounded in size and time, with a hostile-input timing test beside each | `packages/plugins/knowledge/src/extract` | a 25 MB PDF and a 40,000-character line are refused or bounded, in linear time |
| P8-08 *existing* | The real `knowledge.search`: lexical + trigram, scoped to the **granted** bases (the loader compiles `knowledge:` into the grant's constraints), citations with the chunk version; the gateway's stub gives way to this plugin; `answer_only_from` blocks an unsupported answer with the reason | `packages/plugins/knowledge/src/search.ts`, `packages/plugins/gateway-mcp` | a search from a bot with base `manuals` never returns a passage from another base; the stub's "no bases configured" is gone; the unsupported question produces no invented passage |

### Group C — the setup surface

| PLAN ID | Task | Where | Done when |
|---|---|---|---|
| P7-11 | The bot page's **Test** action: one question in the bot's own conversation as the signed-in person, the answer with its citations, every write intercepted and badged | `clients/web/src/screens/bots`, `packages/plugins/workshop` | the journey's step 4 is one box and one real run |
| P8-33 | The bot page's **Knowledge** tab: per base — the documents, upload, re-sync, and the base's state; plus the Capabilities tab's connection picker, the tools of each connection and the "waits for a person" mark | `clients/web/src/screens/bots` | the journey's step 3 is one screen; a lead can grant `email.send` and see that it needs approval |
| P8-34 | The bot page's **Deploy** action: commit the definition, activate the base, enable the connection — three outcomes reported, one refusal when one fails | `clients/web/src/screens/bots` | the journey's step 5 is one click with three reported outcomes |

### Group D — the bots and the seed

| PLAN ID | Task | Where | Done when |
|---|---|---|---|
| P8-35 | The two `BOT.md`s + evals + the template's `#support-inbox` channel and bot list | `templates/customer-support` | the loader loads both; the support-email bot's `inbox` trigger and the customer-support bot's `mention` trigger are compiled |
| P8-12 *existing* | Seed v8 (slice): the `support-mail` connection (disabled), the `manuals` base, three documents, the `#support-inbox` channel | `e2e/fixtures`, `packages/test-utils` | a seeded stack has the base indexed and the connection present but disabled |

### Group E — the journey

| PLAN ID | Task | Where | Done when |
|---|---|---|---|
| P8-36 | The scripted model (`e2e/fixtures/fake-hermes.mjs` — reads the prompt on stdin, calls the run's MCP endpoint for the scripted tools, prints Hermes' `tool_use` / `tool_result` / `result` records), the e2e spec that tells the whole story (steps 1–9) plus the escalation branch, and the screenshot journey for the gallery (secrets redacted, no live token left behind) | `e2e/fixtures`, `e2e/email`, `e2e/screens` | the run's tool calls really go through the broker and the gateway (the source log proves it); the spec is green and the outbound mail is in the connector's mailbox; the gallery shows the setup, the base, the test, the deploy, the mail in the channel, the answer and the outbound mail |

---

## 7. The e2e scenario, in detail

* **Stack:** its own (`startStack({ MANYTHREADS_STACK_SEED: 'repo' })` plus the fake Hermes's env), because the journey
  commits to the team repo, posts in channels and moves a persona into a conversation — the repo rule that a spec
  which writes data gets its own stack (MISTAKES, P3-08 / P3 gate e2e).
* **Personas:** Omar (workspace admin — the only one who may *add* a bot, per the owner rule), Sameera
  (`role:support-agent` — the escalation target and the approver). The customer is an address, not a persona.
* **The model:** the fake Hermes, scripted per bot. The script is written by the test into a temp file the fake reads;
  the fake executes the tools for real through the run's MCP endpoint, so the broker, the gateway, `knowledge.search`
  and `email.send` are all real. The stand-in pattern is `runtime-hermes/test/run.test.ts`'s; the file names it as
  "the platform's half is what this file checks, and none of it needs a model".
* **The push:** `POST /api/teams/customer-support/connections/support-mail/mail` (admin) with the customer mail
  (from `customer@example.com`, subject "Where is my order?"). This is the dummy connector's delivery door — the same
  door a real provider would deliver through.
* **The waits:** every wait is a poll with a deadline on a *state* (a run row, a message, a mailbox row), never a
  sleep; a budget generous enough for a loaded CI box (the repo's rule: a wait whose subject only gets slower under
  load gets the generous budget).
* **The escalations/approvals:** the reply's `email.send` waits for a person — the test approves it as Sameera through
  the approvals API (or clicks Approve in the UI, if the journey is a browser journey) and then asserts the outbound
  mail. The escalation branch asserts **no** outbound mail.

Assertions that must be exact, not approximate: the outbound mail's `to` is the customer's address, its body carries
the answer's sentence, exactly one outbound mail exists, exactly one run per bot, and no run of the customer-support
bot started before the support-email bot's post.

---

## 8. The screenshot journey

`e2e/screens/task.p8-email.shots.ts` (the `*.shots.ts` convention, so `pnpm e2e` never picks it up), run on the devbox
against the live site with the one-off password from `tools/devbox/task-shots.sh`, the pictures synced down into
`temp/screenshots/` and the gallery rebuilt:

1. the bot page's Knowledge tab (the base, the three documents, the converted file);
2. the bot's test question and the answer with its citation;
3. the Deploy result (three outcomes);
4. the mail in `#support-inbox` (the bot's post and the mention);
5. the customer-support bot's answer, and the approval card;
6. the outbound mail in the connector's mailbox.

Rules that apply (MISTAKES): no secret in a picture; a token is redacted and revoked in the same run; a screenshot of
an inbox must not open the thread first; the gallery is rebuilt over the whole folder in `afterAll`.

---

## 9. Gates

* `pnpm lint` and `pnpm typecheck` clean for every touched package (Windows: `tools/devbox/Check.ps1`; the devbox is
  the Linux gate — `tools/devbox/remote-gates.sh`, which runs vitest with `CI=true`).
* `pnpm test` (vitest): the new plugins' unit + RLS suites, the loader's new assertions, the gateway's tool-source
  suite, the run job's `inbox` trigger case.
* `pnpm e2e` (Playwright): `e2e/email/support-journey.spec.ts` and the bots' own specs (the loader's compiled allowlist
  changed — the bots suite asserts the whole set, not a part of it).
* `pnpm test:schema-compat`: the new snapshots are **committed** (the phase-5 lesson: a snapshot that exists only on
  the devbox fails CI exactly where the devbox gate fails it).
* The devbox loop (Windows): edit here, `Sync-Up.ps1`, build/test/deploy there (`WINDOWS_DEV.md`); `Ship.ps1` run
  **plain** — no redirection, no `Tee-Object` (MISTAKES, P5-26).
* A phase-5-style evidence note in `docs/verification/` and a `STATUS.md` update when it lands.

---

## 10. Risks and the lessons that bite here

| Risk | The lesson (MISTAKES) that answers it |
|---|---|
| A migration that references a column that does not exist takes the whole suite down | read the referenced table's own definition first (`app.threads` is keyed by `root_message_id`); migrate with the smallest test first |
| An upload route that reads the body in a transaction pins a pooled connection | the files plugin's rules: slots, idle timeout, total deadline, `iterator({ destroyOnReturn: false })`, `node:http` for a streamed body in tests |
| A read policy that calls a function per row | hoist the team's readable ids once per statement; the RLS harness fails the build |
| The connector writing another plugin's table | the plugin boundary: the bots loader does not write `connection_grants`; the connections plugin reads the definition itself |
| A "deploy" that changes nothing | D2: three named outcomes, one refusal |
| The reply going to the wrong customer | D7: the platform owns the address |
| The bot answering without the base | `answer_only_from` + the grant's bases; the search answers with the reason |
| The knowledge plugin and the memory inbox both extracting text | one extractor interface (PLAN's phase-8 reflect prompt); the interface is written now, in `knowledge/src/extract`, and the memory inbox will use it |
| The e2e leaking into other specs | its own stack (the repo's rule, twice bitten) |
| A screenshot of the answer thread auto-opening and reading it | use `?tab=unread`/a fresh stack; a screenshot must not open the thread first |

---

## 11. Out of scope (and where it goes)

* Real IMAP / Gmail / Outlook / OAuth, Activepieces, person connections → PLAN P8-02, P8-03, P8-04.
* The rest of the extractors (DOCX, PPTX, XLSX, images, audio, `.eml`) → PLAN P8-16 (the interface is ready).
* Vector embeddings and the `embed` alias → the column and the HNSW index exist; filling them is a follow-up.
* The memory inbox, the email door, memory sharing, analytics → PLAN P8-14 … P8-27.
* The Workshop (Build/Rehearse/Live) and the eval harness → PLAN phase 7 (P7-05, P7-08). The slice's "Test" button is
  the smallest honest version of Rehearse: a real run, in the bot's own conversation, with the answer shown.
* `webhooks` and the `routine` / `task_assigned` triggers → later phases; the `inbox` trigger is the first
  non-channel trigger, so the runtime's trigger handling is generalised once, here.

---

## 12. Acceptance criteria

The use case, sentence by sentence, and where it is proved:

1. *"a support-email bot is connected to email to receive support emails"* → P8-28, P8-29, P8-35; the `inbox` trigger
   and the `support-mail` connection (the dummy transport) — `e2e/email/support-journey.spec.ts`.
2. *"it posts the emails in a support-inbox channel"* → the run's post by the support-email bot in `#support-inbox`;
   asserted on the message's author and channel.
3. *"tags customer-support bot to deal with it"* → the mention in the body, the delegation run, `mayTag` (D8).
4. *"customer-support bot processes the request, sometimes answers it based on its knowledge, sometimes escalates to a
   human"* → the answering branch (a `knowledge.search` hit and a cited answer) and the escalation branch (a person
   named, **no** reply to the customer) — two tests.
5. *"when customer-support bot resolves the query, it tags support-email bot to reply to the customer"* → the second
   mention, the second delegation run, the `email.send` call.
6. *"customer-support bot is given a knowledge base, which is a collection of files in various format converted, stored
   in Files"* → P8-31, P8-32: PDF + Markdown + CSV in, markdown out in `knowledge/manuals/` (the Files tree), chunks
   indexed.
7. *"test and screenshot the journey where a team member starts setting up a customer-support bot, puts the bot behavior
   in BOT.md"* → P7-11, P8-33, P8-36: Omar's setup in the browser, the body in BOT.md, the pictures.
8. *"configures a knowledge base by uploading files into a specific folder"* → the upload + the base's folder.
9. *"then tests it to check if the BOT.md is correct and the response from the customer-bot is correct"* → the Test box
   (a real run + the answer + its citations) and the loader's invalid banner (a broken BOT.md is refused with the field
   named — an existing feature, asserted in the same spec).
10. *"once happy, deploys the bot"* → P8-34: the Deploy action and its three outcomes.
11. *"a test pushes an email to support-email bot via email connector (a dummy email connector)"* → the admin mail door
    on the dummy.
12. *"then expect a response coming from support-email bot to the email connector once customer-support bot responds"*
    → the outbound row in the connector's mailbox, addressed to the customer, after the approval.
