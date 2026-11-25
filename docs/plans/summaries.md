# Summaries (P37-06)

The owner asked for a first sidebar entry, Summaries, that opens a calm daily digest: the top action items, the threads that need the person's reply, what is new and needs a look, the next meetings, and quick ways back into what they are in the middle of.

## What it is

A page at `/t/<team>/summaries`, the first entry of the sidebar (order 2, ahead of Chat at 5; not offered to guests). The header reads "Summaries" with today's date and a Refresh button. Under it a greeting and one sentence ("3 things need you, 1 thread is waiting for your reply and you have 2 meetings today."), then five cards. A phone shows one column; a wide screen shows two columns, with the last card across both.

| Card | What it holds | Where "See all" goes |
| --- | --- | --- |
| Needs your attention today | open action items (late first, then due today, then the rest), requests waiting for the person's answer (over a day first), action items a meeting gave them | Action items; Approvals |
| Waiting on your reply | threads where someone asked for the person by name (the longest wait first), then threads with new replies | Threads |
| Recent activity | unread mentions, replies, direct messages and invitations, newest first, without the threads already in the card above | Activity |
| Up next | calls going now (with Join), then the meetings of the next seven days (Join from ten minutes before) | Schedule |
| Keep going | chips for the channels and conversations with something new, opened lately or active in the last three days; unsent drafts | (none: the chips are the way in) |

Each card shows its count large, at most five rows (the footer says how many more), a friendly line when it is empty, grey rows while it loads, and a plain "could not be loaded, Try again" that stays inside its own card. A row is one whole link (hover and focus show it); there are no underlined links in the rows.

## Where the data comes from

Nothing is new on the server. The page reads what these screens already read: Action items (`fetchActionItems`), Approvals (`fetchApprovals`, kept live by the approvals change signal), the Threads inbox (`fetchThreadInbox`), the bell's notifications (`notificationStore`), Schedule (`GET /api/appointments?from&to`), live calls (the meetings store), and the sidebar's channels, direct messages, unread counts, notification levels and recently opened places. Each source is read on its own, so one that fails empties only its own card. A route a server does not have (404) reads as an empty list.

Left out on purpose: bot run and delivery results. There is no cheap list of them for a person, and the brief said to add no endpoint for it; a bot's results that need a look already arrive as approvals or notifications.

## Code

- `clients/web/src/screens/summaries/summaries.ts`: the pure rules (what each card shows, the order, "2 hours ago", "In 25 min", the lead sentence). Tested in `clients/web/test/summaries.test.ts`.
- `useSummaries.ts`: the data hook. `SummariesScreen.tsx` and one component per card (`AttentionCard`, `WaitingCard`, `ActivityCard`, `UpNextCard`, `KeepGoingCard`), drawn in `DigestCard.tsx`.
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
