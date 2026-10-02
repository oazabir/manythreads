# Phase 3 retro · Channels, threads and direct messages

## 1. Reflect and refactor (P3-00)

Done before any channel or message table exists (PLAN Phase 3 section 0; the carried findings are in `docs/retro/phase-2.md` sections 9 and 10).

### RLS cost: hoisted visibility sets

`app.can()` inside a policy is a per-row `STABLE` plpgsql call. Kernel migration `0011_hoisted_rls.sql` adds `app.readable_team_ids(permission)`,
`app.member_team_ids(permission)`, `app.acl_grant_ids(resource_type, permission)` and `app.held_role_ids()` (definer functions owned by `manythreads_system`, caller from `app.actor()`,
checked with `lookup_*` as in 0006; guests and suspended people get `{}`) and rewrites every read policy that called a per-row helper to `team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`:
`teams`, `team_members`, `events`, `capability_grants`, `entity_links`, `scoped_kv`, `invitations`, `acl_entries` (kernel), `team_role_tags` (teams plugin `0003`), `stub_resources` (test-kernel `0003`).
Semantics did not change: the whole existing RLS suite passed untouched, and `kernel/test/rls/hoisted.test.ts` compares each set with `app.can_in_team` / `is_team_member` / `team_role` / `app.can` for
all seven personas, every permission and every grant kind. `app.can()` stays for single-row checks.

Benchmark (`pnpm --filter @manythreads/tools-bench bench:rls`: 300,000 `stub_resources` over three teams, FORCE RLS, unscoped `SELECT count(*)`, best of 3, Postgres 19 beta in the dev container):

| caller | before (per-row `can_in_team OR can`) | with sets, bare `app.is_system()` | with sets, `(SELECT app.is_system())` (shipped) |
|---|---|---|---|
| Nadia (member of Engineering, 100,000 visible) | 96.1 s (77 s in the P2 gate) | 0.51 s | **55 ms** |
| Lena (guest, sees nothing) | 94.3 s (74 s) | 0.49 s | **50 ms** |
| Omar (owner, 300,000 visible) | 27.5 s (21 s) | 0.48 s | **46 ms** |
| newest 50 of Engineering as Lena (denied, scans everything) | 32.8 s (24.5 s) | 0.2 s | 45 ms |

(Before: re-measured with `--legacy`, which reinstalls the old policy, while another suite was running, hence slower than the P2 numbers. The budget is 2 s; the script exits 1 above it.)
The P2 prototype's 0.48 s was the middle column: the sets removed the per-row team lookups, and wrapping the remaining `app.is_system()` in `(SELECT ...)` removed the last per-row call, a further 10x.
No covering index was needed. Lessons are in `MISTAKES.md` and `docs/plugins/README.md` ("Visibility sets"): the array is fixed at statement start (`INSERT ... RETURNING` of a row the statement itself makes visible needs a
branch that does not look it up, as `teams_select` does for admins), and every caller-dependent call in a policy goes in `(SELECT ...)`.

Enforcement: `findPerRowPolicyCalls(client, table)` in `@manythreads/test-utils` runs `EXPLAIN (VERBOSE, FORMAT JSON) SELECT count(*)` as `manythreads_app` and reports any `app.can` / `can_in_team` / `is_team_member` / `team_role` / `has_role`
in a scan, join or index condition outside an InitPlan. The RLS harness runs it for **every** table (allowlist `PER_ROW_ALLOWLIST` in `harness.test.ts`, with a reason per entry; empty today, a stale entry fails)
and proves the check catches a per-row policy and accepts the hoisted form. Workspace-level policies that still call `app.workspace_role()` / `app.is_workspace_admin()` per row (`people`, `roles`, `workspace_members`, ...) are
bounded by headcount and not covered; hoist them the same way if one ever grows.

Private channels and DMs (visibility per membership row, not per team): documented as the same idiom with a plugin-owned helper returning the visible ids; the channels plugin adds `app.visible_channel_ids()` in its first migration (docs/plugins/README.md).

### Plugin duplicates removed (SDK helpers)

`ctx.db.getOneOrCreate(tx, input)` (the kernel's `DO SELECT` helper behind the plugin transaction guard), `ctx.audit.emit(tx, event)` (`events.emit` with `schemaVersion` 1 and the transaction's workspace filled in) and
`ctx.templates.list()/get(id)` (kernel `loadTemplates`, cached). `packages/plugins/teams` uses all three; its `templates.ts` loader, the hand-written get-or-create statement and the `emit` wrapper are deleted (and its `yaml` dependency).
Tests: `kernel/test/plugins/sdk-helpers.test.ts` (twenty concurrent get-or-create callers converge on one row; gating; cache) plus the unchanged teams API suite.

### Last-lead guard

