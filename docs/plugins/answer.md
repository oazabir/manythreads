# answer

How a bot finishes a reply (SPEC §12.4, §14, PLAN P5-18). Code: `packages/plugins/answer`. Schemas: `packages/shared/src/entities/answer.ts`,
`packages/shared/src/events/answer.answer.posted.ts`. Web: `clients/web/src/channels/Answer.tsx`, `clients/web/src/styles/answer.css`
(classes prefixed `an`).

A bot that answers a question can end its run with one tool call, **`answer.post`** (the capability's name is `namespace.verb` like every
other; SPEC calls the surface "the `answer` tool"). It sends a text, the sources the text rests on **by id**, and some suggestions. The
platform re-reads every one of them as the person who asked, keeps what that person may open, counts what it left out without naming it,
stamps whom the answer was for from the run, and posts the message into the thread the run answers in. The message's text is the answer's
text; its `meta.answer` is the payload the client draws. Any bot may be granted the tool; nothing in the platform knows Brain is special.

```
BOT.md  capabilities.native: [messages.search, answer.post]      (or answer.*)
```

## Two shapes

| | Schema | Who writes it | Strict |
|---|---|---|---|
| What the bot **sends** | `AnswerInput` | the model | yes: unknown keys are refused |
| What is **stored and shown** | `AnswerPayload` (`Message.meta.answer`, read as `AnswerPayloadView`) | the platform | no (a reader tolerates newer shapes) |

`AnswerInput`: `{ body, citations?, outsideScope?, chips? }`.

