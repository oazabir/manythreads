# The meeting assistant, live (P17-06)

Row P17-06. Plugin `packages/plugins/meetings`, the run seam `packages/sdk/src/meeting-runs.ts` and its runtime `packages/plugins/runtime-hermes/src/meeting-run.ts`, web
`clients/web/src/meetings`. The **assistant** is what a person in a live call asks for help: **Ask** (a question answered from the call so far), **Catch me up** (what was said
before they came), and later **Mark action item** and the **end-of-call review**. Brain is the workspace's own answering bot (`templates/_workspace/bots/brain/BOT.md`).

## Findings that shape the plan
- A bot answers a question in a call only through `MeetingRunsProvider.answer` (P15-24): a run of the bot as the asker, its reads checked after the run against the channels
  **every person present** may read (`readStayedInside`), the answer thrown away when it read anything else. Brain is asked through the same door, not through a thread
  `@brain` mention: the router's prompt is the message only (no transcript), and its run has no such check.
- That door refused Brain: `open()` wants `bot.team_id = teamId`, and the workspace Brain has no team. It also answers "busy" as `budget` (one meeting run of a bot at a
  time, `openRunOf`); for Brain, which many people use, busy is common, so a busy answer is its own outcome and the ask waits its turn (re-queued every 5 s, for two minutes).
- A bot may post in a team channel only inside a run of its own (`visible_channel_ids` gives a bot no channel outside one; the note-taker's `postAsBot` works because it is a
  team bot). So the runtime posts Brain's answer into the call's thread inside the run, after the check (`postTo`). The note-taker's path is unchanged.
- The live transcript is readable by every reader of the call's channel (`meeting_segments_select`); the thread is in that channel. So lines put in front of Brain, and an answer
  posted to the thread, show nobody a line they could not read already. A person's words are used only when they said yes (`renderTranscript`; the insert trigger blanks the rest).
