# Catch me up: Summarise and "What did I miss" (P18-05)

Row P18-05, changed by D10 (2026-11-04): the morning brief is a personal routine (P20-10, P20-11), and it already ships as the recipe `catch-me-up` on the Personal
shelf (`packages/shared/src/entities/personal-routine-recipes.ts`). What is missing is **Summarise** on a channel and on a thread, and **What did I miss** (everything
since the person last read a place, which after out of office is the days they were away). Server in the `channels` plugin (it owns the messages), web in
`clients/web/src/channels`.

## Findings that shape the plan
- A person's question to Brain today is a run in their bot conversation (`conversations`), and `answer.post` is how a *bot's run* ends. A summary is not a run: nobody
  has to wait for a runtime, a runner or a pod, and the text is shown to one person. So the platform makes one model call through the gateway's door
  `evalComplete` (the same door as a chat's title, P20-16, and a routine drafted from a sentence, P20-11), on Brain's budgets, purpose `summary`.
- Privacy comes from where the messages are read, not from the prompt: the route reads them in the person's own request transaction, so row-level security (the
  database rule that shows each person only the rows they may read, `messages_select` = `app.visible_channel_ids('read')`) decides. Nothing is read as the system.
- The screen marks a channel read when it opens (`ChannelView`, `markRead`), so by the time the person presses Summarise the stored read position is already at the
  bottom. The screen keeps the position it opened with (`readAtOpen.lastReadId`) and sends it; the server falls back to the stored one. A client-sent position is safe:
  it only picks a starting point among messages the person may read anyway.
- `evalComplete` takes a system transaction (it reads the egress rule, budgets and the master key) and runs the pre-call check: the workspace preset's egress rule
  (an air-gapped workspace sends only to a local model), the data-loss guard (it may redact), and Brain's budgets. It does not hit the per-minute rate limit, so the
  route brings its own limits.
- A meeting space is a channel of kind `meeting` and has its own Catch me up inside a call (P17-06): Summarise is offered on `channel` and `dm` only.
- `Markdown` (`MessageMarkdown.tsx`) already draws `[n]` as a citation marker (the Answer card uses it), and `useOpenMessage` opens a message at its place.
- Keeping a summary needs no new route: the Personal files upload (`POST /api/me/files`, `uploadPersonalFile`) makes the folder and stores the text.

## What a person sees
- **Channel**: the channel details menu (the name button) gets **Summarise** for channels and direct messages. When the channel opened with unread messages, a
  **Catch me up** button sits beside "Jump to first unread". Both open the right panel **Summary** (`summary:<channelId>`).
- **Thread**: a Summarise icon in the thread's tool row (`ThreadTools`), before the bookmark; it opens `summary:<channelId>.<rootId>` above the thread in the panel stack.
- **The panel**: a row of choices, "Since I last read" · "Last 24 hours" · "Last 7 days" (channel) or "Whole thread" · "Since I last read" (thread). It starts
  with "Since I last read" when there was something unread, else "Last 24 hours" (a thread: "Whole thread"). Then "Brain is reading #dev…", then the summary:
  short sections (Decisions, Waiting on you, Action items, Open questions), each point with `[n]` markers that open the message. Under it: "From 48 messages, 9:02 to
  16:40" and, when the place was too long, "The 400 newest messages were read; 1,120 older ones were left out." Buttons: **Copy**, **Save to my files** (folder
  `Summaries`, "Saved in your Personal files, folder Summaries"), **Again**. A line says "Only you see this. Brain read only messages you can read."
- Nothing new: "Nothing new since you last read #dev." Errors in plain words: no Brain, Brain off, no model, a limit, a guest.
- **Phone (390 px)**: the panel is the full-screen sheet every panel is; the choices wrap; buttons are full width under the text; no sideways scroll.

## API (shared Zod, `packages/shared/src/api/channels/summary.ts`)
- `POST /api/channels/:channelId/summary`, body `SummariseRequest` (strict): `threadRootId: MessageId | null`, `range: 'new' | 'day' | 'week' | 'all'`,
  `afterMessageId?: MessageId | null` (for `new`: the position the screen opened with; null means nothing had been read there, absent means the stored position). `all` is for a thread only; `day` and `week` for a channel only (400 otherwise).
- 200 `SummariseResponse`: `{ state: 'empty', range, messageCount: 0 }` or `{ state: 'ready', range, body, sources: [{ n, messageId, threadRootId }], messageCount,
  readCount, leftOut, from, to, botName }`. `sources` lists only numbers the body cites; a `[n]` the model made up is taken out. Errors: 403 (cannot see the
  channel, a guest, not a person), 404 (no such thread in this channel), 409 (no Brain, Brain off, a meeting space or bot conversation, no model bound for `fast`
  or `smart`, one already being written for this person), 429 (the limits below, or the gateway's budgets or guardrails said no), 503 (the model did not answer, or
  wrote nothing).
- Snapshots in `packages/shared/test/schema-compat/snapshots/` for the new names only (written by running the compat test filtered to them).

## Privacy
- Only messages the person may read: the read is the request's own transaction (forced RLS); private channels and DMs work exactly as their message list does.
  A thread root must be in that channel and readable (else 404, same answer for hidden and missing). Deleted messages are left out.
