# Summaries (P37-06)

The owner asked for a first sidebar entry, Summaries, that opens a calm daily digest: the top action items, the threads that need the person's reply, what is new and needs a look, the next meetings, and quick ways back into what they are in the middle of.

## What it is

A page at `/t/<team>/summaries`, the first entry of the sidebar (order 2, ahead of Chat at 5; not offered to guests). The header reads "Summaries" with today's date and a Refresh button. Under it a greeting and one sentence ("3 things need you, 1 thread is waiting for your reply and you have 2 meetings today."), then five cards and, at the very bottom, a sixth section (see below). A phone shows one column; a wide screen shows two columns, with the last card across both.

| Card | What it holds | Where "See all" goes |
| --- | --- | --- |
| Needs your attention today | open action items (late first, then due today, then the rest), requests waiting for the person's answer (over a day first), action items a meeting gave them | Action items; Approvals |
| Waiting on your reply | threads where someone asked for the person by name (the longest wait first), then threads with new replies | Threads |
| Recent activity | unread mentions, replies, direct messages and invitations, newest first, without the threads already in the card above | Activity |
| Up next | calls going now (with Join), then the meetings of the next seven days (Join from ten minutes before) | Schedule |
| Keep going | chips for the channels and conversations with something new, opened lately or active in the last three days; unsent drafts | (none: the chips are the way in) |

Each card shows its count large, at most five rows (the footer says how many more), a friendly line when it is empty, grey rows while it loads, and a plain "could not be loaded, Try again" that stays inside its own card. A row is one whole link (hover and focus show it); there are no underlined links in the rows.

### Threads you were in lately (P37-09)

The owner asked for the last 10 threads the person has been in at the bottom of the page. It is a full-width section under the five cards, not one of them: it has its own test id (`summaries-recent-threads`), shows up to ten rows (the "at most five rows" rule is for the five cards) and has no "See all". Each row is one whole link to the thread (`/t/<team>/threads?thread=<root id>`, the same link the Waiting card uses): the title (the thread's title, else the first line of its root message), then one muted line: the place ("#dev", "Direct message", "Conversation with a bot"), who wrote last and the reply count (only when the thread is in the Threads list the page already read), and "Opened 20 minutes ago". Newest first, one row per thread. Empty: "Threads you open will show up here."

What counts is a thread the person OPENED, not one they wrote in. When a thread has loaded in `ThreadBody` (the right panel, the Threads page and a bot chat all use it) its root id, channel (id, kind, name), title and the time are written to a small list kept in this browser (`manythreads.recentThreads.<person>.<team>`, `app/recentThreads.ts`: newest ten, a repeat moves to the top, damaged or unavailable storage reads as an empty list). Guests are not recorded. Nothing is fetched per row: a thread that was deleted or has since become hidden keeps its row, and pressing it shows the normal "This thread is not available." The list is per browser, so it does not follow the person to another device; the page reads it again on Refresh.

## Where the data comes from

Nothing is new on the server. The page reads what these screens already read: Action items (`fetchActionItems`), Approvals (`fetchApprovals`, kept live by the approvals change signal), the Threads inbox (`fetchThreadInbox`), the bell's notifications (`notificationStore`), Schedule (`GET /api/appointments?from&to`), live calls (the meetings store), and the sidebar's channels, direct messages, unread counts, notification levels and recently opened places. Each source is read on its own, so one that fails empties only its own card. A route a server does not have (404) reads as an empty list.

Left out on purpose: bot run and delivery results. There is no cheap list of them for a person, and the brief said to add no endpoint for it; a bot's results that need a look already arrive as approvals or notifications.

## Code

- `clients/web/src/screens/summaries/summaries.ts`: the pure rules (what each card shows, the order, "2 hours ago", "In 25 min", the lead sentence). Tested in `clients/web/test/summaries.test.ts`.
- `useSummaries.ts`: the data hook. `SummariesScreen.tsx` and one component per card (`AttentionCard`, `WaitingCard`, `ActivityCard`, `UpNextCard`, `KeepGoingCard`), drawn in `DigestCard.tsx`; `RecentThreadsCard.tsx` is the section at the foot, its rules are `recentThreadRows` and `openedWords` in `summaries.ts`, and the list kept in the browser is `clients/web/src/app/recentThreads.ts` (tested in `clients/web/test/recent-threads.test.ts`; the hook that writes it is in `channels/ThreadPanel.tsx`).
- `clients/web/src/styles/summaries.css` (classes start with `sm-`), imported in `main.tsx`; the route is in `App.tsx`; the entry is in `shell/nav.ts` with its icon in `shell/icons.tsx`.
- e2e: `e2e/shell/summaries.spec.ts`; the sidebar contract spec lists Summaries first.

## Acceptance

1. Summaries is the first sidebar entry for members, absent for guests, and keeps its place when the team is switched.
2. The page shows the title, today's date, a Refresh button that reads every source again, and the five cards.
3. No card shows more than five rows; the rest is counted and linked.
4. A thread asking for the person leads the waiting card; each row names the thread, the channel, who and how long ago, and opens the thread.
5. A meeting offers Join from ten minutes before it starts; a call going now offers Join at once.
6. An empty card says so in friendly words; a failed card says so alone while the others still show.
7. On a 390 px phone the cards stack in one column and the page does not scroll sideways; buttons and rows are at least 44 px tall.
8. Light and dark use the shared tokens only.
9. At the bottom, "Threads you were in lately" lists the last ten threads the person opened, newest first, one row each, every row a link to the thread; it says "Threads you open will show up here." when there are none, and the five cards above still number five.