- A model call that waits seconds must not hold a transaction (MISTAKES P32-04): Ask and Catch me up are detached jobs; the answer comes back as a push to the asker only.
- `llm.evalComplete` (gateway-llm) is the one plain model call a plugin may make; it needs a bot to charge (Brain, else the room's note-taker). `purpose` is free text in the
  ledger (gateway-llm 0006); `meeting_catchup` is added to its type.
- No P9-08 surfaces exist, so the end-of-call review (step 2) is a simple panel of our own, not a surface.
- Live check (2026-11-25) failed on the Brain path: with searches checked only after the run, Brain searched 60 times for eight minutes and its answer was thrown away
  (`messages.search` and `meetings.search` answer every channel the asker reads); every `knowledge.search` was refused because `app.knowledge_run_grant()` answered the
  bot's own team (none for the workspace Brain); and the panel showed nothing for an API-asked question. Fixed: a meeting answer run records the call's channel
  (`bot_runs.channel_id`) and the gateway holds it BEFORE it reads (gateway-mcp `meeting-runs.ts`: only message, file and meeting searches, memory and knowledge are
  offered; searches answer the call's own channel only; at most 8 tool calls); the run door stops an answer after 90 s ("Brain took too long. Try a shorter
  question."); knowledge 0006 answers the run's team for a workspace bot; the route pushes `asking` at once and every way the job ends pushes an answer or a failure.
- The answer prompt kept its first line (`Answer a question asked in a meeting.`), so the stand-in models of the tests and the e2e stack answer it unchanged.
- A private channel, a direct message and a meeting space have no Brain (the router and `visible_channel_ids` keep bots out of them): Ask there needs the room's note-taker.

## What a person sees (step 1)
- **Desktop**: an **Ask** button (chat-question icon) in the call bar opens a panel above the bar's right end (360 px wide, at most 60 % of the window high, scrolls inside).
  Header "Ask Brain" or "Ask Note-taker" (the room's note-taker, when there is one). A text box "Ask about this call…", **Ask**; under it the person's own questions this
  call, newest first: "Brain is looking…", then the answer, or one plain sentence why not. "Answers are also posted in the call's thread" with **Open the thread**. When Ask
  is not possible here the box is replaced by the reason ("Brain does not answer in private channels or direct messages. Add a note-taker to ask questions here.").
- **Catch me up** at the top of the panel, and as a row in the bar for a person who came 2 or more minutes after the start: "You joined 12 minutes in. Catch me up". The panel
  button reads "Catch me up · 12 minutes so far" (minutes before the person joined). Pressed: "Writing a summary…", then the summary ("What was said before you joined"), or
  "Nothing was written down before you joined." (no transcribed line, or transcription was off).
- **390 px**: the panel is a full-width block inside the call sheet, above the controls; the box and the button stack; nothing wider than the screen.

## Rules (who may do what)
- Ask and Catch me up: a person **in the live call** now (a participant row, not left). A link guest never (no session route answers a guest). A workspace guest who is in the
  call may use both; Brain answers as them (their reads), and the answer is checked against everyone present. A run's asker must be on the run's team
  (`runs.open`), so Brain answers only people of the call's team (an admin from another team is told so).
- **With a note-taker in the room**, Ask goes to the note-taker through `questions.ts` (P15-22, P15-24): the asker must have said yes to "Transcribe my voice" (409 "Say yes
  to Transcribe my voice to ask Note-taker." otherwise), six questions a minute per room, one at a time, stale after two minutes, the answer as a caption and in the thread.
  A typed question needs no model check (it is addressed on purpose, as a thread `@mention` is).
- **Without one**, Brain answers: the call must be in a public team channel (Brain must be able to post there); Brain must be active. The prompt carries the question and the
  **transcript so far** (the last 30 minutes, at most 30,000 characters, only words of people who said yes, read as the asker); Brain's own tools (its memory, messages,
  meetings and files search) are the rest. Its reads must stay inside the channels everyone present may read, or the answer is thrown away ("Brain could not answer from what
  everyone in the call may read."). The answer goes to the thread as "**Nadia asked Brain:** …" and as an answer caption for the people in the call.
- **Catch me up**: lines whose start is before the person's `joined_at`, read **as that person** (row-level security), words only of people who said yes; the summary is pushed
  to that person only and is not stored or posted.

## Data
No new table in step 1: asks and summaries are not kept (the answers are thread messages; a summary is a push to one person). A shared table arrives with step 2 (marked items).

## Step 2: Mark action item and the end-of-call review (built)
- **Mark** (`POST /api/meetings/:id/marks`, the flag button in the call bar): a person in the live call keeps the final lines that ended in the last 30 seconds (read as them,
  only people who said yes; refused with a plain reason when nothing was written down or transcription is off). Table `meeting_marks` (meetings 0015): read by the readers of
  the call's channel, written by a person in the live call as themself, at most 30 each, never changed.
- **Review** (`meeting_reviews`, one row per call, made by the platform in job `meetings.review`): opens when the call has ended, at once with a note-taker (its notes are
  the organizer's own copy and stay out), else when the Scribe's notes are written or fail, ten minutes after the end at the latest. Items: the notes' action items, then the
  marks, the same words once (at most 50). Read by the people who were in the call while they can read its channel. Event `meetings.review.opened` (ids, the count): the
  notifications plugin writes one `meeting_actions` notification per person ("Review 3 action items from …") that opens the meeting page, where the panel is.
- **Confirm** (`POST /api/meetings/:id/review/confirm` `{items, seen}`): one person for everyone, as themself; edited words and owners (people who were in the call, or a
  member the notes named); removed items left out. Event `meetings.action_items.confirmed` (ids and counts, audited). Job `meetings.review.apply` writes the confirmed items
  into `meeting_notes.items` and the "Action items" section of `notes.md` (the rest of the file untouched). Notes that arrive after a confirmation open the review again.
- **Web**: the mark in the call bar (`meetings/assistant.ts`, `CallDock.tsx`), `screens/meetings/ReviewPanel.tsx` on the meeting page, push `meeting.review`.
- **Decisions taken**: the review lives on the meeting page (a notification leads there), not in the call bar, because a call's notes come minutes after it ends; Confirm is
  once for everyone (first wins, the others see who confirmed); the owners named by the notes are still notified when the notes are written (unchanged), the follow-ups of
  P17-07 will start from the confirmed event; the notification reuses the kind `meeting_actions` (no notifications migration), so a person who is both an owner and a
  reviewer gets one row for the meeting.

## API (shared Zod in `packages/shared/src/api/meetings/assistant.ts`; schema-compat snapshots updated by name only)
- `GET /api/meetings/:meetingId/assistant` → `MeetingAssistantStatus` `{ ask: { available, answerer: { kind: 'brain'|'notetaker', name } | null, reason },
  catchUp: { available, minutesBefore, reason } }`.
- `POST /api/meetings/:meetingId/ask` `MeetingAskRequest` (strict, `question` 1–500 characters) → 202 `MeetingAskResponse` `{ askId, answerer }`.
- `POST /api/meetings/:meetingId/catch-up` (no body) → 202 `MeetingCatchUpResponse` `{ requestId, minutesBefore }`.
- Pushes (to the asker's tabs only): `meeting.ask` `MeetingAskPush` `{ meetingId, askId, state: 'asking'|'answered'|'failed', answererName, text, question }`
  (`asking` from the route at once, then exactly one of the others); `meeting.catchup`
  `MeetingCatchUpPush` `{ meetingId, requestId, state: 'ready'|'empty'|'failed', minutesBefore, text }`.
- Seam: `MeetingAnswerRunInput` gains `who`, `typed`, `transcriptMd`, `teamMemory`, `roomChannelId`, `deadlineMs`, `postTo { channelId, threadRootId, heading }`; `MeetingAnswerRunResult` gains `busy` and
  `answered.messageId`. The runtime accepts a workspace bot (`scope = 'workspace'`) for the room's team.

## Events and audit
None new in step 1: an answer is a thread message (its `channel.message.posted`), a run is a run (`bot_runs`, the source log, the spend ledger), a summary is a read. Step 2's
confirmed action items get `meetings.action_items.confirmed` (ids and counts only) with an audit mapper.

## Limits and model cost
Routes: ask 10 a minute per person, catch-up and status as listed in the route. In the jobs: Brain answers six questions a minute per room (the note-taker's limit);
Catch me up three times in ten minutes per person per call; one model call per summary (`fast`, at most 500 tokens out, 30 s), the transcript cut to its last 60,000
characters before the join. Brain's runs go through the same pre-call check and budgets as every run; the summary through `evalComplete` (preflight, ledger line
`meeting_catchup`).

## Tests
- meetings `test/assistant.test.ts` (a real server, fake media, fake Hermes and fake fast model): Brain answers in the thread with the transcript in its prompt and without the
  words of a person who said no; a person not in the call is refused; a DM call says why; with a note-taker the panel question reaches the note-taker's run and its caption, and
  a person who said no is refused; Catch me up summarises only lines before the join and only of people who said yes, an early joiner gets "nothing", a stranger is refused,
  the per-person limit; busy Brain waits its turn.
- Units: the transcript excerpt (cut from the end at a line, consent), the prompts (markers, the cut), the ask prompt in runtime-hermes.
- Web `test/meetings-assistant.test.ts`: the store (ask, pushes, a lost push, catch-up states), the labels ("Catch me up · 12 minutes so far").
- e2e `e2e/meetings/assistant.spec.ts` (step 2, with the journeys): desktop and 390.

## Order of work
1. **Ask and Catch me up** (this change): seam, routes, jobs, panel, tests.
2. **Mark action item and the end-of-call review**: `meeting_marks` (RLS: readers of the call's channel; written by people present), "Mark action item" takes the final lines of
   the last 30 seconds (people who said yes only); at the end the notes' action items plus the marks open a review for the people present: edit text and owner, remove, Confirm
   ("Confirm before sending: 3 action items"); only confirmed items go into the notes' list and the follow-ups of P17-07. In-app panel and a notification, not a P9-08 surface.
   Then the e2e spec, the W baselines `meetings/ask-panel` and `meetings/review`, the live check. Built (see "Step 2" above); the e2e spec covers the mark refusal and
   the review panel; the baselines and the live check are still to do on the live site.

## Decisions taken (recommended defaults; the owner may change them)
1. Brain answers through the meeting-run door (with the room's channel check), not a thread `@brain`, so it can see the transcript and cannot leak another channel into the call.
2. With a note-taker present the note-taker answers, never Brain (one answerer per room).
3. A typed question to the note-taker still needs the asker's yes to transcription (P15-22's rule, kept as written).
4. Brain only in public team channels; elsewhere Ask needs a note-taker.
5. Catch me up covers what was said before the person first joined; it is shown to them only and not kept.
6. The transcript in Brain's prompt is the last 30 minutes (30,000 characters).
7. No new events or tables in step 1.