`0012_last_lead_guard.sql`: a trigger on `team_members` refuses (check_violation, 409 in the API) removing, demoting or moving the last `lead` of a team, unless the caller is a workspace owner or admin or the system role;
a team or workspace being deleted is exempt, concurrent demotions deadlock instead of both succeeding. Definer caller check by `lookup_workspace_role()` and `session_user`, not the `is_*` helpers (MISTAKES). Tests: `kernel/test/rls/last-lead.test.ts`, `teams-api.test.ts` ("last-lead guard").
Behaviour change for clients: a lead leaving a team with no other lead now gets 409 "a team must keep at least one lead"; the team settings screen should offer "make someone else lead first".

### Job worker host

`startServer` now starts workers (`jobWorkers`, default on; `MANYTHREADS_JOB_WORKERS=0` off) for the kernel's `kms.rewrap` queue and for each queue a plugin registers with `ctx.jobs.register(queue, handler, options?)`.
Decision: a new extension point `job.register` (one entry in the manifest enum) rather than reusing `trigger.register`, whose meaning is bot triggers. It is declared in `extends` because a plugin handler runs as the **system actor**,
one transaction per attempt scoped to `payload.workspaceId`, exactly the privilege `provider.identity` is gated for; queues must be named `<plugin>.<name>`, so two plugins cannot collide. This adds to the list in SPEC-FINAL section 3: the spec text needs a line (not edited here).
`ctx.jobs.enqueue(tx, queue, payload, { runAt, dedupeKey })` enqueues in the caller's transaction. Admin CLI `admin kms-rewrap` enqueues the rewrap (deduplicated while one waits or runs); `MANYTHREADS_KMS_PREVIOUS_KEYS` (comma-separated base64) lets the
process Kms unwrap the old key during rotation (before, only a hand-built Kms could, so the job could not have worked). Tests: `server/test/job-host.test.ts` (plugin job as system in the right workspace, failing attempt rolls back and is retried, a secret moves from the old key to the new one through the real worker), `admin-cli.test.ts`, `kms.test.ts`.
Open: the Helm chart does not template `MANYTHREADS_KMS_PREVIOUS_KEYS` yet (docs/deploy.md says so); a web-only replica can set `MANYTHREADS_JOB_WORKERS=0`.

### Zod enum and SQL CHECK

`kernel/test/schema-enums.test.ts` replaces the text-regex comparison that lived in `shared/test/common.test.ts`: it reads every `CHECK (col IN (...))` of the migrated database (`pg_get_constraintdef`, kernel plus the teams and test-kernel plugins),
requires each to be in the table-to-enum map (`ENUM_COLUMNS`: eleven columns today, including `workspace_members.role`, `team_members.role`, `people.status`) and compares values and order with the `z.enum`. A migration that adds an enum column without
listing its Zod schema fails the test, naming the column; the channels, messages and tasks plugins add their rows to the map.

### Not done, carried to later tasks

- Typed API client and settings frame (the other two prompts of section 0): answered in `docs/retro/phase-2.md` section 10; unchanged.
- `TEAM.md` still waits in `team_pending_files` for phase 4 (channels from `team.template.applied` are P3-05).

## 2. Files and search (P3-08, P3-10)

### Attachments (P3-08)