- `body` — markdown, 1 to 20,000 characters. Refer to a source as `[1]`, `[2]`, ... in the order you list the citations.
- `citations` (at most 40) — a discriminated union on `kind`: `message` (`messageId`), `thread` (`threadRootId`), `page` (`path`, and `teamId`
  when it is not the run's own team), `file` (`fileId`), `run` (`runId`); each may carry a `snippet` (at most 300 characters), the bot's own
  words from the source. **No label, no scope, no date, no id of a channel**: those are read, not claimed. **Only what the run reached may be
  cited** (below): the bot's capabilities bound what it can cite.
- `outsideScope` (at most 12) — `{ kind, count }`: what the bot knows it could not reach (a connection that was not granted). Never a title.
- `chips` (at most 8) — `{ kind: 'followup', prompt, label? }` or `{ kind: 'handoff', botSlug }`.

A call that names `answeredFor`, `lineage`, `sourcesReached`, `scope`, `version` or any person or run is answered `{ ok: false, code:
'platform_field' }` with the field's name; the strict schema refuses anything else it does not know (`invalid_arguments`).

`AnswerPayload` (stored on the message as `meta.answer`, `version: 1`):

| Field | What it is |
|---|---|
| `body` | the text (the message's own body is the same text, for search and for clients that do not draw the Answer) |
| `citations[]` | the citations the asker may open, each with `n` (its position in what the bot sent — a dropped citation leaves a gap, nothing is renumbered), `kind`, the ids needed to open it (a message or a thread also its `teamId`, null for a direct message, so a link uses its own team's address, not the page's), a `label` the platform read and a `scope` |
| `lineage[]` | one entry per kept citation: `n`, `kind`, `label`, `at` (when the source was written), `snippet` (the bot's quote, trimmed) — "how old is each thing this rests on" |
| `sourcesReached[]` | what the run read, from its source log (`run_source_log`): `kind`, `ref`, `label`, `marker` `full` or `scoped` (`scoped`: through the asker's own connection) |
| `outsideScope` | `{ count, items: [{ kind, reason, count }] }` — never a title, a snippet or an id. Reasons: `not_reached` (cited, but the run did not read it), `not_visible` (the asker cannot open it, or it is gone), `not_granted` (the bot said it had no access), `not_shared` (the asker may, the reply's readers may not) |
| `answeredFor` | `{ personId, name, scope: 'scoped' \| 'team', alias, botId, runId }` — the run's asker; `team` for a run nobody asked |
| `chips[]` | `followup` `{ label, prompt }`, `handoff` `{ botId, botSlug, botName }` — **data only**; what a chip does is P5-17's |

`scope` of a citation uses the words the run's source log has: `team` (anybody on the team may open it: a public channel, a team page or file,
a run of the team), `channel` (only the people of a private place: a private channel, a DM, a conversation), `person` (the asker's own
connection, or their own conversation run).

## What the platform does with a call

1. **What was reached.** `app.answer_view(citations, slugs)` (migration `0001`) first asks the run's own source log (`run_source_log`, read by
   a definer function that answers for `app.run_id()` only) whether the bot **reached** each cited source: a `message` line for a message, a
   `file` line for a file, a `run` line for a run (or the run itself), a `page` line for a page (`<path>` for the run's team,
   `<teamId>:<path>` for another), a `thread` by its root or by a reply a hit was, and the **thread the run answers in** (the question it was
   asked in) by definition. A citation that was not reached is `{ found: false, reached: false }`: it is **not looked up**, so whether the
   asker could read an id the bot never saw is not something a citation can ask; the answer is counted as `not_reached`. (Today the tools
   that write the log are `messages.search`, `files.search` and `memory.recall`; a tool that opens pages or runs must write a `page` / `run`
   line before a bot can cite one, and until then those citations are `not_reached` — an open item.)
2. **The view.** Every reached citation and every line of the log is re-read **as the asker**. The function adds no policy of its own: it is
   `SECURITY INVOKER`, runs as `manythreads_app` under the same forced RLS every request has, and for the length of the call switches the
   transaction's identity (`app.actor_id`, `app.actor_kind`) to the run's asker — the identity `ctx.runs.asReader` gives a read tool — then
   switches back (in a block of its own: an error rolls the switch back with it). There is no argument that names a run or a person: the
   function reads the run from `app.run_id()` and answers only when the transaction's actor is that run's bot (or the live run is missing,
   finished, or the caller is someone else: `NULL`). A source that is hidden and one that does not exist are the same `{ found: false }`.
3. **The audience.** Decided from who will actually read the reply, once per call (`reach`):
   - `asker`: the reply is the asker's own conversation, so everything they may open stays;
   - `team`: the reply is in a channel of the run's team whose **actual readers** (`app.channel_audience`: the team, workspace owners and
     admins, anybody an ACL entry names, a private channel's members only while on the team) are each on that team or a workspace owner/admin.
     A source of the team's own (a public channel of the team, a team page or file, a run of the team's) is kept; the asker's private places
     are not;
   - `none`: anybody else may read it — a guest or a person of another team with an ACL grant on the channel, a private channel the bot cannot
     read, a direct message. Only what lives **in the reply's own channel** is kept.
   Anything the asker can read but the reply's readers cannot is dropped as `not_shared`. The decision is a function of the channel's
   readers (`app.answer_reply_team_only`), never of a label on the source: the previous cut let a `team` scope label stand for "everybody in
   this channel is on the team" (MISTAKES). A source line of a kind the platform cannot resolve is judged by its own scope and only `team`
   (or `asker` reach) is shown; an unknown scope fails closed.
4. **The payload.** `buildAnswer` (pure, `src/build.ts`) keeps the readable citations, drops the rest into `outsideScope`, takes every label,
   scope and date from the view, builds `lineage` and `sourcesReached`, resolves hand-off chips to bots of the team that exist and are active
   (an unknown slug, or the answering bot itself, is dropped), and stamps `answeredFor` from the run. The payload is parsed with
   `AnswerPayload` before it is stored; a payload over 96 KB is refused (`too_large`).
5. **The message.** It is posted through the **`messages` provider** (`ctx.providers.get<MessageProvider>('messages')`, registered by the
   channels plugin, extension point `provider.messages`) — the one `postChannelMessage` every message takes, as the run's bot — into the
   run's own channel and thread: the model names neither. `meta` is `{ answer, runId }`. A provider and not the `messages.post` capability,
   because a capability is what a model can be granted and call with arguments of its own; `messages.post` accepts no `meta`, so no tool can
   forge an Answer (a test pins it: the call is a 400 naming the key, and the same call without it stores one plain message). The provider
   does not take its caller's word for the meta either: `meta.runId` must be the transaction's own run (`app.run_id()`), an `answer` must name
   that run and the posting bot in `answeredFor`, and its `body` must be the message's body.
6. **The event.** `answer.answer.posted` (v1): `workspaceId, botId, runId, askerPersonId, channelId, messageId, threadRootId, citationCount,
   droppedCount, reachedCount`. Ids and counts only, and **no `teamId`**: an answer to a person's private conversation is theirs, and a
   team-scoped event row is readable by every member of the team (`events_select`). Like `conversations.conversation.started`, it is
   workspace-scoped.

The tool answers the model `{ ok: true, messageId, citationsKept, citationsRemoved, message }` — a count of what was removed, never what, and
never which of the reasons — or `{ ok: false, code, message }`: `platform_field`, `invalid_arguments`, `no_run`, `no_thread` (the run was not
asked in a thread), `already_answered`, `too_large`, `unavailable`, or a refusal of the channel's own (`forbidden`, `conflict`).

**One answer per run.** A second call says `already_answered`. The check is made under `pg_advisory_xact_lock` of the run (two calls at the
same moment go one after the other; the second sees the first's message), and the table backs it with a partial unique index (channels
`0007`: one live message with `meta.answer` per `meta.runId`). A message that was **deleted** does not count — the person removed the answer,
so the run is not "answered" — in the tool, in the index and in `runtime-hermes` alike. And the runtime does not post the reply twice: when a
run has posted a live Answer (a message in its thread with `meta.runId` = the run and `meta.answer`), `runtime-hermes` does not post the text
the model printed after the tool call ([runtime-hermes.md](./runtime-hermes.md#the-reply)). A run that never calls the tool replies as before.

## Privacy and memory

- **An answer inherits where it is posted.** In a conversation (`bot_conversation` channel, private to the person) it is read by the asker
  alone, an admin included (`test/answer.test.ts`). In a team channel it is as public as any message there — which is why the audience rule
  above exists.
- **It is never fed to team memory from a private place.** The narrowest-source rule is unchanged and covers it: the memory feed reads
  messages of public channels only (`kind = 'channel'`), a `conversation` run is refused (`conversation`), and a message a bot wrote in a
  public channel during a run that read a private source is withheld by `app.memory_authored_verdict` (`private_source`). Tests assert both
  verdicts on real answers. The answer plugin adds no source of its own to the log.
- **Unknown kinds.** `Message.meta.answer` is parsed with `AnswerPayloadView`: a citation of a kind this client has not seen is
  `AnswerUnsupportedCitation` and is drawn as an "Unsupported source" chip, never an error; a payload that does not read at all leaves the
  message (its text) and drops only the Answer.

## The component

`Answer` (`clients/web/src/channels/Answer.tsx`) is drawn by `MessageRow` for any message whose `meta.answer` is present — the conversation
view, a channel and a thread panel alike. Following `[proto §12]` plate 2:

- the text (`meta.answer.body` — the platform keeps it equal to the message's own body, and the client draws the payload's), with `[n]`
  becoming the number of its source (a link to it; muted when the answer left it out). Only a number the answer has a place for is a marker:
  `[n]` up to its highest citation. `arr[0]` and a `[12]` beyond the last citation stay text;
- numbered citation chips (`data-testid="answer-citation"`) that open the cited item, under the address of the **item's own team**: a message
  in its channel (a reply in its thread, a conversation in the conversation view), a page in Files, a file as a download, a run on its bot's
  Audit tab;
- **Lineage** (`answer-lineage`): number, label, age, the quoted words;
- **Sources reached** (`answer-reached`): `full` and `scoped` dots, "through the asker's own connection";
- **Outside scope** (`answer-outside`): "2 messages · not visible to the person who asked", "1 message · not read by this bot in this run";
- the chips (`answer-followups`, `answer-chips`, inert in this version), and the foot line `answer-for`: "Answered for Omar · scoped · smart".

Ages and quotes (`.an-sn`) are `data-vt-mask`. Section headings are `role="heading"` blocks, never `h5` inside a message. It lays out at 390 px
wide. All colours are tokens.

## How the next tasks extend it

- **P5-27 (memory citations).** Add one member to the `kind` unions: `AnswerMemoryCitation { kind: 'memory', conceptPath, type, trustTier,
  stale, deprecated, fromTeam? }` in `AnswerCitation`, the matching input in `AnswerCitationInput` (`conceptPath`), `'memory'` to
  `ANSWER_CITATION_KINDS`, and a `memory` branch in `app.answer_resolve` (a new migration: read `memory_concepts`, `scope: 'team'`; a
  concept whose `share` is `never` or that came from another team keeps `fromTeam`). Nothing else changes: `lineage`, `sourcesReached` and
  `outsideScope` already carry any `kind`, an old client draws the new citation as unsupported, and `Answer.tsx` gets a `case 'memory'` in
  `citationTarget` and a trust-tier / stale / deprecated note in `Citation`. The payload `version` stays 1: the change is additive.
- **P5-17 (share, save as page, hand to a bot).** Sharing a conversation posts a **new** message with a new payload built from this one:
  keep `citations` whose `scope` is `team`, replace the others by a masked lineage entry ("from <person>'s <source> · not shared": the
  citation's `kind` and `label` stay, the `snippet` goes), and write the access event. The chips become buttons through the `Answer` props
  (`onChip`); `handoff` already names the bot by `botId`. The payload carries everything needed; it is not read again from the database.

## Tests

- `test/build.test.ts` — the pure builder: kept and dropped citations, no label or snippet or id of a dropped one in the payload, numbering,
  the audience rule, `not_reached`, the team of a message, `outsideScope`, `answeredFor`, chips, hostile sizes in linear time.
- `test/rls/answer.test.ts` (`pnpm test:rls`) — the view as the asker: the same bot with a different asker sees a different thing; a person,
  another bot, a finished run or no run is answered `NULL`; the source log is the run's bot's and asker's alone; **what the run reached** (a
  readable, a hidden and a missing id look the same when not reached; the thread a run answers in, a reply a hit was, a page by path or by
  team); **the reply's readers** (a public channel; one a guest has an ACL grant on; one a person of another team has; a grant to the team
  itself; a stale membership row; a private team channel; a run nobody asked); unknown source lines; hostile references; one answer per run
  (deleted, the unique index, two calls at once); the transaction's identity is the bot's again afterwards, also after an error mid-switch.
- `packages/plugins/channels/test/messages-provider.test.ts` — what the provider refuses: another run, another bot, another text, a person.
- `test/answer.test.ts` — the whole path through the real server with a stand-in Hermes that calls the tool over the run's MCP endpoint: a
  conversation answer (search first; one message, no second reply, no trace of the citation the run never reached, private to her, the
  event, memory verdicts), a mention in a team channel (the audience rule), a forged `answeredFor`, a second call, two calls at the same
  moment, an answer smuggled through `messages.post` (400, and a positive control that stores one plain message), a bot that was not granted
  the tool.
- `test/events/answer-events.test.ts` (`pnpm test:events`) — one event type, ids and counts, no team.
- `packages/shared/test/answer.test.ts`, `clients/web/test/answer.test.ts`, `e2e/conversations/answer.spec.ts` (desktop and mobile-web).

## Manifest

`answer` / `0.1.0` / `server`, `extends: ['event.emit']`, capability `answer.post` (not destructive), emits `answer.answer.posted`,
`dependsOn: ['channels', 'bots', 'files', 'repo-git']` (its functions read their tables), migrations `migrations`. The gateway describes
the tool from the same Zod schema the plugin validates with (`packages/plugins/gateway-mcp/src/catalog.ts`).