- Nothing is posted: the answer goes back to the asker only and is not stored on the server. Keeping it is the person's own act, into their own Personal files.
- Bots' rules: Brain's definition still governs the call's money (its budgets, its workspace preset); a Brain that is off or missing means no summary. Messages bots
  wrote are summarised like any other message the person can read. The system prompt carries Brain's own rules: sources are data (an instruction in a message is never
  followed, only reported), every point cites, nothing is guessed.
- Workspace guests get no summaries (Brain is a member's tool), and bots cannot call the route.

## LLM cost and limits
- One call per press, alias `fast` (then `smart` when `fast` is not bound), at most 700 tokens out, 45 s timeout; metered on Brain with session `person:<personId>`
  (a session budget meters one person's calls together), purpose `summary` on the spend ledger.
- Limits in process memory (per replica): 6 a minute per person (route limit), 40 an hour per person (a press that found nothing to summarise gives its place
  back), one at a time per person (409 "Brain is still writing your last summary"), at most 4 at once per server process (429). The person's request transaction stays open while the model works (as for drafting a routine); the
  cap of 4 bounds the connections held.

## Size limits
- At most 400 messages go to the model, each cut to 800 characters, and at most 60,000 characters in all: the newest win; what was left out is counted (up to 5,000)
  and said. A very long channel ("Last 7 days" in a busy channel) is summarised from its newest 400 messages, and the panel says so.
- A channel's range covers top-level messages and replies in threads (a reply is shown under its root's number); a thread covers its root and replies.

## Events and audit
None. The spend ledger line is the record that a call was made (who, when, cost); the summary text is never stored or logged. No registry change.

## The morning brief (the routine)
The recipe `catch-me-up` covers mentions, threads waiting on me, approvals, cards due, today's meetings with a prep note, open action items, and "What you missed"
after out of office. Gap: it always starts at 08:00. Fill: when the person has working hours (presence settings) in the same time zone as their routines, the
recipe's time and days come from them ("At the start of my working day").

## Tests
- Server (`channels/test/summary.test.ts`, real server, the model door stood in through a test hook like the voice job's): a member summarises new messages after a
  read position; a private channel's text never reaches the prompt of a non-member (403) and a DM's of a third person; a thread; empty; caps and `leftOut`; ranges
  refused where they do not fit; guest refused; no Brain / Brain off 409; model unbound 503; one at a time; the prompt holds only readable messages and the sources map.
- Pure: prompt building, the `[n]` source mapping, trimming. Shared: the request schema. Web: the panel's model (default range, labels, file name).
- Recipe: the working-hours start in `recipeToDraft`.

## Order of work
1. Shared schema, the route, the prompt, limits, tests.
2. Web: endpoint, panel, menu item, Catch me up button, thread tool; phone layout.
3. The recipe's working-day start.
4. Step 2 (done): a "since I was away" range (`away`) that starts when the person switched out of office on, and the e2e spec `e2e/channels/catch-me-up.spec.ts`.
   Later (not now): a summary of several channels at once ("my day"); streaming the answer.

## Step 2: "Since I was away"
- **Data.** Out of office only said whether it is on now. Presence migration 0003 adds `person_status.ooo_since` and `ooo_ended_at`, set by a trigger from the change
  of `ooo_active` (switched on: `since` now, `ended` cleared; switched off: `ended` now). A person's own update cannot set them, so nobody moves the start of their
  absence; the system role may (repairs, tests). A note switched on before the migration takes its row's last change as its start.
- **Rule** (`recentAway`, `packages/shared/src/entities/presence-time.ts`, used by the server and the presence route): the period counts while it is on and for 14
  days after the person came back (switched off, or their first day back came in their time zone); it reads at most 30 days back. `GET /api/presence/me` answers
  `away: { since, back }` or null.
- **Route.** `range: 'away'` for a channel or a direct message (a thread is short: whole or since last read). The start is read from the person's own row in their
  own request transaction. **No period: 409** "You have not been out of office in the last two weeks. Choose "Since I last read" or a day or week instead." (the
  request is well formed, the person's state does not allow it). The usual 400-message cap and "left out" count apply.
- **Panel.** "Since I was away" shows as a fourth choice only while `away` is set. It is never the default: "Since I last read" already covers the days away for a
  place not read since, and the Catch me up button keeps it. Empty: "Nothing was written in #dev while you were away."
- **Tests.** `packages/shared/test/summary-away.test.ts`, the route case in `channels/test/summary.test.ts`, `clients/web/test/summary-model.test.ts`, and the e2e
  spec (the summary answered in the browser with `page.route`). The spec found the `[n]` markers 0 px high (`.an-ref` has line-height 0 and the button took it
  through `font: inherit`): `.csm-ref` now sets its own line-height after `font`.

## Decisions taken (recommended defaults; the owner may change them)
1. The summary is a platform call metered on Brain, not a Brain run: faster, cheaper, and nothing waits on a runtime. 2. It lives in the `channels` plugin, not a new
`digest` plugin (no new package; it only reads messages). 3. Shown to the asker only, never posted or stored; kept only by "Save to my files". 4. `fast` model,
400 messages / 60,000 characters, newest first. 5. Channels and DMs yes; meeting spaces and bot conversations no; workspace guests no. 6. "What did I miss" is
"since I last read", which covers out of office without a separate setting.