`files` plugin (`docs/plugins/files.md`): table `files` (RLS: the hoisted channel set, the team set for a team file), raw-stream upload (`POST /api/channels/:id/files`), download that re-reads the row
through RLS on every request, delete, entity-link resolver, `message.meta.attachments` (ids; cards resolved on read). Decisions: ids in `meta`, not an entity link (one batched `SELECT` per page of messages);
the body of an upload is the file (no multipart: no new dependency, progress works with `XMLHttpRequest`); a second `report.pdf` becomes `report (2).pdf`; `folder_path` is written once, so the phase-4
tree must follow `channel_id`. Awkward: plugin routes had no way to take or give a stream, so the SDK got `rawBody` routes, streamed responses and `ctx.providers.get(kind)`; the first version let Fastify's
text parser eat `text/plain` uploads (empty blobs) and a stopped read destroyed the socket before the 413 could be sent (both in `MISTAKES.md`, both under test). An upload holds one pooled connection for its duration
(the route's transaction is open while bytes arrive); the 60 per minute rate limit and the 50 MB cap keep that modest, and a streaming design that commits the row after the bytes is a later option.

### Search under row level security (P3-10)

The finding of `bench-phase-1.md` ("trigram search is not reliably index-driven under RLS") had a precise cause: the policy is a security barrier, and the planner will not hand a non-`LEAKPROOF`
operator to an index behind it. pg_trgm's operators are not marked, so every search was a sequential scan with the GIN index present (2.3 s at 300,000 messages, unchanged by `enable_seqscan = off`).
Marking `word_similarity_op`, `word_similarity_commutator_op` and `similarity_op` `LEAKPROOF` in the search migration (superuser; the owner is one in compose and on CNPG) makes the index usable; a test asserts the
flags and that the planner chooses the GIN index for messages, threads and files as a member. The visibility predicate is the hoisted array probe of the policies, run as the caller (the search functions are
`SECURITY INVOKER`), so search has no visibility rule of its own.

Measured with `pnpm --filter @manythreads/tools-bench bench:search` (Postgres 19 beta in the dev container, `shared_buffers` 160 MB, other suites running on the same machine; 1,000,000 messages in 200 channels,
50,000 threads, 20,000 files, real schema and policies; eight queries x 20 runs per persona):

| Step | Nadia, "rolback" (a word in 4% of messages), messages only |
|---|---|
| Policy only (no LEAKPROOF): sequential scan | 2.1 to 2.4 s at 300,000 rows (about 8 s at 1,000,000) |
| LEAKPROOF, one ranked query over all matches (bitmap heap scan, 18,763 rows kept of 50,585 index matches) | 1.6 s |
| + newest-slice search (one day, then 16 days, BitmapAnd of trigram, channel and id range) | 35 to 45 ms |

What did not work first: ranking all matches (the cost is the heap fetch and comparison per row, not the index); plain `ORDER BY id DESC LIMIT` over the key range (fine for common words, 1.3 s for rare ones);
`channel_id = ANY(...)` hidden behind the policy's `is_system() OR ...` (not an index qual: repeat it as a plain predicate); `uuidv7(interval)` inside the query (volatile, evaluated per row, 880 ms);
for a guest the whole-history query chose the trigram index and discarded 50,000 rows of other channels (1.2 s) before the "reads little" plan (compare the at most 6,000 readable rows) replaced it; a four-word
phrase pays 100 ms for the trigram scan alone, so a slice per scan was too many (1 day only for three words or more, threshold 0.6 instead of 0.5).

Final run (p95 over 20 runs of each of eight queries, ms; "all kinds" is messages, threads and files in one request):

| Persona (readable messages) | messages only, p95 | all kinds, p95 | worst single query p95 |
|---|---|---|---|
| Nadia (110 channels, about 550,000) | **261** | **296** | four-word phrase, 421 |
| Sameera (60 channels, about 300,000) | **271** | **292** | four-word phrase, 396 |
| Lena (guest, one channel, 5,000) | **149** | **218** | typo of a common word, 203 |

Single words and two-word queries sit at 40 to 135 ms (messages only; medians 40 to 80 ms), the guest at 100 to 200 ms (a bounded comparison of 5,000 rows), the four-word phrase of common words at 260 ms median
with p95 around 400: the phrase is the adversarial case of this synthetic vocabulary (uniform random words make a quarter of the table nearly match any four of them) and is what lifts each persona's p95
to the 260 to 300 ms line. **At the first cut criterion 6 held with a thin margin (all three personas under 300 ms p95 for messages and for all kinds)**; the margin was mostly the phrase, so
the follow-ups are (1) real text instead of uniform words, (2) a rank-by-recency-only plan for phrases if a deployment's numbers say so, (3) a larger `shared_buffers` (the table and indexes are 650 MB; most of
the cost is OS-cache reads at 160 MB).

