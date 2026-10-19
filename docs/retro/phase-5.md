# Phase 5 retro (Bots, gateways, conversations and Brain)

Sections are written by the task that did the work; the orchestrator adds the gate and the timings at phase exit.

## 1. Reflect and refactor (P5-00)

Answers to PLAN Phase 5 section 0, and what was done before any bot code.

- **Channels, files and now Brain's citations all resolve entity links. One capability?** The SDK's `ctx.links.resolve` is the one resolver (P3-04) and every source of the three kinds goes
  through it. Nothing was duplicated in P5.
- **Does `repo.committed` carry the changed paths, and can `withActor` carry a run?** Both, and both were in place before the bot code: `repo.repo.committed` carries `paths` (the `put`/`delete`
  pair per path) and `Actor.runId` sets `app.run_id`. The run's own source log is written through the new `app.run_source_log_append` door (bots 0004), whose policy is written on that run.
- **Which schemas do web, server and Hermes share (`Citation`)?** In `shared` from the start of P5-18, and extended there in P5-27 (the `memory` kind). The web client and the server read the
  same shape, and the `AnswerPayloadView` (what a client parses) keeps a citation of an unknown kind as an "unsupported source" rather than failing the message.
- **Did any viewer assume a person is looking?** The Answer surface was built with the asker in mind: `answeredFor` is the platform's reading of the run, never a field the bot sends, and the
  "scoped" marker says whose visibility the reads ran with. The open question P5-00 left — whether a shared copy of an answer can be read by someone other than the asker — P5-17 answered: the
  share masks the sources its readers may not open.
- **Is there one pure validator for `memory/`, and does the writer take a per-prefix rule?** Yes: `parseConcept`/`serializeConcept` in `packages/shared/src/okf` is the one validator the repo
  writer, `memory.write` and the web editor's preview all call. The writer takes a per-prefix rule (a `memory/**` file is validated as OKF, a `bots/**` file as `BOT.md`) without a special
  case per path.

### Mistakes added to MISTAKES.md

- A `CREATE OR REPLACE FUNCTION` that copies a 190-line body to change one branch: the diff is unreviewable and the copy drifts. The answer's view was replaced twice this way
  (P5-27) and both copies had to be checked against the original.
- A `CREATE OR REPLACE FUNCTION` that references a table of another plugin: the function is created fine and fails at call time in a database that does not carry that plugin's
  migrations. The memory lookup is now dynamic and guarded by `to_regclass`.
- A Zod schema that is strict and a test that feeds it a key the schema does not have: the eval set's `given.sources` has no `trustTier`, so the three memory-trust cases could not carry
  one. The cases were rewritten, not the schema.

### Not done, carried on

- `memory.recall`'s filters work on the engine's facts, and a concept the engine has forgotten is answered from the frontmatter index; the two are not yet one listing.
- The Hermes adapter's `local` alias is not bound on the demo deployment, so the gate's classifier never runs there.
- Hindsight is not deployed on k3s (no Helm chart yet), so `memory.recall` answers `not_configured` live and the memory bank is fed but empty.

## 2. What phase 5 delivered

- **Bots (`bots` plugin):** `BOT.md` is the one definition; the loader validates it strictly on `repo.repo.committed`, an invalid file keeps the previous version live and raises a red
  banner, `mayTag` compiles into the allowlist, and a pairing token resolves to a bot actor.
- **Gateways:** the LLM gateway (providers, eight aliases with ordered fallbacks, budgets workspace → team → bot → session, rate limits, the four guard presets, the `llm_spend` ledger,
  the pre-call DLP hook) and the MCP gateway (one endpoint per run, token auth, per-run scoping, the broker's path guard, every read in the run's source log).
- **Runtimes:** `runtime-hermes` (a profile rendered from `BOT.md`, one process per invocation) and `runtime-rules` (no model anywhere).
- **Conversations and Brain:** a private conversation per bot, the Answer surface with numbered citations, lineage, sources reached and outside scope, sharing with masking, "Save as page",
  "Hand to a bot", and the Approvals inbox with one handler for every `needsApproval` source.
- **Memory:** the OKF bundle in `shared`, the one writer (the repo writer validates and regenerates the indexes), `memory_concepts` as the frontmatter index, `memory.write` and
  `memory.recall` as the bot's one door into the bundle, the git mirror, and (P5-27) memory as a citable source in an answer.
- **The Memory screen (P5-28):** `/t/:team/memory` with the concept tree, the concept view and its provenance chips.

## 3. The gate and the live verification (2026-10-19)

- **Devbox gate:** lint and typecheck clean; **233 files passed / 3 skipped, 3,773 passed / 65 skipped / 0 failed**; the memory plugin's own unit and rls suites green.
- **Deployed:** helm **rev 42**, **74 migrations**, image `517a9ba53c84-f6c0ff8e`; `/` 200, `/readyz` ready, both pods Running, no error lines in the server log.
- **Live verified:** `e2e/screens/task.persona-journeys.shots.ts` against `https://manythreads.kahf.to` — **44/44 steps passed** across the seven personas
  (Omar 6, Nadia 9, Rafi 5, Sameera 6, Tariq 7, Priya 7, Lena 4), desktop 1440x900 and phone 390x844. The run is read-only: nothing is posted, created or approved, and every persona's
  password was set to a one-off value for the run and rotated to an unknown value afterwards. The evidence is `docs/verification/phase5-live-verify.md`; the pictures are in
  `temp/screenshots/personas/`.
- **The live run found two real gaps, both now closed in code:**
  1. **The concept index only ever filled from a commit event.** A repository seeded without one (the demo) left the Memory screen blind. A daily catch-up job (`memory.concepts`) now
     rebuilds the index from the team's tree, and `POST /api/teams/:slug/memory/concepts/rebuild` queues that job for one team. The job runs as the system, because the index table is
     the system's to write — a request cannot do it.
  2. **The demo's Support and Marketing bots were in git but never loaded**, for the same reason: the bots plugin loads a bot when a commit touches `bots/<slug>/BOT.md`, and those
     repositories were seeded directly. `tools/devbox/push-template-bots.sh` commits the shipped templates as the workspace admin, which is what made the Support responder, the Content
     drafter and both teams' Brain real for the run. `tools/devbox/okf-ify-memory.sh` gives the seeded memory facts the OKF frontmatter they never had (the demo predates the bundle), so
     the index has something to list.
- **The lesson:** a plugin that reacts only to an event has no way to learn about a world it did not see. Every index that is derived from another store (the bots' definitions, the bundle's
  frontmatter index) needs a catch-up that reads the store itself.

## 4. Carried into phase 6

- The Approvals inbox is wired for the DLP and the per-grant sources; the **environment** (`protected`) and **`dispatch: strict`** sources arrive with phase 6.
- Tasks, boards, rhythms and pages (phase 6) have their schema in `packages/shared` but no screen yet; the Memory screen's Confirm and Deprecate are the first doors of that shape.
- The `answer.post` tool cites memory (P5-27), but no bot writes a memory concept as part of an answer yet: the bundle is read, and only `memory.write` grows it.
