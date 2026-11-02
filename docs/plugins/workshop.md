# workshop

The place where a person sets a bot up by describing it. They open **Add a bot** on the Bots page and write, in plain words, what the bot should do. A built-in helper looks at what the team really has, the platform grades each thing the brief needs, the person answers one list of questions, and the helper proposes the bot's files. A person with the right approves them; until then nothing exists (PLAN P7-02, P7-03, P7-04; SPEC section 9).

Package: `packages/plugins/workshop`. Manifest: `extends: ['job.register', 'capability.call']`, `dependsOn: ['teams', 'channels', 'bots', 'proposals', 'knowledge', 'bot-runners', 'gateway-llm', 'repo-git']`. Migration `workshop/0001_setup_sessions.sql` (`app.setup_sessions`, one person's conversation, `rls: person`). Schemas: `packages/shared/src/entities/setup.ts`, `packages/shared/src/api/setup`, `packages/shared/src/bot-md/setup-profile.ts`. The helper's profile: `templates/_setup/PROFILE.md`. The screen: `clients/web/src/screens/setup`.

What it is not: the **Workshop tab** of a bot's page (build, rehearse, learn; P7-05) is not built. This plugin is its first seam, the part that makes a bot from a brief. Replaying a bot against past work and the list of earlier setup conversations on a bot's page are P7-05.

## The flow

1. **Brief.** `POST /api/teams/:slug/setup/sessions` `{ brief, name? }`. Anyone who may post in the team may start one (the same right as proposing a change to its files). The row is written and a background job is queued; the answer is `201` at once. At most three conversations per person are open (working or waiting for answers); the check runs under a lock on the person, so starting several at once cannot slip past it. A `working` conversation the helper has not written for ten minutes is turned into `failed` ("The helper stopped answering…") whenever its owner reads or starts one, so a stuck one neither hangs the screen nor counts against the limit.
2. **Discovery.** The job runs the helper. It calls `describe_self`, then `ask_clarification` with *every* thing the brief needs. The platform grades each (below) and asks one question for each gap, all in one list. The conversation becomes `asking`.
3. **Answers.** `POST .../:sessionId/answers` `{ answers: [{ questionId, text }] }` must answer every open question. The job continues the same conversation. At most six rounds of questions.
4. **Proposal.** The helper calls `propose_config`, and the platform refuses until `ask_clarification` has been called at least once in the conversation (a brief with nothing missing is still graded, with an empty gap list, by that call). The platform checks the files (refusals below). If they pass, the files are filed as ordinary proposals ([proposals.md](./proposals.md)): `bots/<slug>/BOT.md`, optionally `skills/<slug>/SKILL.md` and one `TEAM.md` change. The conversation becomes `proposed`.
5. **Approve.** The web screen shows the diff, the checks and "What it won't be able to do". **Approve** applies the proposals in order (team file, skills, the bot last) through the usual approve route. Adding a bot needs a workspace admin ([proposals.md](./proposals.md)); a member or lead sees the proposal and who approves it, and it waits in Proposals. The grants a bot has are the ones its BOT.md names; the bots loader applies them when the file lands. Nothing else applies grants.

`GET .../:sessionId` returns the conversation (the screen polls it while `working`). `POST .../:sessionId/cancel` stops it. A session belongs to the person who started it: nobody else (a lead or admin included) can read, answer or cancel it (`404`).

States: `working` (the helper is thinking), `asking`, `proposed`, `failed` (one plain sentence in `message`), `cancelled`.

## Why the helper has its own small loop

The task allowed "the model runtime or the Hermes path, whichever the seams allow". Neither can host this session:

* The `model` runtime of [bot-runners.md](./bot-runners.md) (P19-10) serves a **bot's run**: it needs a bot row, a runner assignment, a run, and the bot's grants. While a bot is being set up none of them exists, and inventing a throwaway bot to borrow them would put an actor in the roster that nobody approved.
* A Hermes pod is a long-lived process for a bot; it needs a bot, a pod and a pairing. Same problem, and slower.

So the plugin runs its own loop (`src/loop.ts`, about 100 lines). It is a third agent loop in the code base next to the `model` runtime and Hermes; that is a **proposed** decision for the owner, recorded under "Owner decisions" in [conventions](../engineering/conventions.md). Code is not shared with the model runtime: only the turn, tool call, append skeleton (about 30 lines) is common, while the runtime is an async generator over bot run events that ends only on text and needs a bot, a runner and a run, and this loop ends on special tools, saves its history at every step, nudges a model that forgot to call a tool, and checks for a cancel. Sharing would need an adapter bigger than the overlap: ask the model for a turn, run the tools it asked for, give it the answers, go on until a tool ends the turn. It goes through the **same model door** as every other model call, `provider.llm.chat` of [gateway-llm.md](./gateway-llm.md): the pre-call guard (DLP, budget), the alias and its fallbacks, the spend line. `chat` accepts no bot and no run for this purpose (`botId: null`, `runId: null`, `sessionId`, `purpose: 'setup'`); the spend line carries the session id, and no bot. A workspace without a connected model gets `503` when starting, and a plain sentence if it goes away meanwhile.

The loop is bounded: `limits.steps` of the profile (8) model calls per round, four tool calls per step, 4096 output tokens and 120 seconds per call, 24000 characters of a tool answer (`describe_self` is trimmed to fit, see below). A model that answers in plain words twice instead of calling a tool is given up on (`failed`).

## The profile and the tools

`templates/_setup/PROFILE.md` is the helper's definition: name, role, model aliases (`smart`, `fast`; the first one the workspace has bound is used), `limits.steps`, the tool list and the prompt. It is a platform file: the loader of team templates skips directories that start with `_`, and the plugin reads it through `ctx.templates.setupProfile()`. Frontmatter is checked by `SetupProfile` in shared; the tool list can only leave tools out of the fixed four.

| Tool | What it does |
|---|---|
| `describe_self` | The team's inventory **as the asker may see it**: bots, knowledge bases, skills, runners the team may use, models by alias, channels, role tags, the tools a bot could be given (and which can change things), the triggers, what the team allows (`shell`, `files`, `browser`), the default guard, and what this person may grant. Names and counts only. Never an address, key, token or message text, and never another team. The policy fields come first (the asker, `runtimeAllowed`, `guardDefault`, the triggers, connections) and are never cut; when a team is big the long lists (bots, capabilities, channels, ...) are halved until it fits and the answer says what was left out. Channels are the team's public ones only. |
| `knowledge_search` | The read-only `knowledge.search` capability, as the person, with the team fixed by the session. Short passages (400 characters), marked as data. |
| `ask_clarification` | Lists every requirement, has the platform grade them, stores the grades, writes one question per gap and **ends the turn**. |
| `propose_config` | Checks the files and, if they pass, files the proposals. Ends the turn. |

Every tool runs as the **person who asked** (never a bot, never the system), in that person's own transaction, so what a tool shows or files is what that person may see or file. The helper has no actor of its own, no grants and no way to apply anything. Tool calls reach the platform's capabilities through `capability.call` ([security.md](./security.md)), not through the wide run door; the manifest lists the only two the plugin may call (`calls: ['knowledge.search', 'proposals.propose']`) and the kernel refuses any other.

## Grading (P7-03)

The grade is decided by code (`src/grade.ts`), from the requirement the helper wrote (`kind`, `name`) and the inventory. The model chooses what the brief needs; it does not choose how it is graded.

| Grade | Meaning |
|---|---|
| `covered` | The team has it and the bot may simply be given it: a tool that cannot change things, a knowledge base, a skill, a model alias that is bound, a runner the team may use, one of the five triggers that need no connection. |
| `grantable` | It exists and a person with enough standing can switch it on, which is part of what is approved: a tool that can change things (the bot must ask a person each time) when the asker is a lead or admin; a runtime tool the team allows, same asker. |
| `missing` | The team does not have it: a connection (none exist in this release), a knowledge base, a skill, an `inbox` or `webhook` trigger (they need a connection). |
| `blocked` | The rules do not allow it: a shell, files or browser the team has not allowed; a runner the team may not use; anything dangerous for a member. |
| `unclear` | The brief does not say enough, or names something that does not exist. |

`missing`, `blocked` and `unclear` are **gaps**. The platform writes one question per gap (the helper may word it and suggest up to four options), numbered `q1`, `q2`, ... continuing across rounds. `propose_config` refuses to go on while a gap has not been asked about. **A later listing never loosens an earlier verdict**: when the helper lists a requirement again, the stricter grade stays, a gap never turns into `covered`, and a different thing listed under a taken id is kept under a new id. Grades are code, so a model that reworded a missing connection as a note cannot hide it. What cannot be done is written to the proposal's note and shown as "What it won't be able to do".

## What `propose_config` refuses (P7-03)

Code, in `src/policy.ts`. Each refusal is a plain sentence the helper reads and fixes; nothing is filed unless the whole proposal passes.

* The bot's file must load (`parseBotMd`), be an `agent` on the `hermes` runtime, and have a new slug (not one the team has, not `new`, which is the address of the Add a bot page).
* **Never looser than the team default.** The guard preset must be the team's default or stricter (`standard` default: any preset; a stricter default: that preset or `air-gapped`). The default is the `defaults.guardPreset` key of `TEAM.md`; an absent key means `standard`, but a key that is **there and cannot be read** (a typo such as `lax`, a broken front block, `botRuntime` that is not a list) reads as the strictest (`air-gapped`, nothing allowed) and the helper is told to ask a lead to fix the block. A mistake must never loosen a limit.
* **Never more than the person may grant.** A tool that can change things needs `approvals.needsApproval` for it **and** a lead or admin asker. Shell, files and browser (`capabilities.runtime`) only if the team allows them (`defaults.botRuntime` in `TEAM.md`; absent means none) **and** a lead or admin asker. A memory bank is only the team's own, with write access for a lead or admin. A bot for the whole workspace (`visibility: workspace`) is an admin's call.
* **Only a runner the team may use.** `placement.runs_on` must be in the runner catalog for the team, and a bot that needs more than a model call is refused a runner that only calls a model (the same `botPlacementProblem` the loader asks). The old placements (`gateway`, `node`, `runner`) are refused.
* Tools must exist and be named one by one (no wildcards); no `connections` (none exist); no `inbox` or `webhook` trigger; knowledge bases, skills and model aliases must exist (a skill may be created by the same proposal); no `subscription` model (an admin's choice); approvers and handover roles must be role tags of the team, never a named person; `mayTag` must name bots that exist; no evals.
* **Triggers.** A `channel_message` trigger needs `source.channels` (without it the router would answer every message in every public channel), and any channel a `mention` or `channel_message` trigger names must be one of the team's public channels the asker can see (the router fires only in public channels, never in private ones or direct messages).
* **One proposal per file.** A skill listed twice in one call, or a bot or skill path that already has an open proposal, is refused.
* A `TEAM.md` change must come from a lead or admin, be valid, change something, and **cannot change `defaults.botRuntime` or `defaults.guardPreset`**: the helper can never widen what it is allowed to propose.

The refusal text never repeats a name the person may not see (a runner the team may not use is named only in the sentence about itself).

## Decisions the owner should know about

* **`TEAM.md` keys.** `defaults.botRuntime` (a list of `shell`, `files`, `browser`; absent means none) and `defaults.guardPreset` (absent means `standard`) are new. A team file without them reads as the defaults above; a file that has them but cannot be read reads as the strictest, never the loosest. Nothing else reads them yet; editing them is a lead's change through a proposal.
* **Skills path.** New skills are filed at `skills/<slug>/SKILL.md`, the path of the spec, and BOT.md names them in `skills: [slug]`. A bot's skills have no runtime reader yet.
* **A new bot is an admin's approval.** A member or lead can run the whole flow; the proposal waits for a workspace admin ([proposals.md](./proposals.md)).
* **The brief is stored** on the session row, visible only to its owner (row policy `owner_id = actor`), with the conversation. The system reads it only for the job. It is not in the audit log, the events or the memory feed.

## Not built

* The **Workshop tab** and the list of earlier setup conversations (P7-05); replaying a bot against past work.
* **Connections.** The helper reports that none exist; "Connect Gmail now" of the mockup waits for the connections phase.
* **Seeding from a team template** ("Start from a template" in the mockup): the helper sees the team's bots and may copy their style, but no template is offered.
* The audit entry "setup thread linked from Audit" and a `workshop.*` event: the proposals' own events (`proposals.proposal.created`, `.applied`) are the record today.
* "Edit on the bot page" before the bot exists: the screen offers "Review in Proposals", where the file is read as a diff.

## Tests

* `test/grade.test.ts`, `test/policy.test.ts`, `test/loop.test.ts`: grading of every kind and grade, every refusal, the loop with a scripted model (no database).
* `test/workshop.test.ts`: the real server with a model stand-in (`tools/fake-llm`) that answers with scripted tool calls: grades and one batch of questions, the answers, a refusal heard by the helper and then a proposal, nothing applied before Approve, `describe_self` shows only this team and no secret or address, a session is its owner's alone, the open-session limit (also six parallel starts: exactly three succeed), a hostile model (proposes before asking, relists a gap as covered), a skill and a `TEAM.md` change filed and approved through the real server, atomic filing (a failing skill leaves no bot proposal), cancel during a model call, two answers at once (one `409`), the stuck-session sweep, an unreadable `TEAM.md`. The test waits on the job queue (`jobsIdle`), never on a timer.
* `test/tools.test.ts`: the tools without a server: ask-first rule, merge of grades, requirement cap, duplicate skill, trimmed `describe_self`.
* Kernel: `templates.test.ts` (the profile), `plugins/identity-gate.test.ts` (the `capability.call` door: only the listed capabilities, and the manifest checks), `schema-enums.test.ts`.
* Web: `clients/web/test/setup-model.test.ts`, `setup-flow.test.ts` (the flow against the mock transport, the markup of each part). E2E: `e2e/bots/add-a-bot.spec.ts` (desktop and phone).