**Gate run (phase exit).** The same bench, run again for the gate with nothing else on the machine, put Nadia's all-kinds p95 at 302 ms (messages only 262): the line, over it by 2 ms, so the
bench exited 1. The phrase was the whole story (the overall p95 sits inside the phrase's distribution: 292 ms median for all kinds). A phrase of three words or more paid the trigram index scan
twice (the one-day slice, then the whole history when the day held fewer than twenty hits) and a phrase is selective at threshold 0.6, so `0003_phrase_plan.sql` sends it straight to the whole
history through the index (ranked by similarity then newest, `gin_fuzzy_search_limit` 3,000 so a phrase of words most messages share is answered from a sample, never by ranking tens of
thousands of rows). One scan instead of two: the phrase went from 292 ms to 182 ms median, and the numbers of the gate, p95 over 180 searches (20 runs of each of nine queries) at 1,000,000
messages, are:

| Persona (readable messages) | messages only, p95 | all kinds, p95 | phrase (all kinds), median / p95 |
|---|---|---|---|
| Nadia (110 channels, about 550,000) | **163 ms** | **182 ms** | 182 / 240 ms |
| Sameera (60 channels, about 300,000) | **171 ms** | **189 ms** | 186 / 227 ms |
| Lena (guest, one channel, 5,000) | **129 ms** | **188 ms** | 129 / 166 ms |

(Run: 189 s including the 78 s load; `bench:search` prints "ok: every persona's p95 under 300 ms". Before 0003: 262 / 302, 256 / 284, 130 / 189.) Criterion 6 now holds with a margin of about 110 ms. The
single-word and two-word queries are unchanged (40 to 150 ms). A phrase made only of words that most messages share is the plan's remaining soft spot: it is answered from a sample of 3,000
index rows, so its hits are not the newest ones (stop-word phrases, which nobody searches for; a deployment's real text will say whether it matters).

Known limits: ranking is by similarity inside the slice that answered, so an older but better spelled hit is not shown when the last day already holds twenty; a term common only in channels the caller cannot
read is answered from a sample (`gin_fuzzy_search_limit`), never from unreadable rows; the 6,000-row line between the plans is a constant; without the superuser the LEAKPROOF marks are skipped with a warning and
search still works, only at sequential-scan speed.

## 3. What was built (P3-00 to P3-16)

| Task | What exists now | Where |
|---|---|---|
| P3-00 | Hoisted RLS visibility sets (96 s to 55 ms on 300,000 rows), per-row-policy check for every table, SDK helpers (`ctx.db.getOneOrCreate`, `ctx.audit.emit`, `ctx.templates`), a job worker host with the `job.register` extension point, last-lead guard, Zod-enum-vs-CHECK test | section 1; `kernel/migrations/0011`, `0012` |
| P3-01, P3-02, P3-05 | `channel_groups`, `channels` (`channel`, `dm`, `bot_conversation`, `private`), `channel_members`, `messages` (markdown `body`, `body_plain`, `thread_root_id`, `meta`), reactions, mentions, `threads`, `thread_follows`; the channels plugin: CRUD, post, edit, delete, react, cursor pagination by uuid v7, the `team.template.applied` consumer (groups and channels with `DO SELECT`), live pushes | `plugins/channels` (migrations 0001 to 0005), `docs/plugins/channels.md` |
| P3-03, P3-04 | Read-state service (`read_state`, partial unread index, `POST /api/read-state/mark`, `read_state.changed`) and entity-link service (create, resolve through plugin resolvers, list at `GET /api/links`) | `kernel/read-state`, `kernel/entity-links`, `plugins/read-state`, `plugins/entity-links` |
| P3-06 | `threads` plugin (thread view, follow and unfollow, the Threads inbox: Followed, Unread, Mine) and `direct-messages` (get-or-create of a DM in one statement, ten concurrent opens make one row) | `plugins/threads`, `plugins/direct-messages` |
| P3-07 | One composer parser for `@person`, `@bot`, `#channel`, `[[entity]]` (linear-time scanners), presence and typing in UNLOGGED tables | `shared/src/markup`, `plugins/channels` |
| P3-08 | `storage-local` blob provider (`ctx.providers.get('storage')`) and the `files` plugin: raw-stream upload with limits, download that re-reads the row through RLS on every request, delete, entity-link resolver | `plugins/storage-local`, `plugins/files` |
| P3-09 | `notifications` plugin: mention, reply on a followed thread, DM; per-person prefs; WebSocket push; the browser-alert permission flow | `plugins/notifications` |
| P3-10 | `search` plugin: trigram search under RLS over messages, threads and files; the plan by caller and term; 1,000,000-message benchmark | section 2; `plugins/search` |
| P3-11, P3-12 | Right panel with a back stack (`panel.push/back/close`, `?panel=thread:<id>`, a registry any panel type joins) and the app shell with the sidebar contract Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) · Bots (50) | `clients/web/src/kernel/panel`, `clients/web/src/shell` |
| P3-13 | Channel view on a hand-made virtual list (5,000 messages at one frame per vsync), message rows, reactions, thread panel, composer (toolbar, pickers, attachments with progress, paste, drag, size errors, per-channel draft, "Not sent · Retry"), Threads inbox with `j` `k` `e`, realtime client | `clients/web/src/channels`, `screens` |
| P3-14, P3-16 | Welcome card, 390 px layout (sidebar drawer, thread as a full sheet), guest shell for Lena, search results panel, notifications bell and popover, DM screen, a guest invitation's channel grant applied on accept | `clients/web/src/welcome`, `search`, `notifications`, `dms`; `plugins/teams` |
| P3-15 | Seed v3 (40 messages per channel, a 12-reply thread, a private channel, a DM pair, a 5,000-message channel, Lena's grant and read state, one attachment), event contracts for the five new events, isolated stacks for api e2e | `test-utils/src/seed-content.ts`, `e2e/fixtures`, `shared/src/events` |

### What the gate changed (this commit)

The gate run is where the screens were held to the plates for the first time, so some of the web client moved toward them. None of it is a new feature of the plan; each item is a plate
detail the live screen lacked.

- **Centre header.** A channel's purpose is the header's topic ("Ship coordination", `useHeaderTopic`); the Threads home on a wide screen draws its own two header bands (list: title and tabs;
  thread: its name and actions, the bell stays in a fixed corner of the right band) instead of the shell's band over both, as plate 2 does. The bell button is 26 px so the band is 50 px, not 51.
- **Right panel.** The channel line is the panel header's second line (`usePanelSub`), the thread's root carries a "Linked" box (what the root is linked to in the kernel's link table: files, other
  threads; `GET /api/links`), messages in a thread have the 6 px row gap of the channel list, and the reply box is "Reply in thread…" in the Threads main area.
- **Message row.** An attachment card and the reply count sit on one line (`.atts` is inline), as in the plate.
- **Composer.** At rest (nothing typed, nothing attached, no focus) it is the plate's one line; the markdown toolbar opens with the caret, an upload or a draft.
- **Threads inbox rows.** `ThreadInboxItem.lastReply` (`{ authorName, preview }` of the newest live reply, named through `app.message_authors`) is the row's second line, the reply count moved
  under the time for read rows. This changed two schema-compat snapshots (additive field of a response).
- **Fixes found while photographing the phone.** The closed sidebar drawer's shadow bled into the screen from beyond the left edge (shadow now only while the drawer is out); the start-of-channel
  header had fractional line heights (22 px and 20 px now), which made the first day label land on a different pixel row depending on scroll rounding.
- **Search.** `0003_phrase_plan.sql` (section 2). **Seed.** Lena's read state for #releases, so her first visit does not show the whole channel as "New".

## 4. Visual gate (PLAN section 5)

Every spec starts its own stack on `MANYTHREADS_STACK_SEED=content` with `MANYTHREADS_CLOCK=fixed`; times, counts, day labels and avatars are masked (on both images; `docs/testing.md` section 3a).
`pnpm vt` runs 32 specs in 87 s.

| Spec | Plate or baseline | Class | Result |
|---|---|---|---|
| `channels/channel-thread` (1440x700 frame) | proto 02 plate 1, whole frame | **P** (6%, landmarks within 6 px for team switch, search, sidebar, header, content, right panel) | **4.6% to 4.7%** differing |
| `threads/inbox` (1440x700 frame) | proto 02 plate 2, whole frame | **P** | **4.4%** differing, landmarks within 6 px |
| `channels/phone` (282x602 screen; 390x844 landmark and no-scroll check) | proto 02 plate 6, third device | **P-loose** (12%) | **8.2%** differing |
| `channels/attachment-card` (788x113 message) | proto 02 plate 1, first message | **P-loose** | **1.6%** differing |
| `channels/composer` (1440, 390) | own baselines `composer-1440.png`, `composer-390.png` | W (0.2%) | equal; a PDF done, `big.zip` "Too large (50 MB)", toolbar open |
| `channels/empty-error` (1440, 390) | own baselines `empty-channel`, `no-access`, `not-sent` (each at both sizes) | W | equal; "This is the start of #quiet.", "You cannot see this channel.", "Not sent · Retry" |
| `shell/sidebar-states`, `channels/dm`, `search/results` | own baselines (Nadia, Priya, Lena; DM; results) | W | equal (Nadia, Priya and results re-baselined: the header band is 50 px and the account row 39 px) |

Baselines changed in this commit: `sidebar-nadia.png`, `sidebar-priya.png`, `results.png` (1 px of header height, the account row), and the new `composer-*`, `empty-*`, `no-access-*`, `not-sent-*`.
Phase 1 to 2 plate specs still pass (sign-in methods 9.3%, roster 7.0%, teams create 3.8%); the plate harness now paints masks on both images and puts the plate on the pixel grid, which made
those numbers a little lower, not higher.

**Residual gaps against the plates** (all are things the plates show from later phases or chrome a browser has; none is hidden by loosening a class):

- The prototype's **bots** (Orchestrator, Coder, Tester, Reviewer, Standup relay; plates 1 and 2) exist from phase 5. The same words are spoken by the seed's people (`e2e/visual/support/story.ts`); the bot **lanes**
  (the purple rule, the dot, the "agent" tag's row, the goal card with its steps and cost) are masked on both images, and so is the live text of those rows. The goal card has no live counterpart.
- The sidebar's **channel groups, direct messages and bots** are masked: the plate lists the groups Product and Operations and six bots, the live sidebar lists the seed's groups. The four contract rows
  above them, the workspace row, team switch, search and account row are compared and within 6 px.
- Plate 1's header shows member avatars, a star and an info button; the live header has the bell instead. The replies strip has no participant avatars (not in the API). The plate's "· 3 bots" and
  "· files" suffixes (the bot count, the store an attachment came from) are not in the live copy.
- Plate 2: the sixth row is a board card thread (boards are phase 6) and the thread header's title is the card's, where the live title is the root's text; the participant strip and the "3 replies"
  column are masked.
- Plate 6 is three device frames with a status bar and a tab bar (Home, Threads, Boards, You); the live phone has the drawer instead of tabs. Compared at the screen's own size, 282x602.

## 5. Acceptance criteria and exit lines to tests

| # | Criterion | Proving tests |
|---|---|---|
| 1 | Nadia posts, Rafi sees it within 1 s, the unread dot clears on scroll | `e2e/channels/post-and-read.spec.ts` (a second browser context, 1 s budget, reactions sync), `e2e/channels/read-state.spec.ts` (badge 3 then 0, one divider; scrolled away: a post lights the dot, scrolling to the bottom clears it); `packages/plugins/read-state/test/api.test.ts` |
| 2 | Thread in the right panel with the channel visible; three pushes, Back twice shows the first entry, URL updated | `e2e/channels/thread-panel.spec.ts`: "open a thread, reply, push a second panel, Back, reload" and **"three threads pushed in a row, Back twice"** (added in the gate; asserts the URL at every step); `clients/web/test/panel.test.ts` (the same sentence, on the pure stack: three pushes, Back twice, URL following); `e2e/shell/shell.spec.ts` (`?panel=` restores, Esc closes) |
| 3 | Priya (two teams) replies and switches teams; a guest invitation's grant applies on accept | **`e2e/channels/priya-two-teams.spec.ts`** (added: reply in the panel, switch to Marketing and back, reply still there), `e2e/shell/shell.spec.ts` (team switch keeps the section); `e2e/channels/guest-invite.spec.ts`, `e2e/api/teams/guest-invite.spec.ts`, `packages/plugins/teams/test/guest-grant.test.ts` |
| 4 | Threads: Followed, Unread, Mine | `e2e/threads/inbox.spec.ts`, `e2e/api/threads/inbox.spec.ts`, `packages/plugins/threads/test/threads.test.ts` (membership of each tab, ordering and cursor; the task part of Mine is the phase 6 hook in `inbox.ts`) |
| 5 | Opening the same DM twice, even concurrently, makes one row | `e2e/dm/get-or-create.spec.ts` (ten opens at once from both sides), `e2e/api/dm/get-or-create.spec.ts`, `packages/plugins/direct-messages/test/dm.test.ts` |
| 6 | A private channel is not found by a non-member; "rolback" finds "rollback"; 1M messages under 300 ms p95 | `e2e/search/basic.spec.ts` (Nadia, Sameera, Lena; private channel), `e2e/search/trigram.spec.ts`, `e2e/api/search/trigram.spec.ts`, `packages/plugins/search/test/search-api.test.ts` and `rls/search-rls.test.ts`; **`pnpm --filter @manythreads/tools-bench bench:search`: Nadia 163 ms (messages), 182 ms (all kinds); Sameera 171 / 189; Lena 129 / 188** (section 2) |
| 7 | An 80 MB attachment is refused in the composer; Lena without a grant gets 403 | **`e2e/files/attach.spec.ts`** (added: PDF and PNG up, 80 MB "Too large (50 MB)", the cards download the same bytes), `e2e/channels/composer.spec.ts`; `e2e/api/files/attach-acl.spec.ts` (403 for Lena and Sameera on content, metadata, list and upload), `packages/plugins/files/test/` |
| 8 | Lena's sidebar shows only `#releases`; her calls to other channels give 403 | `e2e/channels/guest-lena.spec.ts` (sidebar, read-only, API 403s), `e2e/shell/sidebar-contract.spec.ts`, `e2e/api/messages/rls.spec.ts`, `e2e/channels/mobile-web.spec.ts` (Lena on the phone) |
| 9 | The 5,000-message channel scrolls at p95 frame under 20 ms | `e2e/channels/perf-5000.spec.ts`: **p50 16.7 ms, p95 16.8 ms, max 16.8 to 33 ms, 598 to 600 frames over 10 s, at most 39 rows in the DOM, 57,000 px travelled** (a 60 Hz frame is 16.7 ms: the measure is vsync-bound, not render-bound) |
| 10 | Customer support applies once (four channels exactly once); the sidebar order is exactly the contract | `packages/plugins/channels/test/channels-api.test.ts` ("Customer support applies once", five concurrent directory reads and the consumer), `e2e/api/seed/seed-v3.spec.ts` (no channel name twice); **`e2e/shell/sidebar-contract.spec.ts`** (added: Files, Boards, Threads, Approvals, channel groups, Direct messages, Bots in DOM order for Omar, Nadia, Rafi, Priya, Sameera, Tariq; Lena's is the channel groups only; Priya's second team the same), `e2e/shell/shell.spec.ts`, `visual/shell/sidebar-states` |

PLAN section 4 rows: `channels/post-and-read`, `channels/thread-panel`, `channels/read-state`, `threads/inbox`, `dm/get-or-create`, `channels/mentions-notifications`, `search/basic`, `search/trigram`,
`channels/acl-private`, `channels/guest-lena`, `channels/guest-invite`, `channels/mobile-web`, `api/messages/rls`, `api/messages/pagination`, `channels/perf-5000` all exist under those names; `files/attach.spec.ts`
was the one row without its own file (its steps lived in `channels/composer.spec.ts`) and was added.

Section 6 exit lines: **two browsers chat live with correct unread state** (criterion 1, `post-and-read`, `read-state`, `mentions-notifications`); **the sidebar matches the contract for every persona including Lena**
(`sidebar-contract`); **typo search over 1M messages is under 300 ms** (bench, 182 ms worst persona, all kinds); **nothing leaks another team's rows** (`pnpm test:rls`: 244 tests over every table incl. channels,
messages, files, search, notifications; `e2e/api/messages/rls.spec.ts`; the per-row-policy check on every table).

## 6. Timings (this machine: 4 vCPU, 15 GB, Postgres 19 beta in the dev container, nothing else running)

| Command | Result | Time |
|---|---|---|
| `pnpm lint` | green | 11 s |
| `pnpm typecheck` | green | 71 s |
| `pnpm test` | 100 files, 1,617 tests | 104 s |
| `pnpm test:rls` | 19 files, 244 tests | 22 s |
| `pnpm test:events` | 11 files, 93 tests | 17 s |
| `pnpm test:schema-compat` | 325 snapshots | 3 s |
| `pnpm e2e --project=api` | 60 passed | 42 s |
| `pnpm e2e --project=desktop` | 115 passed, 7 skipped | 175 s |
| `pnpm e2e --project=mobile-web` | 14 passed (43 desktop-only specs skipped) | 48 s |
| `pnpm vt` | 32 passed | 87 s |
| `bench:rls` | ok, every unscoped count under 2 s (Nadia 55 ms, Lena 53 ms, Omar 46 ms) | 7 s |
| `bench:search` | ok, every persona's p95 under 300 ms | 189 s |

## 7. Deviations from the spec and plan, and decisions worth keeping

- **`job.register` extension point (SPEC section 3 deviation).** The manifest's `extends` enum gained `job.register` (section 1). SPEC-FINAL section 3 lists the extension points and has no line for it: the spec needs
  one ("a plugin registers a job queue named `<plugin>.<name>`; its handler runs as the system actor, one transaction per attempt scoped to the payload's workspace"). Not edited here (the spec is the owner's).
- **LEAKPROOF pg_trgm operators and length CHECKs.** Search under RLS needs `word_similarity_op`, `word_similarity_commutator_op` and `similarity_op` marked `LEAKPROOF` (superuser; the owner is one in compose and on
  CNPG). That is only honest if no stored value can make them raise, so `body_plain` (100,000) and `threads.title` (200) carry CHECKs (`search/0002`), after measuring an out-of-memory failure at about 250 MB of text.
- **Reply through the channels route.** A thread reply is `POST /api/channels/:channelId/messages` with `threadRootId`; the threads plugin owns reading, following and the inbox, not writing. One write path, one set of
  rules (mentions, events, pushes, notifications).
- **`thread_follows` and `read_state` mirror each other.** `read_state.followed` is the mirror of `thread_follows`, kept by triggers, so the Unread tab, the badge and the follow toggle read one row; the root's author follows on the
  thread's first reply only (an unfollow of your own thread is not undone by the next reply, MISTAKES P3-06).
- **Attachments live in `message.meta.attachments`** (file ids; cards resolved on read in one batched query), not as entity links. Entity links hold the cross-plugin relations (the "Linked" box).
- **`ChannelMessage.author`.** Names come from the definer function `app.message_authors`, which joins the message ids to the caller's readable channels before it looks anybody up, because `people` and `actors` show a
  caller only their own row (MISTAKES P3-07). A guest has no roster, so this is also what names the authors in her one channel.
- **`MANYTHREADS_TRUST_PROXY` = 2 in the chart.** Traefik and the web pod's nginx each append to `X-Forwarded-For`; one hop would make every visitor look like Traefik (one shared sign-in lockout). Tests use 1.
- **Blobs on a PVC.** `manythreads-blobs` (local-path, RWO, Recreate, one replica) holds uploads; the seed Job mounts the same claim with a pod affinity.
- **Mobile is the web app** (owner decision); the phone plate is compared at its own screen size and the 390x844 layout is held to landmarks and no sideways scroll.

## 8. Security review fixes (e5fe15e) and what they teach

- A `channel_members` row kept giving access to a private team channel after the person left the team (and their pushes kept coming): a membership now counts only while the person is on the channel's team (channels 0004).
- `threads.title` was a copy of the root's text taken once, so a deleted or edited root stayed readable in the inbox, thread search and link resolver: a trigger now follows the source, and a delete clears `body_plain`,
  the thread title and the attachment cards in `meta`.
- An open WebSocket outlived its session: the host re-checks every cookie-session socket against a read-only `sessions.live()` every 15 s, and `maxPayload` caps a frame (the default was 100 MiB, from anonymous callers).
- A streamed upload held the request's transaction (a pooled connection) for as long as the body took: concurrency slots (4 in flight per process, 2 per person), an idle timeout (20 s) and a total deadline (10 min).
- LEAKPROOF honesty: `body_plain` and `threads.title` got length CHECKs (search 0002) so the trigram operators cannot raise on a stored value.
- Each of these is a `MISTAKES.md` line; the common shape is that **anything derived from a membership, a source text or a connection needs its own end-of-life path**, and a test that the access ends.

## 9. Follow-ups carried to phase 4 and later

From `STATUS.md` and the reviews:

- **Blob GC.** A channel or team cascade delete orphans blobs (there is no delete route for them yet): add a GC job (the `job.register` host exists) before any delete route does.
- **Deleted-message files.** A deleted message leaves its attached files downloadable to channel readers: decide between hiding them with the message and deleting them with it (the `files` row and its blob).
- **`TEAM.md` pending commit.** Applying a template still leaves `TEAM.md` in `team_pending_files`; phase 4's first repo commit (P4-01) writes it.
- **`parseMarkup` is quadratic in mentions.** It checks each claim against all earlier ones: 13,000 mentions cost 180 ms (the cap on a message is 40,000 characters, so a hostile message is bounded, but a sorted-interval check is
  the fix).
- **`pushToPeople` batching.** One `ctx.realtime.pushToPerson` call per audience member, awaited in turn, each a `publishRealtime(tx, [one event])`: a 2,000-member public channel runs 2,000 publish statements per
  message. `publishRealtime` already takes an array, so a `pushToPeople(tx, ids, type, payload)` in the SDK that makes one call keeps a post at one round trip.
- **Muted members and the unread count.** A muted channel member still gets the sidebar's number (the mute silences notifications only): decide whether a muted channel shows a dot instead.
- `read_state_bump` can be called with arbitrary recipients from plugin SQL (not HTTP): tighten when plugins become third-party. A lead or admin can add themselves to a private channel of their team (by design, audited): confirm with the spec's wording.
- Search: real text instead of uniform words in the benchmark; a rank-by-recency-only plan for phrases if a deployment's numbers say so; `shared_buffers` larger than 160 MB on the database host (the table and indexes are 650 MB).
- The Helm chart does not template `MANYTHREADS_KMS_PREVIOUS_KEYS` yet.
- The Linked box lists links of the thread root only; tasks, pages and bots join it as their plugins register resolvers (phases 4 to 6).
- `docs/retro/phase-2.md` follow-ups still open: typed API client everywhere (the new `fetchLinks` and inbox calls use it) and a reusable settings frame for channel settings.

## 10. Answers to PLAN Phase 4 section 0

- **Channels and files both check channel ACL on blob reads. One kernel capability or two copies?** Neither: one SQL helper, owned by the channels plugin. `app.visible_channel_ids(permission)` (a definer function that builds the
  caller's readable-channel set once per statement, the same hoisted-set idiom as `app.readable_team_ids`) is what the `files` table's policy, the message policies, search and notifications all call; the files download
  route does not repeat a check, it re-reads the row through RLS on every request and the policy decides. So there is one rule, but it lives in SQL and is reachable by a plugin only as SQL, not through the SDK. Phase 4's tree API
  needs two sets side by side (team set for repo paths, channel set for `channels/<name>/`): add the pair to the SDK as `ctx.access.readableTeamIds(tx)` and `ctx.access.readableChannelIds(tx)` (thin wrappers over the two
  functions) before the repo store is written, so `plugins/files` and `plugins/repo-git` do not each hand-write the call and the type of the result.
- **Does the right panel take a new kind (`file:<path>`) without a kernel edit?** Yes. `registerPanelType({ type, label, Component })` in `kernel/panel/registry.ts` is the extension point (a later registration of the same type
  replaces the earlier one), `parseEntry` takes everything after the first colon as the id (300 characters, so a path with slashes and colons survives a reload), and `builtins.tsx` already registers a placeholder `file`
  type that the files plugin replaces. What is still a kernel edit is the *import*: client plugins are statically imported in `builtins.tsx` (run-time loading of third-party JS plugins is a non-goal), so phase 4 adds one
  import line there, not a change to the panel. The header's second line (`usePanelSub`) is the same kind of hook for a file's path.
- **Does the composer assume the blob is on `storage-local`?** No. The composer talks to the files plugin's routes (`POST /api/channels/:id/files`, a raw stream), and the files plugin gets its store as
  `ctx.providers.get<BlobStorage>('storage')`; `storage-local` is just the plugin that registers that provider (`put(stream, { maxBytes })`, `get`, `delete`, `head` by blob key). A `storage-s3` plugin that registers the same
  provider fits without a change to the composer or to `files`. The two places that do know about local disk are operational, not code paths of the composer: the seed's `--no-attachment` (a seed Job cannot write a
  server pod's disk, now solved with the PVC and an affinity) and the blob PVC itself (one replica, Recreate); an S3 store removes both.
