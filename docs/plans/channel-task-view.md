# Phase 29 · The task view in the channel

Owner request, 2026-11-16, in short: the mockup of a thread (`temp/theme-preview/shots/graphite-dark.png`) shows, under the Engineer's message, two cards side by side (the to-do card with
"2 of 4" and the live run card with Working, the time, Stop and the steps) and, lower down, a strip "Needs you · Deploy commit 6456bfd to the test site?" with Approve and Not now.
Today those exist only in the thread panel. The owner wants the same picture in the **channel view**, so a person can follow a task, and answer a question a bot asked, without opening the thread.

Status: plan (2026-11-16), not built. Goes into PLAN.md after the owner answers section 10.

Words used on this page:
- **Root**: the first message of a thread. The channel's list shows only roots; the replies live in the thread.
- **Run**: one go of a bot at a request. Its **head** is the small record of where it stands (state, what it is doing now, counts, plan line). Its **steps** are the long list of what it did.
- **To-do card**: the bot's checklist for the thread (`tasks.todo`, one list per thread; items waiting, working, done or blocked).
- **Lease**: a short "I have this open" row the page renews every 20 seconds, so the server knows whom to send live updates to (`app.thread_watchers` today).
- **Push**: a small live message the server sends to open pages over the WebSocket. Here it is only a hint or a head, never a thread's replies.
- **Virtual list**: the channel's message list draws only the rows near the screen (`clients/web/src/channels/VirtualList.tsx`), so a channel with 500 roots has about 20 rows on the page.

---

## 1. Where things stand (checked in the code, 2026-11-16)

| Piece | Today | What it means for this plan |
|---|---|---|
| Channel list | `ChannelView.tsx` draws a `VirtualList` of `MessageRow`. A root shows its text, then `RootChip` ("Engineer is working · 3 of 5") and the "N replies" button (`MessageRow.tsx` ~line 473). | The one place to add the view: under the root, between the chip and the replies button. |
| Run heads | `threadRunsStore` (`clients/web/src/runs/`). The thread panel opens a thread with `open(rootId)`: it reads `GET /api/threads/:rootId/runs`, renews a lease (`PUT /api/threads/:rootId/watch/:leaseId` every 20 s, at most 50 per person), and applies `run.activity` pushes. | `run.activity` (the live head, about once a second) goes **only to lease holders**. A channel page has no lease, so it cannot see a head move. |
| What a channel does get | `useChannelRuns(channelId)` reads `GET /api/channels/:channelId/active-runs` and keeps `run.started` / `run.ended` pushes, which go to every reader of the channel. The server's own comment says "the run's own steps are not pushed to them". | That gives the "working" chip (who, since when) but no state, now line, counts or plan. |
| To-do | `threadTodoStore` + `useThreadTodo(rootId)`: `GET /api/threads/:rootId/todo`, refreshed by `todo.changed` (carries channel, root and a version, sent to **everyone who can read the thread**). It ignores pushes for threads nobody opened. `RootChip` already calls `useThreadTodo` for its "3 of 5", but only for roots that have a working run. | The push already reaches the channel; only a list of the channel's open lists (one read) is missing. Table `app.thread_todos` has an index on `channel_id`. |
| Approvals | `GET /api/threads/:rootId/approvals` (`ThreadApprovals`, under the replies) and the run card's own questions (`RunCard` `useQuestions`, drawn with `ApprovalCard variant="run"`; `setShownQuestions` makes the thread strip skip what a card drew). Push `approval.changed` (team id and approval id) goes to the people who can read the conversation, as a hint to read again. Each `Approval` already carries `channelId`, `threadRootId`, `canDecide`, `blockReason`. Table `app.approvals` has an index on `channel_id`. The decide route answers 409 to a second decision. | One batched read by channel is easy. The decision path, the permission rules and the race handling already exist and stay as they are. |
| Cards | `RunCard`, `TodoCard`, `TodoList`, `ApprovalCard` are drawn for the thread's width (a to-do card is at most 560 px wide). The words and rules live in `run-card/words.ts`, `todo-card/words.ts`, `approvals/sentence.ts`. | The channel view reuses the words and rules (one source), with new compact components. |

Two things found while reading, both fixed by this phase:
1. `ApprovalCard` with `variant="run"` returns before it draws the "View full call" button, but its Yes button is still disabled when the preview is cut short
   (`needsFull`). A run card's question with a long command can therefore never be approved from the card. The new strip draws the button, and the run variant gets it too (P29-05).
