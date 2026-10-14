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
| `chips[]` | `followup` `{ label, prompt }`, `handoff` `{ botId, botSlug, botName }` — data; what a chip does is the conversation view's ([Sharing an answer](#sharing-an-answer-p5-17)) |
| `share` | only on a copy a person shared: `{ masked, removed }`, counts of the citations replaced by a masked one and of the claims taken out |

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
   line before a bot can cite one, and until then those citations are `not_reached` — an open item.) The view reads the first **20,000**
   lines of a run's log (a ref is cut to 1,100 characters inside `app.answer_run_sources`, migration `0002`: longer than any citation can be, and
   never held in full; a cited thread is reached by a reply through a primary-key probe of the message ids the log names, not by comparing
   every reply with every line). A run that logged more is marked
   `logTruncated` in the view, and the tool's reply tells the model so: a source it read after the cap is reported as not reached, which is
   the one way a genuinely read citation can be dropped as `not_reached`.
2. **The view.** Every reached citation and every line of the log is re-read **as the asker**. The function adds no policy of its own: it is
   `SECURITY INVOKER`, runs as `manythreads_app` under the same forced RLS every request has, and for the length of the call switches the
   transaction's identity (`app.actor_id`, `app.actor_kind`) to the run's asker — the identity `ctx.runs.asReader` gives a read tool — then
   switches back (in a block of its own: an error rolls the switch back with it). There is no argument that names a run or a person: the
   function reads the run from `app.run_id()` and answers only when the transaction's actor is that run's bot (or the live run is missing,
   finished, or the caller is someone else: `NULL`). A source that is hidden and one that does not exist are the same `{ found: false }`.
