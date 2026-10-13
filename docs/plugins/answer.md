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
  words from the source. **No label, no scope, no date, no id of a channel**: those are read, not claimed.
- `outsideScope` (at most 12) — `{ kind, count }`: what the bot knows it could not reach (a connection that was not granted). Never a title.
- `chips` (at most 8) — `{ kind: 'followup', prompt, label? }` or `{ kind: 'handoff', botSlug }`.

A call that names `answeredFor`, `lineage`, `sourcesReached`, `scope`, `version` or any person or run is answered `{ ok: false, code:
'platform_field' }` with the field's name; the strict schema refuses anything else it does not know (`invalid_arguments`).

`AnswerPayload` (stored on the message as `meta.answer`, `version: 1`):

| Field | What it is |
|---|---|
| `body` | the text (the message's own body is the same text, for search and for clients that do not draw the Answer) |
| `citations[]` | the citations the asker may open, each with `n` (its position in what the bot sent — a dropped citation leaves a gap, nothing is renumbered), `kind`, the ids needed to open it, a `label` the platform read and a `scope` |
| `lineage[]` | one entry per kept citation: `n`, `kind`, `label`, `at` (when the source was written), `snippet` (the bot's quote, trimmed) — "how old is each thing this rests on" |
| `sourcesReached[]` | what the run read, from its source log (`run_source_log`): `kind`, `ref`, `label`, `marker` `full` or `scoped` (`scoped`: through the asker's own connection) |
| `outsideScope` | `{ count, items: [{ kind, reason, count }] }` — never a title, a snippet or an id. Reasons: `not_visible`, `not_granted`, `not_shared` |
| `answeredFor` | `{ personId, name, scope: 'scoped' \| 'team', alias, botId, runId }` — the run's asker; `team` for a run nobody asked |
| `chips[]` | `followup` `{ label, prompt }`, `handoff` `{ botId, botSlug, botName }` — **data only**; what a chip does is P5-17's |

`scope` of a citation uses the words the run's source log has: `team` (anybody on the team may open it: a public channel, a team page or file,
a run of the team), `channel` (only the people of a private place: a private channel, a DM, a conversation), `person` (the asker's own
connection, or their own conversation run).

## What the platform does with a call

1. **The view.** `app.answer_view(citations, slugs)` (migration `0001`) re-reads every citation and every line of the run's source log **as the
   asker**. It adds no policy of its own: it is `SECURITY INVOKER`, runs as `manythreads_app` under the same forced RLS every request has, and
   for the length of the call switches the transaction's identity (`app.actor_id`, `app.actor_kind`) to the run's asker — the identity
   `ctx.runs.asReader` gives a read tool — then switches back. There is no argument that names a run or a person: the function reads the run
   from `app.run_id()` and answers only when the transaction's actor is that run's bot (or the live run is missing, finished, or the
   caller is someone else: `NULL`). A source that is hidden and one that does not exist are the same `{ found: false }`, so the bot cannot
   tell which.
2. **The audience.** A reply in the asker's own conversation is read by the asker alone, so everything they may open stays. A reply in a team
   channel (a `mention` or `channel_message` run) is read by the channel: a citation is kept only when it is in the reply's own channel, in a
   public channel of the run's team, a team page or file, or a team run. Anything else the asker can read but the channel cannot is dropped as
   `not_shared`. This is the §6.3 masking decided at post time, in the one place that knows the reply's readers.
3. **The payload.** `buildAnswer` (pure, `src/build.ts`) keeps the readable citations, drops the rest into `outsideScope`, takes every label,
   scope and date from the view, builds `lineage` and `sourcesReached`, resolves hand-off chips to bots of the team that exist and are active
   (an unknown slug, or the answering bot itself, is dropped), and stamps `answeredFor` from the run. The payload is parsed with
   `AnswerPayload` before it is stored; a payload over 96 KB is refused (`too_large`).
4. **The message.** It is posted through the **`messages` provider** (`ctx.providers.get<MessageProvider>('messages')`, registered by the
   channels plugin, extension point `provider.messages`) — the one `postChannelMessage` every message takes, as the run's bot — into the
   run's own channel and thread: the model names neither. `meta` is `{ answer, runId }`. A provider and not the `messages.post` capability,
   because a capability is what a model can be granted and call with arguments of its own; `messages.post` accepts no `meta`, so no tool can
   forge an Answer (a test pins it).
5. **The event.** `answer.answer.posted` (v1): `workspaceId, botId, runId, askerPersonId, channelId, messageId, threadRootId, citationCount,
   droppedCount, reachedCount`. Ids and counts only, and **no `teamId`**: an answer to a person's private conversation is theirs, and a
   team-scoped event row is readable by every member of the team (`events_select`). Like `conversations.conversation.started`, it is
   workspace-scoped.

The tool answers the model `{ ok: true, messageId, citationsKept, citationsRemoved, message }` — a count of what was removed, never what —
or `{ ok: false, code, message }`: `platform_field`, `invalid_arguments`, `no_run`, `no_thread` (the run was not asked in a thread), `already_answered`,
`too_large`, `unavailable`, or a refusal of the channel's own (`forbidden`, `conflict`).

**One answer per run.** A second call says `already_answered`. And the runtime does not post the reply twice: when a run has posted an
Answer (a message in its thread with `meta.runId` = the run and `meta.answer`), `runtime-hermes` does not post the text the model printed
after the tool call ([runtime-hermes.md](./runtime-hermes.md#the-reply)). A run that never calls the tool replies as before.

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

- the text, with `[n]` in the text becoming the number of its source (a link to it; muted when the answer left it out);
- numbered citation chips (`data-testid="answer-citation"`) that open the cited item: a message in its channel (a reply in its thread, a
  conversation in the conversation view), a page in Files, a file as a download, a run on its bot's Audit tab;
- **Lineage** (`answer-lineage`): number, label, age, the quoted words;
- **Sources reached** (`answer-reached`): `full` and `scoped` dots, "through the asker's own connection";
- **Outside scope** (`answer-outside`): "2 messages · not visible to the person who asked";
- the chips (`answer-followups`, `answer-chips`, inert in this version), and the foot line `answer-for`: "Answered for Omar · scoped · smart".

Ages and quotes are `data-vt-mask`. It lays out at 390 px wide. All colours are tokens.

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
  the audience rule, `outsideScope`, `answeredFor`, chips, hostile sizes in linear time.
- `test/rls/answer.test.ts` (`pnpm test:rls`) — the view as the asker: the same bot with a different asker sees a different thing; a person,
  another bot, a finished run or no run is answered `NULL`; the source log is the run's bot's and asker's alone; the reply's readers;
  hostile references; one answer per run; the transaction's identity is the bot's again afterwards.
- `test/answer.test.ts` — the whole path through the real server with a stand-in Hermes that calls the tool over the run's MCP endpoint: a
  conversation answer (one message, no second reply, no trace of the citation the asker could not read, private to her, the event, memory
  verdicts), a mention in a team channel (the audience rule), a forged `answeredFor`, a second call, an answer smuggled through
  `messages.post`, a bot that was not granted the tool.
- `test/events/answer-events.test.ts` (`pnpm test:events`) — one event type, ids and counts, no team.
- `packages/shared/test/answer.test.ts`, `clients/web/test/answer.test.ts`, `e2e/conversations/answer.spec.ts` (desktop and mobile-web).

## Manifest

`answer` / `0.1.0` / `server`, `extends: ['event.emit']`, capability `answer.post` (not destructive), emits `answer.answer.posted`,
`dependsOn: ['channels', 'bots', 'files', 'repo-git']` (its functions read their tables), migrations `migrations`. The gateway describes
the tool from the same Zod schema the plugin validates with (`packages/plugins/gateway-mcp/src/catalog.ts`).