2. A person who presses Yes a moment after another person (or another tab) decided gets the raw 409 text as an error. The new strip, and the thread cards, show "Already answered" and read again.

## 2. What the person sees

Under a root that has something going on, in this order (each part appears only when it has something to say):

1. **A row of up to two cards**: the to-do card on the start side, the run card beside it (the mockup's picture).
2. **The question strip(s)**, one per pending approval of that thread (at most two; "and 1 more question, open the thread" after that).
3. The existing "N replies" button, unchanged.

### Compact, not the thread's full cards
| Part | In the channel | Only in the thread |
|---|---|---|
| To-do card | Title, "2 of 4", the bar. Items: all of them up to 5; above 5, every working and blocked item, the one before and the one after, and one line "3 done · 4 waiting" that opens the thread. Same marks and words as the thread (done struck through, working with the owner's picture, blocked "Waiting for a person to approve"). | The whole list, the pin, links to cards in every row. |
| Run card | Bot picture and name, state word (Working, Waiting for you, Stopping), elapsed time, **Stop** (only when `head.canStop`, with an `aria-label`), the one-line "now", the counts line, the plan line when the bot has no to-do card, and the **last 3 steps**. | The whole step list, the view menu (Summary, Progress, Trace), the faded preview of the answer, helper rows. A link "Open thread" in the card's corner goes there. |
| Question | One strip: icon, "Needs you", the question (`runQuestion`, the same words as the run card), the buttons. | The note box ("Tell the bot more"), the age pill, the thread's full approval card. |

**Steps are shown** (owner, through the coordinator, 2026-11-16: "that same visualization"): the compact run card shows the **last 3 steps** like the mockup (Read X, Edit X +38 −4, Helper Look at dark mode, Ran `pnpm lint` Failed) under the summary line. They are read once when the card mounts and again when the head's `seq` moves, at most one read every 3 seconds per card, never once per push (`GET /api/runs/:id/activity?after=` as the thread does, keeping only the last four lines in the store). The faded answer preview and the words of the answer (`run.delta`) stay in the thread.

### Layout
- **Desktop (the channel is wider than about 560 px):** the two cards sit side by side in a two-column grid (`minmax(0, 1fr)` each), same height row, 8 px gap, aligned under the root's text (after the picture column), never wider than the root's text column. With only one of them it takes the full width, up to 560 px like today's card.
- **390 px phone:** stacked, to-do first, then run, then strips, each full width. The to-do card shows its head, the bar and the one current item, with a caret to open the full compact list. The run card is two lines (head with state and time; the now line, cut with an ellipsis) and the counts line. Stop is an icon with a 44 px target. A strip is two rows: the question, then Yes and No as two equal full-width buttons, each at least 44 px high.
- The switch between the two layouts follows the **width of the row** (a CSS container query, as `files.css` already does), not the window: the thread panel beside the channel makes the channel narrower on a wide screen.
- Heights stay still while a run works: the step rows are at most 3, one line each; the now line and the counts line are one line each, cut with an ellipsis; only an item added to or taken from the list changes a height. (The list measures rows with a `ResizeObserver`, so a card that appears above the reader keeps the reader's place.)
- More than one run live in a thread: the oldest two are drawn (the second takes the to-do card's place when the thread has no list), and a line "and 1 more are working" for the rest.

### When it shows and when it goes
| Situation | Shown |
|---|---|
| A run is going (starting, working, waiting, stopping) | The run card, live. |
| The to-do list has an open item and was changed in the last 24 hours (constant `CHANNEL_TODO_FRESH_HOURS`) | The to-do card, even between runs (the bot waits for a person). A list nobody touched for a day is left to the thread. |
| A run just ended | The run card folds into the thread's own one-line end ("Worked 23 s · 4 steps · 1 file changed", `endLine` in `run-card/words.ts`, with its check or failure mark): **5 minutes** for a run that went well, **30 minutes** for a failed or stopped one (a person should notice). Then nothing. |
| Every item done | The card turns into one line "To do · 4 of 4 done" for 5 minutes after the last change, then nothing. |
| A question is pending | The strip, until it is answered, expires or the run ends (then the strip shows the outcome line for the moment it takes to read again, and goes). |
| Nothing going on | Nothing; the row is exactly what it is today. |
| The same thread is open in the right panel | The channel's view of that root folds to the old one-line chip. The panel is the full view and holds the answer buttons, so a question is never asked twice on one screen (the rule of `setShownQuestions`). |
| The reader pressed "Hide" in a card's caret menu | The root shows the chip only. Remembered per thread in the browser (a per-person convenience, not shared). |

The folded lines come from data the server holds (runs that ended in the last 30 minutes), so a reload shows them as well.

## 3. Data path and cost

**The rule:** nothing is asked or renewed per row. A row looks up its root in one in-memory map. A channel has three batched reads when it opens, one lease for the whole channel, and pushes only for threads that have something going on.

```
ChannelBody mounts ──► channelTaskStore.track(channelId)
   ├─ GET  /api/channels/:id/active-runs      (extended: heads of the newest 30 live runs, and a separate `recent` list of heads of runs ended in 30 min)
   ├─ GET  /api/channels/:id/todos            (new: lists with an open item, changed in 24 h)
   ├─ GET  /api/channels/:id/approvals/pending (new: pending approvals raised in threads of the channel)
   └─ PUT  /api/channels/:id/watch/:leaseId   (new: ONE lease for the whole channel, renewed every 20 s)
Pushes (existing ones, plus run.activity now also to channel leases)
   run.started / run.ended   → add or fold a card
   run.activity              → replace that run's head (≤ about 1 a second per live run)
   todo.changed              → read ONE list again, when the version is newer than the one held
   approval.changed          → carries channelId now (additive); a page of another channel ignores it, this channel reads its pending list again (debounced 300 ms)
MessageRow ──► useTaskView(rootId)  (useSyncExternalStore on that root's key; returns a shared EMPTY object when the root has nothing, so most rows never re-render)
```

- **Store.** One module `clients/web/src/taskview/channelTasks.ts` per tab: a `Map<rootId, { runs, todo, approvals }>` plus listeners per root key, the pattern of `usePresenceCard` ("one store, many dots": a card object is kept when equal, so a row draws again only when its own data changed; MISTAKES, P14-01c). It builds on `ThreadRunsStore` and `ThreadTodoStore` instead of copying them: `trackChannel` already exists on the first, a `trackChannel` is added to the second, and the approvals read is new. A root whose panel is open keeps using the panel's own stores (no second copy).
- **Cost per open channel:** 3 reads on open and after a reconnect, 1 small PUT every 20 s (renewal pauses while the tab is hidden and the store reads again when it is shown). Pushes: one `run.activity` per live run per second at most, each under 7 KB, only to people who have that channel open; one `todo.changed` read per change, with the burst limits the store already has; one approvals read per `approval.changed`. With 50 threads on screen and 3 with a run: 3 cards, 3 pushes a second, 0 requests per row. A channel with no activity costs the three reads and the lease.
- **The lease table.** The thread lease is capped at 50 per person and costs one PUT per open thread every 20 s; 50 visible threads would be 2.5 requests a second and would hit the cap. More important: a thread lease also asks for the answer's words (`run.delta` frames, about 12 a second per run). The channel lease asks for the head only. So the channel gets its own lease, not 50 thread leases.
- **Bounds.** At most 30 heads, 50 lists and 50 pending approvals per channel read; the rest fall back to the chip (runs) or to the thread (the rest is never lost, only not drawn in the channel). The clock for "42 s" is one shared one-second timer for all live cards in the tab, not one interval per card; it runs only while a live card is mounted.
- **Virtual list.** Only mounted rows (the window plus 700 px) subscribe. The store keeps updating for unmounted roots (a map write), so scrolling up shows current data at once.

## 4. Server and API changes (all shapes in `packages/shared`, additive, one `schema-compat` snapshot update)

1. **Run heads in the channel read** (`packages/shared/src/api/runs/activity.ts`, `activity-routes.ts`). `ActiveChannelRun` gets an optional `head: RunHead` (present for the newest 30; the route still returns the 100-row chip data in `runs`, which only ever holds live runs: the client turns every row of `runs` into a "working" chip). A **separate** optional `recent: RunHead[]` (max 30) holds runs ended in the last 30 minutes (constant `CHANNEL_RUN_RECENT_MINUTES`), so a reload shows the folded line and an old bundle never shows an ended run as working. The route's table policy decides who sees what; conversation runs stay out (`NOT conversation`). The route is `readOnly: true`. Migration 0009 adds the index `(channel_id, ended_at) WHERE ended_at IS NOT NULL` for the `recent` read.
2. **A lease for the channel.** `PUT/DELETE /api/channels/:channelId/watch/:leaseId`, shapes `ChannelWatchPathParams`, `ChannelWatchResponse` (same as the thread's). Migration `runtime-hermes/0009_channel_watchers.sql` (0008 is `run_stop`): an UNLOGGED table `app.channel_watchers (channel_id, person_id, lease_id, expires_at)` copied from `0007`, with the same SECURITY DEFINER check trigger (a person writes only their own row, in a channel they can read; the system reads all; cap `CHANNEL_WATCH_MAX_PER_PERSON = 8` counting live rows only, a 429 above it). Only a person may hold one (a bot gets 403); a channel the caller cannot read is a 404 by RLS; a bot conversation channel is refused (its runs are the asker's alone); the routes are limited to 240 a minute; the page deletes its lease when it leaves the channel; the run sweep deletes lapsed rows (`run-sweep.ts`, beside the `thread_watchers` line). Registered in the RLS harness's table list.
3. **Who gets `run.activity`** (`run-recorder.ts` `watchers()`): thread leases **union** channel leases, both filtered by `app.channel_audience(channel)` as today, so a person who left a private channel stops receiving at once (the lesson of P25-07 review: "a lease belongs to a panel, not to a person; the audience is checked again when pushing"). `run.delta` (the answer's words) and the step lines stay thread-only; what a channel reader gets is what `GET /api/runs/:id/activity` would already show them as `run`: the head.
4. **Open lists of a channel.** `GET /api/channels/:channelId/todos` (`readOnly: true`) in the tasks plugin (`packages/plugins/tasks/src/todo.ts`), response `ChannelTodosResponse = { todos: ThreadTodo[] }` (max 50): `WHERE channel_id = $1 AND updated_at > now() - 24 h AND EXISTS an item whose status is not done`, plus lists finished in the last 5 minutes. RLS as the thread's read (`thread_todos_select`).
5. **Pending approvals of a channel.** `GET /api/channels/:channelId/approvals/pending` (`readOnly: true`) in the approvals plugin (`routes.ts`), response `ChannelApprovalsResponse = { items: Approval[] }` (max 50): `APPROVAL_SELECT WHERE a.channel_id = $1 AND a.thread_root_id IS NOT NULL AND a.status = 'pending' ORDER BY a.id` through the same `approvalsOf` (so `canDecide` and `blockReason` come from `app.approvals_block_reasons`, set-wise, one pass). Uses the `approvals_channel` index.
6. **`approval.changed` gets optional `channelId` and `threadRootId`** (additive in `ApprovalChangedPush`, `schema-compat` snapshot; both plugins that send it, `approvals/notify.ts` and `memory-share/build.ts`, fill them when the approval has them). Without them every open page would read its list once per approval raised in the team; with them a page of another channel ignores the hint.
7. **No change** to the decide routes, to `todo.changed`, or to the thread routes.

## 5. Live updates (which event does what)

| Event | Who receives it | In the channel it does |
|---|---|---|
| `run.started` | every reader of the channel | adds the chip and asks for **one debounced channel read** (`active-runs`) to get the head. Never a per-thread read. |
| `run.activity` | thread leases and, new, channel leases | replaces the head of a run the channel holds (never moves an ended run back). A run the channel does not know yet: the same one debounced channel read. The existing thread path (`activityPush` for an opened thread) is not changed. |
| `run.ended` | every reader | one debounced channel read (it brings the ended head, so the card folds into the end line); also reads the pending list (a stopped run's question ends). |
| `todo.changed` | every reader of the thread | if the root is tracked or new in this channel and the version is newer: read that one list. |
| `approval.changed` | the people who can read the conversation | when its `channelId` is this channel (or missing, from an old server): reads the channel's pending list again, debounced. |
| a decision made in this tab | this tab (`announceApprovalsChanged`) | the same read at once, for the strip and for an open thread panel together. |
| socket reconnect, tab shown after hidden | this tab | the three reads again and one lease renewal. |

A person who asked for the thing (the requester) cannot decide it; their strip says "You asked for this, so someone else has to decide it" or "Waiting for Rafi to answer" (`whoAnswers`). It appears because `approvals_select` lets the requester read their own approval and `approval.changed` goes to everyone who can read the conversation. (No extra read on a `waiting` state: the people who could miss the push, guests with a channel grant and admins, mostly cannot read the approval at all.)

The to-do's `RootChip` today calls `useThreadTodo` for its "3 of 5"; that call moves to the channel store (`useTaskView`), so a chip never opens a per-thread read.

## 6. Approvals in the channel: same door, same rules

- **One path.** The strip calls `decideApproval(slug, id, decision, note)` (the same API function as `ApprovalCard`), then `announceApprovalsChanged()`. The buttons show only when `approval.canDecide`; the server decides again (403 for the requester, 403 for someone outside the approvers, 409 if already decided). No new rule on the client.
- **Words.** Yes and No for a bot's question, "Allow once" and Deny for a command a bot's program stopped at, Approve and Deny for a platform approval: the same labels as `ApprovalCard` (`yes`/`no` there). The mockup's "Not now" is read as the "No" of the ask (see question 2).
- **The "View full call" rule stays.** When `approval.argsTruncated`, the strip shows "This is cut short" and a **View full call** button for a person who can decide; Yes stays disabled (title "Open the full call first") until the full call has been opened (`fetchApprovalArgs`, which the server answers only to approvers). The strip opens the full call in place (a popover under the strip, reading `Preview`), never the thread. The same fix goes into `ApprovalCard variant="run"` (finding 1 of section 1). To keep the code in one place, the logic moves into one hook `useDecision(approval, slug)` (busy, error, full call, `decide`), used by the card, the run variant and the strip.
- **No duplicate-answer races.** (a) The server is the referee: the first decision wins, a second is a 409. (b) The strip and the thread cards in one tab refresh together through `announceApprovalsChanged`. (c) A 409, or a pending list that no longer holds the approval, shows "Already answered" instead of an error, and the buttons go. The name ("by Rafi") comes from one `GET /api/threads/:rootId/approvals` for that root, read only at that moment; if that fails the line says "Already answered" without a name. (d) Buttons are disabled while a decision is on its way (as today). (e) A root open in the right panel does not draw the strip in the channel (section 2), so one screen never offers the same question twice. (f) A run card in the channel never draws the question itself; the strip does, once (the card shows "Waiting for you" and points at it), so `setShownQuestions` rules need no change: the thread panel's own cards keep theirs.
- **Notes.** The strip has no note box. A person who wants to tell the bot more opens the thread (a "Say more" link in the strip opens it).

## 7. Accessibility

- Each task view is a `<section aria-label="Work in this thread">`; each card a labelled group. **No `role="status"` and no `aria-live` inside the compact cards or the chip in the channel** (ten of them would talk over the reader). One visually hidden live region per channel is the only announcer and says only: a question appeared ("Engineer needs an answer in the thread that starts: Goal: add a Jump to latest button"), a run ended, a run failed. Politeness `polite`, one message at a time, 1 s apart.
- Keyboard: Stop, the card carets, the strip's buttons and "View full call" are real buttons in the tab order after the message's own toolbar; focus rings read `--focus`. A click or a tap inside the view never opens the thread (`rowClickOpensThread` skips targets inside the `NO_THREAD_CLICK` selector list in `messageActions.ts`; the task view's root element is added to it), and the touch gestures of the row (swipe to reply, hold for reactions) do not start on a button.
- Status is never colour alone: the marks of the items (check, dot, warning triangle) and the words ("Waiting for a person to approve", "Failed") are the same as the thread's. Touch targets 44 px on the phone; Stop has an `aria-label` ("Stop Engineer's run"); the strip's Yes and No are two equal buttons on one row. The Hide choice in `localStorage` is read and written inside try/catch (private windows throw). Right-to-left and mixed text: `dir="auto"` on every free text, logical CSS properties.
- Reduced motion: the pulse and the bar move under `no-preference` only (`motion.css`), as the thread's do.
- Screen readers hear the compact to-do as "To do, 2 of 4 done" plus the list; the bar is `role="img"` with the same text.

## 8. Look: tokens and themes

- Reuse the thread cards' tokens: `--run-bg`, `--run-border`, `--run-pulse`, `--run-rail`, `--todo-bg`, `--todo-border`, `--todo-fill`, `--todo-track`, `--elev-1`, and for the strip `--warn-wash`, `--warn-border`, `--warn-ink` (the amber of "Needs you"), `--on-accent` on the filled Yes button, `--control-border` on No. No raw hex, no new font.
- New stylesheet `clients/web/src/styles/task-view.css`, classes prefixed `tv` (the repo's rule: screen stylesheets prefix their classes), and it **never redefines** `.td`, `.rc`, `.apr-*` or `.btn`. The compact cards reuse the thread's classes with a modifier (`.td.tdCompact`, `.rc.rcCompact`) so the colours come from one place; only the layout is new.
- If the strip needs a token that does not exist, it is added in `tools/design/themes.mjs` for **all four palettes (Graphite, Linen, Harbor, Classic) in light and dark**, `node tools/design/build-themes.mjs` regenerates the sheets, and the contrast lint (P28-06) checks the pair. Planned: none.
- Check in all four palettes, light and dark, at 1440 and 390 (section 9).

## 9. Tests

**Unit (vitest, `clients/web/test/`)**
- `channel-tasks-store.test.ts`: first read fills three maps; `run.activity` replaces a head, a late older one is refused, an ended run is not revived; `run.started` for a thread the read did not have; `todo.changed` newer reads one list, equal or older reads none; out-of-order reads; `approval.changed` coalesced to one read; reconnect re-reads all; leave the channel releases the lease and the timers; a root with nothing returns the same `EMPTY` object (no re-render); caps (31st head falls back to the chip).
- `task-view-words.test.ts`: compact windowing of 3, 5, 6, 30 items; the fold timing (5 and 30 minutes, 24-hour freshness); "and 1 more are working"; the question text per kind (ask, command, platform).
- `approval-decision.test.ts`: Yes disabled while `argsTruncated` until the full call is opened; a 403 and a 409 show their sentences; busy blocks a second press; `canDecide` false shows no buttons.
- Server (`packages/plugins/runtime-hermes/test`, `tasks/test`, `approvals/test`): channel lease RLS (a person writes only their own row, only in a channel they read; the 9th lease is a 429); a push audience that includes a channel lease and excludes a person who left the channel; `active-runs` head and the 30-minute window; `todos` freshness and the done filter; `approvals/pending` equals the thread route's rows for the same channel, shows `canDecide`/`blockReason` per caller, hides other teams and private channels the caller cannot read; every new table in the RLS harness; shared schemas round-trip; `pnpm test:schema-compat` snapshot.

**Component**
- `TaskView` with a stub store: the three layouts (both cards, one card, strip only), the open-in-panel fold, Hide, the live region text, no click-through to the thread, and the strip's buttons (Yes, No, "View full call").

**End to end (`e2e/runs/channel-task-view.spec.ts`, on the `runs` stack of P25-12 with the fake agent; no real agent)**
1. A channel with 50 threads (posted by the spec) and one run with a to-do list: the cards appear under that root only; the network log shows **zero** per-thread `watch`, `runs`, `todo` or `approvals` requests and **at most 2** channel lease PUTs in 25 s (a `page.on('request')` counter).
2. The run's now line moves, the counts grow, the to-do's item turns done, without opening the thread; the bar reads "2 of 4".
3. The agent asks a question: the strip shows in the channel, Yes is pressed there, the run goes on, the strip goes, the thread (opened afterwards) shows the same question as answered.
4. Race: two pages as two approvers press at once: one wins; the other shows "Already answered", no error alert.
5. Permissions (and, in the server tests, a guest with a channel grant gets heads and lists but not approvals): the requester sees "You asked for this, so someone else has to decide it" and no buttons; a member outside the approvers sees "Waiting for ..."; a call with a cut-short preview keeps Yes disabled until "View full call" is pressed.
6. Open the thread in the panel: the channel's view of that root folds to the chip, and the question is asked once on the screen. Close it: the view returns.
7. Stop from the channel. The run ends: the folded line shows, and is still there after a reload.
8. At 390 px: stacked, nothing scrolls sideways (`noSidewaysScroll`), the buttons are 44 px high, the strip's two buttons are on one row.

**Screenshots** (`MANYTHREADS_THEME_SHOTS` style, to `temp/screenshots/p29`, git-ignored): the channel with both cards and a strip, in the four palettes, light and dark, at 1440, plus the Graphite dark and Linen light at 390; the first one is checked side by side with `graphite-dark.png`. The contrast check of `themes.spec.ts` is extended to the compact cards and the strip.

Gates as always: `pnpm lint`, `pnpm typecheck`, the tests of the packages touched, never together with another heavy job (CLAUDE.md, the devbox rules).

## 10. Risks and open questions for the owner

Risks
- **A busy channel.** Many live runs at once crowd the list. Bounded by 30 heads, two cards per thread, the fold, and the 24-hour and 5/30-minute limits; the per-thread Hide helps. Watch it on the live site with the Engineering channel.
- **A card appearing above the reader's place.** Handled by the list's anchoring; the e2e spec scrolls to an old root while a run starts below and checks the text did not move.
- **More pushes to people who only look.** Bounded to open channels with a lease; if it ever hurts, the channel push can be cut to one per 2 s per run without a shape change.
- **Two copies of the question UI.** Avoided by the shared `useDecision` hook and the shared words.

Open questions (each with the default this plan follows)
1. ~~Steps in the channel?~~ **Decided (owner via coordinator):** the last 3 steps are shown; the answer preview stays in the thread.
2. **Button words.** The mockup says "Approve" and "Not now". Default: keep the words the thread uses (Yes / No for a bot's question, Allow once / Deny for a command, Approve / Deny for a platform approval), because a "Not now" that actually answers no would be misleading. Say if you want "Not now" for a question's No.
3. **How long folded lines stay.** Default: 5 minutes after a good run, 30 after a failed or stopped one, 24 hours for a to-do list with open items. Say if these should be longer or shorter.
4. **A switch in Settings?** Default: no global switch; each card can be hidden per thread. A "Show work in channels" switch under Settings → Appearance is a small addition if you want it.
5. **Roots with a pending approval but no run or list** (a platform approval raised from a thread, for example `email.send`): default: they show the strip only. Approvals raised in a channel with no thread are not shown in the message list (the Approvals page has them).

## 11. Tasks (go into PLAN.md as Phase 29, after Phase 28)

| ID | Task | Status |
|---|---|---|
| P29-00 | This plan (revised after the review of 2026-11-16) | Done |
| P29-05 | First, alone: `useDecision` hook; `ApprovalCard` (all variants) on it; "View full call" in the run variant; the "Already answered" sentence for a 409; tests | Not built |
| P29-01 | Shared shapes: `ActiveChannelRun.head`, `recent`, `ChannelWatch*` and `CHANNEL_WATCH_*`, `CHANNEL_RUN_RECENT_MINUTES`, `ChannelTodosResponse`, `CHANNEL_TODO_FRESH_HOURS`, `ChannelApprovalsResponse`, `ApprovalChangedPush.channelId`/`threadRootId`, routes; schema-compat snapshot | Not built |
| P29-02 | runtime-hermes: migration 0009 `channel_watchers` (RLS, cap, trigger, `recent` index), sweep, the two lease routes, the union audience in the recorder, heads and `recent` in `active-runs`; tests | Not built |
| P29-03 | tasks: `GET /api/channels/:id/todos`; approvals: `GET /api/channels/:id/approvals/pending` and the push's channel; tests including RLS, private channels and a guest with a grant | Not built |
| P29-04 | Client store `taskview/channelTasks.ts` (its own merge path for heads, last steps read, todo `trackChannel`, approvals read, `useTaskView`, shared one-second clock, `RootChip` moved onto it); unit tests | Not built |
| P29-06 | Components with their CSS, accessibility and component test each: `TodoCompact`, `RunCompact` (with the last 3 steps), `QuestionStrip`, then `TaskView` mounted under the root in `MessageRow` with the chip, Hide and the open-in-panel fold; `task-view.css` (desktop two columns, 390 px stacked, container query, 44 px targets, tokens only, four palettes light and dark); the channel's one live region | Not built |
| P29-09 | e2e `channel-task-view.spec.ts` (eight cases above) and the `p29` screenshots (Graphite dark and light, one more palette, 1440 and 390); `docs/testing.md` section | Not built |
| P29-10 | Docs: `docs/plugins/runtime-hermes.md` (channel lease, heads), `tasks.md`, `approvals.md`; STATUS.md; MISTAKES.md; PLAN.md rows | Not built |
| P29-11 | Deploy and live check with the Engineering bots (the coordinator deploys after the proofs) | Not built |