3. **The audience.** Decided from who will actually read the reply, once per call (`reach`):
   - `asker`: the reply is in the asker's own bot conversation **and the asker is its only reader** (from `app.channel_audience`, not from
     the channel's kind alone: an ACL grant on the conversation makes it `none`), so everything they may open stays;
   - `team`: the reply is in a channel of the run's team whose **actual readers** (`app.channel_audience`: the team, workspace owners and
     admins, anybody an ACL entry names, a private channel's members only while on the team) are each a workspace owner/admin or **an active,
     non-guest workspace member on that team's roster** — the test `lookup_team_role` applies: a roster row alone is not membership (it
     survives a demotion to guest, and a guest with an ACL grant reads the channel without being the team). A source of the team's own (a
     public channel of the team, a team page or file, a run of the team's) is kept; the asker's private places are not;
   - `none`: anybody else may read it — a guest or a person of another team with an ACL grant on the channel, a private channel the bot cannot
     read, a direct message. Only what lives **in the reply's own channel** is kept.
   Anything the asker can read but the reply's readers cannot is dropped as `not_shared`. The decision is a function of the channel's
   readers (`app.answer_reply_reach`, one `channel_audience` read per call), never of a label on the source: the previous cut let a `team` scope label stand for "everybody in
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
- the chips (`answer-followups`, `answer-chips`; buttons in the asker's own conversation, drawn and inert anywhere else), the foot line `answer-for`:
  "Answered for Omar · scoped · smart", and, on a shared copy, a line that says how it was cut (`answer-share-note`: "Shared by Omar · 1 source not
  shared · 1 claim removed"). A **masked** citation (`data-kind="masked"`) reads "from Omar's message · not shared": no link, no label, and its
  lineage row says "snippet removed".

Ages and quotes (`.an-sn`) are `data-vt-mask`. Section headings are `role="heading"` blocks, never `h5` inside a message. It lays out at 390 px
wide. All colours are tokens.

## Sharing an answer (P5-17)

An answer lives in its asker's own conversation: private to them, an admin included. Three acts make its content reach other people, and each is
a request by the asker alone, addressed by the answer's own message (`/api/channels/:conversationChannel/messages/:answer/answer/...`; anything
that is not the caller's own answer is a **404**, for an admin and a teammate alike):

| Act | Route (plugin) | What it does |
|---|---|---|
| list targets | `GET .../answer/targets` (conversations) | team channels the caller may post in (the picker) |
| preview | `POST .../answer/preview` `{ target, remove }` (conversations) | the copy exactly as it would be posted, per citation `kept` / `masked` / `removed`, counts, `audience` (`team` or `wider`), and its `digest` |
| share | `POST .../answer/share` `{ targetChannelId, remove, digest }` (conversations) | posts the masked copy into the channel **as the sharer**; 201, or 200 `replayed: true` for the same share again |
| save as page | `POST .../answer/page` `{ remove, digest }` (pages) | writes the same copy as `pages/answers/<slug>-<id8>.md` through the one repo writer; 200 `created: false` when this answer was saved before |
| hand to a bot | `POST .../answer/handoff` `{ botId }` (conversations) | the answer, as the person's own message in their own conversation with another bot |

**The rules** (each one has a test):

1. **Who reads, decided from the readers.** The target's reach comes from `app.answer_channel_reach(channel, team, asker)`, which is the rule
   `answer_reply_reach()` always had, now one function over `app.channel_audience` for both (the bot's reply and a person's copy): `team` when
   every reader is an owner/admin or an active, non-guest member on the answer's team; `none` when anybody else may read (a guest or a person of
   another team with an ACL grant, a DM, a person demoted to guest who keeps a roster row); `asker` for the asker's own conversation. A page of
   the answer's team is read by that team and its admins: `team`; a page of another team, `none`.
2. **Which citations those readers may open, as the sharer, now.** `app.answer_share_view` (migration 0003, `SECURITY INVOKER`) re-resolves
   every citation of the stored answer with `app.answer_resolve` under the sharer's own RLS against that reach. A source is **kept** only when
   found and shown to the readers (team-readable, or living in the target channel itself, or reach `asker`). A source the sharer can no longer
   read, one deleted since, an edited one (its label is read again, never copied, and the bot's quote of it goes when the label moved; "Sources
   reached" labels are read again too), anything of the asker's own run, a private channel's message,
   a DM, another team's page: **masked**. A citation with no verdict is masked: absent is never "may be shown". Entries of "Sources reached"
   that cannot be proven (a connection, a memory bank, anything not a message, file, page or run) are dropped and counted as `not_shared`.
3. **A masked citation is its number and its kind** (`{ kind: 'masked', n, source }`, strict): no label, scope, date or snippet, and **none of
   the fields that say where the source lives** — no `teamId`, `channelId`, `channelName`, `path`, `fileId`, `runId`, `botSlug`. A masked
   lineage row has an empty label, no age and no snippet. The text is unchanged: readers see that a claim rests on something they cannot open.
4. **Remove claim is removal only, and fails toward removing more.** A request carries citation numbers, never text. The copy's text is the
   answer's own with the sentences that carry a removed `[n]` taken out (`removeClaims`, linear, fenced code untouched); the provider checks
   again that it is a subsequence of the original. The unit is a *block* (a paragraph with its hard-wrapped lines, a list item with its wrapped
   lines, a quote, a heading; a table row goes whole), not a line. A sentence ends at a stop followed by white space, unless the next word starts
   in lower case or with a digit or the stop closes an abbreviation (`e.g.`, `U.S.`, `Dr.`, an initial): where the extent is ambiguous the claim is
   never left behind, at the price of an innocent neighbour going with it. No list of abbreviations is relied on: a split that may be wrong
   (a stop after a word of four letters or fewer or after a number, or after a token with a dot inside it such as `v2.3` or `a.txt`, or before a
   character that is not a letter, as in `Sen. Warren`, `Corp. Annual`, `ca. €3M`, `Am 3. Mai`; and any `?`, `!` or `…`, a run of stops or a
   closing quote or bracket after the stop, as in `Yahoo! Finance`, `now... Warren`, `"Can we ship Friday?" Dana asked`) is *soft*, and when the unit after a soft split goes, the unit before it goes
   too (and so on back). A marker group written after the stop and a space (`claim. [2] Next.`,
   `[1], [2]`) belongs to the sentence before it **and**, when text follows, to the one after it (it may be a prefix): both go; so does a
   paragraph or list item that is nothing but a removed marker (`[2]` alone): it takes the last unit of the block right before it. Markers are `[2]`,
   `[1, 2]`, `[1-3]`, `[ 2 ]`, `［2］` and `【2】`, and a group counts as removed when any number in it is (white space includes NBSP, thin and
   zero-width spaces; scripts written without spaces, and the Urdu and Hindi stops, end a sentence at the stop). A fenced block or an inline code
   span that holds a removed marker goes whole; a fence with no closing line is ordinary prose and shields nothing after it. A removed marker that
   survives a cut takes its whole block. The preview lists the words that go (`removedText`)
   and the text as it will be posted. Nothing can add a word, a citation, a source or a chip (chips are dropped: a follow-up or a hand-off is the
   asker's own next step).
5. **What the person confirms is what is posted.** The preview returns a sha-256 of (target, answer, copy); share and save take it back and the
   server rebuilds the copy from the live readers first. A copy that would now read otherwise (a reader joined the channel since) is a **409**
   with nothing posted.
6. **The post is the one write.** Through the `messages` provider with `copyOf: <answer>` — the provider verifies the claim against the stored
   original (same run, bot and asker, the caller is the asker, the answer is in their own conversation channel, citations a subset by number
   and unchanged when kept, lineage and sources reached subsets, no chips) — so the copy is a normal message of the person: permission,
   thread rules, `channel.message.posted`, push, unread. An answer's message cannot be edited (409): delete it and share again.
7. **Idempotent.** `app.answer_share_find` under a lock of (answer, kind, channel, sharer, digest) returns the live copy; a replay posts
   nothing and answers 200. A different cut has a different digest and is a new copy, reached only through its own preview. A copy that was
   deleted is replaced by the next share of the same key.
8. **The conversation stays private.** The copy is a message in the channel; the conversation's own channel, thread and runs are unchanged. The
   asker's conversation index row is marked `shared` through `app.conversations_mark_shared` (conversations 0002) only for a channel of the bot's
   team that is **not private** (a private room's copy is posted and the conversation stays private: the rest of the team would be listed a row they
   cannot open, and learn that a share happened), so the team lists it under Shared and reads it through the copy. Deleting the copy makes the
   conversation private again (a trigger), and the Shared list shows only rows whose copy is live and readable by the reader.
   A posted copy is nobody's request: the router fires no trigger for a person's message that carries an Answer, so an `@bot` planted in the text
   by a source wakes nobody.
9. **The access event** `answer.answer.shared` (v1): `kind` (`channel`, `page`, `handoff`), `personId`, `botId`, `runId`, `messageId` (the
   answer), `channelId`, `copyMessageId`, `keptCount`, `maskedCount`, `removedCount`, `maskedNumbers`, `removedNumbers`. Ids, counts and the
   numbers of citations; never an id, label, snippet or team of a source, and no `teamId` (workspace-scoped: a team-scoped row is readable by
   the whole team, and the answer is a private conversation's). The sharer's own lines are in `app.answer_shares` (RLS: the sharer reads them).

**Hand to a bot.** The chip is stamped by the platform from a bot of the team that existed when the answer was written; the route accepts only
a `botId` the answer's own chips name, a bot of the team, active, with a `conversation` trigger, and not the answering bot. It opens (get or
create) the asker's own conversation with that bot — the existing `conversations_open` door — and posts there, as the asker, the question
(their own first message), the answer's text and the names of its sources; the router then runs the bot for them as for anything typed there.
No capability is involved, so a bot can never message a person through it. *Masking for a bot*: a bot is a reader whose visibility is the
asker's (its run is the asker's run), and the destination is the asker's own conversation, whose only reader is the asker, so
`answer_channel_reach` is `asker` and nothing is lost. If somebody was given access to that conversation (an ACL grant), the reach is `none` and
the hand-off is masked exactly like a share to that audience.

**Accepted residuals.** (a) A copy is a stored message: people who join the channel later read it as it was masked at share time (a copy is not
re-judged for new readers; deleting it and sharing again is the remedy). (b) The copy keeps `answeredFor.runId` — the id of the asker's own
conversation run, which only the asker can read (bots 0011) and which opens nothing; making it nullable would change a shared schema for no
reader's gain. (c) The page is saved once: a second save of the same answer, on any day and with any cut, answers with the existing page and its
counts, and edits to it are the Files screen's. (d) `answer_channel_reach` reads a channel's whole audience per preview and share (the cost grows
with the channel's readers; the routes are limited to 120 and 30 a minute). (e) **Segmentation is a proximity heuristic, not a provenance guarantee.** A claim is "the sentence a marker sits in (or next to)"; a model can keep a claim by putting its marker in another block, by paraphrasing the claim in a sentence that carries no marker, or by writing a marker in a form no reader parses. The control is the preview the sharer confirms: `removedText` (the words that go) and the text as it will be posted, with the digest binding the two to what is written. (f) The client draws only `[n]` as a superscript: `[1, 2]`, `[1-3]` and the full-width forms are removed by the share and shown as text. (h) A soft split can cost one extra neighbour sentence: a sentence that ends in a short word (`…is done.`), a number, `?` or `!`, or before a bracket, a quote or emphasis, followed by a sentence that carries a removed marker, goes with it, and a chain of such splits goes back as far as it runs; the preview lists the words. (g) Segmentation of stored model text is a heuristic that errs toward
removing more; a sentence the sharer wants kept next to a removed claim can be lost, and the preview says exactly which words go.

**Not done here.** The Drive-specific masked source (a person's connection) is phase 8: until `person:*` reads write citable sources, a
person-scoped citation is the asker's own conversation run and `sourcesReached` lines with the `scoped` marker. Seed v5 (P5-21) is the guard
seed (gate, DLP, egress) and has no such source; the tests build theirs.

## How the next tasks extend it

- **P5-27 (memory citations).** Add one member to the `kind` unions: `AnswerMemoryCitation { kind: 'memory', conceptPath, type, trustTier,
  stale, deprecated, fromTeam? }` in `AnswerCitation`, the matching input in `AnswerCitationInput` (`conceptPath`), `'memory'` to
  `ANSWER_CITATION_KINDS`, and a `memory` branch in `app.answer_resolve` (a new migration: read `memory_concepts`, `scope: 'team'`; a
  concept whose `share` is `never` or that came from another team keeps `fromTeam`). Nothing else changes: `lineage`, `sourcesReached` and
  `outsideScope` already carry any `kind`, an old client draws the new citation as unsupported, and `Answer.tsx` gets a `case 'memory'` in
  `citationTarget` and a trust-tier / stale / deprecated note in `Citation`. The payload `version` stays 1: the change is additive. The share
  door needs one more arm in `app.answer_share_view` (a memory citation is kept for the team reach when its concept is team-readable, never
  for `none`); until then it is masked, which is the safe answer.

## Tests

- `test/build.test.ts` — the pure builder: kept and dropped citations, no label or snippet or id of a dropped one in the payload, numbering,
  the audience rule, `not_reached`, the team of a message, `outsideScope`, `answeredFor`, chips, hostile sizes in linear time.
- `test/rls/answer.test.ts` (`pnpm test:rls`) — the view as the asker: the same bot with a different asker sees a different thing; a person,
  another bot, a finished run or no run is answered `NULL`; the source log is the run's bot's and asker's alone; **what the run reached** (a
  readable, a hidden and a missing id look the same when not reached; the thread a run answers in, a reply a hit was, a page by path or by
  team); **the reply's readers** (a public channel; one a guest has an ACL grant on; one a person of another team has; a grant to the team
  itself; a stale membership row; a person demoted to guest who keeps a roster row and holds an ACL grant; a private team channel; a
  conversation with an ACL grant on it; a run nobody asked); unknown source lines; hostile references; one answer per run
  (deleted, the unique index, two calls at once); the transaction's identity is the bot's again afterwards, also after an error mid-switch; **a long log** (20,001 lines: `logTruncated`
  and a late source `not_reached`; exactly 20,000: not marked; 40 thread citations against 20,000 lines; no reference longer than 1,100 held); **a reply nobody can be
  shown to** (a suspended asker, an asker demoted to guest: no readers, so `none`).
- `test/post.test.ts` — what the tool tells the model: the "log is cut" sentence appears only when citations were removed from a run whose log was longer than the view reads.
- `packages/plugins/channels/test/messages-provider.test.ts` — what the provider refuses: another run, another bot, another text, a person.
- `test/answer.test.ts` — the whole path through the real server with a stand-in Hermes that calls the tool over the run's MCP endpoint: a
  conversation answer (search first; one message, no second reply, no trace of the citation the run never reached, private to her, the
  event, memory verdicts), a mention in a team channel (the audience rule), a forged `answeredFor`, a second call, two calls at the same
  moment, an answer smuggled through `messages.post` (400, and a positive control that stores one plain message), a bot that was not granted
  the tool.
- `test/events/answer-events.test.ts` (`pnpm test:events`) — one event type, ids and counts, no team.
- `packages/shared/test/answer.test.ts`, `clients/web/test/answer.test.ts`, `e2e/conversations/answer.spec.ts` (desktop and mobile-web).
- **Sharing (P5-17).** `packages/shared/test/answer-share.test.ts` (the masking function with hostile inputs in linear time, `removeClaims` as a
  deletion only over random strings, the page and the hand-off text, the event); `test/rls/answer.test.ts` "sharing an answer" (the sharer's view
  against a team channel, a private room, a guest's channel, another team's, a DM, the asker's own conversation and the pages; a person demoted
  to guest; the source read again; hostile payloads; `answer_channel_reach`; the access log); `test/events/answer-events.test.ts`;
  `packages/plugins/conversations/test/share.test.ts` (the whole path through the server: who may touch an answer, preview, share, replay,
  guest- and other-team channels, removal, the event, Save as page, Hand to a bot); `packages/plugins/channels/test/messages-provider.test.ts`
  (`copyOf`); `clients/web/test/answer-share.test.ts`; `e2e/conversations/share.spec.ts` (desktop and mobile-web).

## Manifest

`answer` / `0.1.0` / `server`, `extends: ['event.emit']`, capability `answer.post` (not destructive), emits `answer.answer.posted`,
`dependsOn: ['channels', 'bots', 'files', 'repo-git']` (its functions read their tables), migrations `migrations`: `0001` the asker's view, `0002`
the bounds of the view (thread reach by key probe, references cut inside the function), `0003` sharing (`answer_channel_reach`,
`answer_shares`, `answer_share_view`, `answer_share_find`, `answer_share_record`). The gateway describes the tool from the same Zod schema the
plugin validates with (`packages/plugins/gateway-mcp/src/catalog.ts`). The sharing routes are the `conversations` and `pages` plugins'
(they own the conversation index and the repo writer); the plugin's SQL is what they ask.
