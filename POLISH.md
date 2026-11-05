# POLISH — a walk through the app as a Slack / Mattermost / Teams user

Written 2026-11-04 after using the live site (https://manythreads.kahf.to) as a person would: signed in as Omar (owner) and
Nadia (member), desktop 1440×900 and phone 390×844. I opened every route in the router, then tried the interactions: hover
actions, reactions, threads, composer (mentions, slash, formatting), search, Ctrl+K, notifications, menus, dialogs, settings,
the bots screens, mobile. Screenshots were taken with Playwright; the finding ids below are stable so they can become tasks.

I only read the code where I needed to confirm a gap (e.g. grep for typing indicator, dark theme, document title). No product
code was changed. One side effect on the live site: while probing the header I starred `#dev` and then un-starred it again
(verified: no "Starred" section left). A voice-room attempt also ran once and showed the "not set up" bar.

Effort tags: **S** = a CSS/copy change, **M** = a component change, **L** = new behaviour. Impact: ★★★ everyone sees it daily,
★★ often, ★ occasionally.

---

## 0. The short version

The app is **clean, calm and consistent**: one font (Inter), a restrained blue/grey/purple palette, good empty-state copy,
honest error text, a real keyboard-shortcut sheet, a working "New" line, typing indicator, drafts, reminders, send-later, polls.
The bones are better than most self-hosted chat tools.

What stops it feeling like Slack/Teams is **density and hierarchy**, not missing features:

1. The message list wastes space (an avatar + name + time on every line, even five in a row from the same person).
2. Everything has the same visual weight — page titles, panel headings, bot rows, chips — so nothing leads the eye.
3. A lot of **internal wording leaks into the UI** (`handover.mayTag`, `OKF memory bundle`, `Answered for Nadia · scoped · smart`,
   file paths as titles, `task_assigned`).
4. There is **no dark mode**, no unread count in the browser tab, and the phone layout breaks in a few places (channel name
   unreadable, bot page buttons overlap text).
5. Bot-heavy surfaces (Bots, Org chart, bot answers) are text-heavy walls, where a person wants status at a glance.

Top ten, in the order I would do them, are in §9.

---

## 1. The channel / message view (the screen people live in) ★★★

### 1.1 Group consecutive messages from the same author (M, ★★★)
Seen in `#general`, `#dev`, DMs: Omar posts twice in a row and each gets its own 32 px avatar, name, presence dot and timestamp.
Slack/Teams/Mattermost collapse a run of messages by one author within ~5 minutes: first line shows avatar + name + time, the
rest show only the text, with the time appearing on hover in the avatar gutter. Doing this roughly **halves the height of busy
channels** and makes who-said-what readable. (There is no grouping logic today: nothing in `channels/listItems.ts` or `timeline.ts`.)

### 1.2 The timestamp is monospace, grey, and 8 px away from the name (S, ★★)
`09:03` in a mono face next to the name reads like a debug field. Use the body font in tabular numerals, a slightly lighter
grey, and show the full date + time in a tooltip on hover. For messages older than today, hovering should show "Mon 26 Oct,
20:39". I saw no tooltip or full date on the time in my session; worth checking.

### 1.3 The presence dot beside every message author is noise (S, ★★)
Green dot / hollow circle after the name on every message. Presence belongs on the avatar (a small corner badge, as in Teams
and Slack) and in the member list, not as inline punctuation on each line. Moving it to the avatar also frees the name row.

### 1.4 Hover toolbar: add the three most-used reactions (M, ★★★)
The hover bar is `reply · react · more`. Slack/Teams show 2–3 quick reactions (👍 ✅ 👀, or "recently used") **in** the bar, one
click, and keep "add reaction" as the fourth. Today a reaction is: hover → click smiley → pick from a 7-emoji popover → click.
Also: the popover has a bare `…` for "more emoji" — label it "More…", and add a search box when it opens the full picker.

### 1.5 Hover toolbar is missing obvious actions (M, ★★)
"Mark for later", "Remind me", "Copy link" and "Forward" live in the `···` menu — good — but I did not find **Pin** or **Copy text** in the
menu (Mark for later and Remind me are there). Add a keyboard path as well: with a message focused, `E` edits, `R` replies,
`Ctrl+Shift+C` copies link. Show the shortcut in each menu row at the right edge.

### 1.6 The "N replies" link is plain blue text (M, ★★)
`3 replies · last 22:13` is the entire thread preview. Slack shows small avatars of the participants + "3 replies" + "Last reply
2 hours ago", and highlights when you have an unread reply. Without participants you cannot tell whether a thread involves you
or a bot. Add participant avatars (max 3) and a bold/blue dot when unread.

### 1.7 Reactions: the pill is fine, the "add" affordance is missing (S, ★★)
There is no `+` pill after existing reactions (Slack shows a faint smiley-plus at the end of the row). Right now a reaction that
already has 2 people can only be added to by clicking the pill itself or going back up to the hover bar. Add the faint `+`.
Hovering a reaction pill should list who reacted (tooltip) — I could not see any.

### 1.8 Day dividers should stick and be a pill (S, ★)
`Monday 26 October` is a thin rule with grey text — readable, but when scrolling you lose the day. Make the date a rounded pill
centred on the rule, sticky to the top while that day is in view, and say "Today / Yesterday / Mon 26 Oct" consistently (already
partly done).

### 1.9 Long bot prompts bury the conversation in `#dev` (M, ★★)
Many top-level messages are 200-character prompts followed by "3 replies". For long messages (> ~4 lines) clamp to 4 lines with
a "Show more" link; the first screen of `#dev` is currently four paragraphs of prompt text. Also render `@brain` etc. as a
*chip* (soft background) instead of just blue text so bot mentions stand out from human mentions.

### 1.10 Mentions: the autocomplete is tiny and shows no avatar (S, ★★)
Typing `@ra` gives a one-row popup `Rafi ○ @rafi`. Show avatar + name + handle + a "Bot" tag, group People / Bots / Channels, and
allow `@channel`/`@here` suggestions at the top (Slack's habit). The popup also overlaps the formatting toolbar edge.

### 1.11 `:emoji:` autocomplete does not exist (M, ★★)
Typing `:smi` shows nothing. Slack, Teams and Mattermost all open a small emoji list after two characters after a colon. Easy win
with the existing emoji data in `channels/emoji.ts`; render the glyph + `:name:`; Tab/Enter to accept.

### 1.12 Composer: formatting bar is a row of 11 icons that only appear on focus (M, ★★)
When focused the toolbar fills the box: `B I S </> Code block > ≡ 1. ↗ @ # ☺ ▤`. Two problems: the icons are hard to tell apart at
12 px, and the box jumps taller when it opens (the message list shifts up by ~30 px — visible in my screenshots). Reserve the
toolbar height (or show it permanently, like Slack) so the list does not jump; make the icons 16 px with hover tooltips showing
the shortcut (`Ctrl+B`). Typed markdown (`**bold**`) is shown raw in the box; a small live preview is optional, but at the very
least `Ctrl+B/I/K` should work.

### 1.13 The Send button looks disabled until you type, and is very wide (S, ★)
Grey, with an icon and the word "Send" — and a chevron next to it for send-later. Make it an icon-only circular/rounded button
that turns primary-coloured with content (the word "Send" duplicates `Enter`); keep the chevron but give it its own tooltip
("Send later").

### 1.14 Thread panel composer overflows and is inconsistent with the main composer (S, ★★)
In the right-hand Thread panel the formatting toolbar runs past the panel edge (the `@` icon is clipped at 1415 px, a second
row of icons is cut off) and it is **always visible**, whereas the main composer shows it only on focus. Same component, two
behaviours. Wrap the toolbar or collapse the less-used icons under a `…` in narrow widths. On a phone (see §8) it scrolls
sideways.

### 1.15 "Jump to latest" and the toast overlap content (S, ★★)
In the thread screenshots the "Jump to latest" pill and the "#dev marked as read." toast both float over the last message and the
composer. Anchor "Jump to latest" to the bottom-centre *above* the composer with a gap, show an unread count in it ("↓ 12 new
messages"), and put toasts in the bottom-left corner away from the composer.

### 1.16 Pressing Esc silently marks the channel read (S, ★★)
Esc is documented ("Mark the open conversation as read") but it fires when you press Esc to close a menu or popover too: I
closed the star/header menus and got "#dev marked as read." each time. That is destructive-ish (you lose the New line) and
surprising. Only treat Esc as "mark read" when nothing else is open and focus is on the message list; keep the toast with an
**Undo**.

### 1.17 Channel header: too many unlabeled icons, two bells (M, ★★★)
The header has: `Start voice room` (labelled), 🔔 (channel notifications), ☆ (star), `Integrations` (text), `Bot Board` (pill), 🔖
(bookmarks), and then, far right, the global 🔔 with a red "22". Two bells next to each other mean different things (channel
notification level vs. your inbox), and the icons have no labels. Suggestions:
- Move **channel notification level** into a channel-details menu (click the channel name — today clicking the title did nothing visible) with Notifications, Star, Pin, Members, Integrations, Files, Leave.
- Keep only: channel name (with member count), topic, Search-in-channel, Members, a Call button, and the global inbox bell.
- Show a member avatar stack + count (e.g. "6") that opens the member list; there is no way to see who is in a channel from the
  header right now.

### 1.18 The channel title is the first thing to be truncated (S, ★★★)
With the thread/search panel open the header becomes `# …  Day-to-day engineering discussion an…` — the **channel name is hidden
while the topic is shown**. On a phone it is `# …` too. Title must have `flex-shrink: 0` and `min-width: min(40%, 16ch)`; the topic
is what truncates (and shows in a tooltip).

### 1.19 There is no channel-start intro (M, ★)
DMs say "This is the start of your conversation with Nadia." Channels do not show a topic/description/members intro at the top
of history. Slack's "This is the very beginning of #dev" card (topic, who created it, "Add people") is a good onboarding hook.

### 1.20 DM header is "Nadia, Omar" with no avatar (S, ★★)
The DM title lists both people (including yourself) and has no avatar/status. Show the *other* person: avatar, name, presence,
status text, local time ("7:32 pm there"), as Teams does. Also: DM search is a text box in the header while channels have none —
make search-in-conversation consistent (a magnifier icon that expands).

### 1.21 Bot replies are the most important content and look like quotes (M, ★★★)
In threads, a bot's answer renders as a bordered white card containing the text (`PING`) and a mini-footer such as
`Answered for Nadia · scoped · smart`. Longer answers add `LINEAGE`, `SOURCES REACHED`, `Message` rows (see mobile thread shot).
- The card makes short replies look like errors/quoted text. Use a normal message with a small purple "Bot" tag; reserve the card
  for answers that carry sources.
- Collapse sources/lineage behind a "Sources (3)" disclosure — they are longer than the answer today.
- Replace `scoped · smart` with words a person understands ("Used your private notes · fast model") or hide it behind a
  tooltip / "Details".
- Bot authors use cartoon avatars of different animals (frog, koala, panda, cow…) that look like profile pictures of people;
  add a consistent small "BOT" badge on the avatar corner so the eye can separate them from humans.

---

## 2. Sidebar and navigation ★★★

### 2.1 The sidebar does too much at once (M, ★★★)
Top to bottom: workspace, team (with its own label), search, six pages, Channels, Direct messages, Bots, the "Finish setting up"
card, and the account row. On 900 px height the Bots list is cut off (the sidebar scrolls: 1000 px content in 630 px) and the
"Finish setting up" card sits permanently on top of it. Suggestions:
- Collapse **Bots** by default (it is a roster, not a conversation list) or fold it under the six-page group as "Bots".
- Make the "Finish setting up" card dismissible/collapsible, show it to admins only, and keep it out of the scroll area.
- Make section headers (Channels, Direct messages, Bots) collapsible with a remembered state — only Channels has the chevron.
- Keep the setup card admin-only (it did not show for Nadia, which is right).

### 2.2 "Team" is both a label and a switcher and costs 55 px (S, ★★)
`Team / Engineering ⌄` is a tall block. Make it a single row (`Engineering ⌄`) with the team avatar, and move the workspace
name into the switcher menu. The switcher menu itself is a plain list of three names; add a coloured team avatar, the unread
total for the other teams, and a keyboard hint (`Ctrl+1/2/3`).

### 2.3 Sidebar unread styling is weak (S, ★★★)
Unread channels are only bolder text and a small blue count badge; mentions are not distinguished from ordinary unread. Slack
uses bold + white text for unread and a **red** badge for mentions. Give mentions a stronger badge (use `--alert`), and fade
muted channels. Also make the active row more distinct than the hover row (currently both are grey).

### 2.4 Sidebar items lack a "more" affordance (M, ★★)
Hovering a channel row showed nothing extra in my session. Slack/Teams show `⋯` (mute, star, mark read, leave). Today only the header-level "Sort channels"
sliders icon exists. Also drag-reorder of the Starred section and per-channel unread "Mark all read".

### 2.5 DM list shows only people you already messaged and has two different "New" rows (S, ★)
"+ New" under channels and "+ New" under DMs: change to "Add channel" / "New message". The Nadia row has a hollow circle after
the name for presence; use the same avatar + dot as everywhere else (the DM rows currently have no avatar).

### 2.6 "Approvals — Nothing waiting" label vs badges (S, ★)
Right-aligned text "Nothing waiting" is the only item with a text status; others use a badge or nothing. Show nothing when
the count is 0 and a count badge (amber) when > 0.

### 2.7 No browser-tab title, no unread count in the tab (S, ★★★)
`document.title` is always `manythreads` on every page (checked on channels, files, bots, threads, approvals). Set it to
`(3) # dev — Engineering · Kahf Software` so people can find the tab and see unread at a glance; update the favicon with a dot
for mentions. This is one of the first things a Slack user checks.

### 2.8 Ctrl+K "Jump to" is helpful but plain (M, ★★)
It lists channels in team order, then DMs, then "Person · message" — Nadia appears twice ("Direct message" and "Person ·
message"). Improvements: show **recent** destinations first, avatars for people, unread badges, a `Tab` to filter
(channels/people/bots/files), and show the shortcut in the sidebar search box ("Search … Ctrl K") — right now the sidebar search
is a different thing (searches messages) and nothing tells you Ctrl+K exists.

### 2.9 Search results live in a right panel with no filters visible until clicked (M, ★★)
Search "streaming" opens a panel: Messages (4), Threads (1), Files (0), Pages (0) — good grouping. Improve: show the
**filters as chips under the box** (`from:`, `in:`, `before:`), highlight matches (already done), show author avatars and full
dates (it shows "12h"/"24 Oct"), keep the query in the sidebar box and let `Enter` open a full-screen results page for long
lists. Pressing Esc in the sidebar box should clear and return focus.

### 2.10 Notifications panel (the 22-bell) is a list of identical lines (M, ★★★)
Each row: `Engineer replied in a thread in #dev` + a truncated line. Add the avatar, group by day/"Today", show **Unread** vs
**All** tabs, use bold for unread and a dot, offer a hover "Mark read / Open", and show the quoted message not truncated at 40
characters. "Mark all" should be a button, not a link in the corner. A red "22" for items that are bot replies in threads
you follow drowns out real mentions; consider a separate "Mentions" count (red) vs "Activity" count (grey).

---

## 3. Threads inbox ★★★

### 3.1 The welcome checklist pushes the real content down (S, ★★★)
`Welcome, Nadia / Join #general / Follow a thread / Ask Brain — Available soon` occupies 150 px at the top of the Threads page
and stays until it is complete. "Ask Brain · Available soon" is a promise the product cannot keep yet, so it can never
complete. Make it a small dismissible card in the sidebar footer or the empty state only; hide any step marked "soon".

### 3.2 Thread rows: no avatar, no author, no unread weight (M, ★★★)
Each row is `# dev … Sun / 1 reply` + title + a snippet. Show who started it (avatar), the last replier ("Deployer: Hello …"
is there but small), and use **bold + blue dot** for unread. Group by Today / Yesterday / Earlier. The "Sun" / "1 reply"
right-aligned pair fights for space with the long title — put "1 reply" below the snippet.

### 3.3 The Followed / Unread / Mine / Later tabs hide counts (S, ★★)
`Unread · 10` has a count, the others do not; the active tab is a heavy black pill. Make the active tab a soft pill
or underline (the black pill is the strongest element on the page, stronger than the content). Show counts for Later.

### 3.4 Thread detail header (S, ★)
`@deployer (hello MVYDICZY-deployer) say hello in 5 words  # dev  [Following ✓]  [Open channel]  🔔` — the title is the whole
root message; use "Thread in #dev" and show the root message in the body (it already is). Make "Following ✓" a quiet
text toggle, not an outlined button.

### 3.5 Empty states for Followed / Unread are good copy but flat (S, ★)
"You are all caught up" deserves a small illustration or a checkmark icon and a suggestion ("Browse channels"), as Slack does.

---

## 4. Teams screens: Files, Boards, Org chart, Rhythms, Approvals, Memory ★★

### 4.1 Page headers are inconsistent (S, ★★★)
Seven different treatments seen:
- `Boards  Boards` (title repeated as the subtitle in the top bar; then again as an H1 below),
- `Rhythms  Bot work on a schedule` (top bar) then an H1 `Rhythms` below,
- `Org chart  Leads, members and the hands a bot may tag` then H1 `Org chart`,
- `Files  Customer support · team repo` and *no* H1,
- `Memory` big H1 with a different size/weight and left padding,
- `Home  Agents` / `Home  Projects` (the top bar says "Home" for pages that are not Home),
- `Conversation`, `Bots  Bots`.

Pick one pattern: a top bar with breadcrumb only (`Engineering / Boards`) and **one** H1 with an optional one-line description
below. Same font size (20/600), same top margin, same left padding (Memory is 4 px off).

### 4.2 Two bells on the Approvals page (S, ★★)
The global bell is in the top bar *and* again in the right-hand empty panel (also on Threads). The right pane for an empty
state should be a centred hint ("Select an approval"), not a repeated header.

### 4.3 Files: mostly good — make it feel like a file manager (M, ★★)
Strengths: icons, "Where / By / When / Size" columns, filter chips, a tree on the left. To improve:
- Rows are 49 px tall with grey text; compress to 40 px and add hover actions (download, rename, share).
- Sorting is a static "Sort: recent" label — make column headers sortable with an arrow.
- `bots/`, `routines/`, `skills/`, `TEAM.md` show a lock icon with the cell text "Change by proposal" in grey. Add a
  tooltip explaining the lock, and make the lock clickable ("Why can't I edit?").
- "By: A bot" is not useful; show the bot name + avatar.
- The "Upload" primary button is good; support **drag & drop on the whole pane** with a drop overlay.
- Preview panel (right side) on click, like Drive.
- On mobile the filter chips run off the right edge and cannot be scrolled to (see §8).

### 4.4 Boards: the empty state asks for a name before it explains the value (M, ★★)
"No boards yet … Board name [Create board]". A user who has never made a board does not know what it is. Offer **templates**
(Support triage, Sprint, Hiring) with a thumbnail, and a "Start from channel messages" option. Use the product's own colours
for the swim-lane preview. The sentence "every drag is a task move the rules decide" is internal language.

### 4.5 Org chart: jargon and misalignment (M, ★★★)
- `May hand a card to nobody: handover.mayTag is empty.` — a raw config key shown to a person. Replace with "Can't hand work
  to other bots yet" and a "Set up handover" link.
- The right-hand `may hand to [Support email]` text floats at a different x for each row (rows are not a grid).
- `0 leads · 1 member · 8 bots` is a plain line with a tiny uppercase `LEADS` section directly underneath with no gap.
- It is a list; an org *chart* should look like one: leads on top, members in the middle, bots as small cards with the
  arrows for handover. Even a simple two-column grid with avatars would help.
- Members are shown as bordered cards without avatars; use avatars + presence.

### 4.6 Rhythms: empty state is a wall of definition (M, ★)
"A heartbeat nudges a bot on a schedule; a routine runs a contract and writes a page; a task opens a card." — three nouns defined
in a sentence. Replace with three tiles (Heartbeat · Routine · Task) with a one-line example and a "Create" button each.

### 4.7 Approvals: a good two-pane inbox, make the card the star (M, ★★★)
The list/detail structure is exactly right (like Mail). I could only see it empty. For when it has content: put the **action
buttons (Approve / Deny) in the header of the detail pane and in the list row** on hover; show who asked (avatar), what
they are asking to do in a sentence, and what the risk is as a coloured tag. The "37.5 h" oldest pending approval over limit on
System health shows these do pile up — make "Waiting" the default, sorted by age with an amber age pill for > 24 h.
The sidebar "Approvals" badge should turn amber when anything is overdue.

### 4.8 Memory: file paths as titles (M, ★★)
Concepts list is `memory/facts/refunds.md  [Fact] [human-reviewed]`. Show the **title** ("Refunds"), a one-line snippet, and a
relative date; put the path in a tooltip. `unverified` (amber) is correct but the three chips per row are noisy — keep the trust
tier as one small icon + label. The sub-title "The team's OKF memory bundle — concepts, trust tiers, and provenance" is
jargon; try "What your team's bots remember. Review what they've learned."
The 70% empty right half should hold a **preview** of the selected note.

---

## 5. Bots, recipes, agents, projects ★★

### 5.1 Bots list: every row says the same thing three times (M, ★★)
Each row: name · description · `agent` pill · `Hermes · any node` (mono) · `this team` · `● ready` · [Talk] [Configure]. In an
8-bot team the middle columns are identical on every row. Show them only when they **differ** (placement not default, scope not
"this team"), otherwise collapse into a column header filter. Add column headers or none at all, but not unlabeled columns.
Make **Talk** the primary action (filled) and "Configure" a quieter icon (⚙). Archivist has no Talk button at all —
explain with a tooltip ("Runs in the background").

### 5.2 Bot page header buttons: eight of them (M, ★★)
Brain's page has `Talk to Brain · Test · Deploy · Change picture · Roster · Open the file · Proposals · Usage` all as buttons of
similar weight, two of them dark. Keep `Talk` and `Deploy` as the primary pair; put the rest under a `…` menu or as a
secondary tab ("Usage", "Proposals" are tabs already in other products).

### 5.3 The 14-tab strip is a lot (M, ★★)
`Identity Behaviour Triggers Capabilities Knowledge Memory Model Guard Approvals Handover Placement & limits Contract Evals
Audit`. Group into 4–5 (Basics · What it can do · Safety · Where it runs · History) with sub-sections on one scroll. On mobile
the tabs wrap onto four lines and push the form far down.

### 5.4 Settings forms show internal field names as hints (S, ★)
`Identity  name, role, kind, runtime, visibility` in mono next to the card title; `conversation`, `mention`, `task_assigned` as
trigger names in mono with a description beside them. Show friendly labels ("When someone talks to it", "When mentioned",
"When a task is assigned") and keep the code name as a small tooltip.

### 5.5 Save bar: three buttons, one says "Propose and apply" (S, ★★)
`Propose and apply · Save as proposal · Discard changes · No changes`. Make it a sticky bar at the bottom that only appears
when there are changes (as in GitHub/Stripe), with one primary "Save" (and a "Save as proposal" in a dropdown).

### 5.6 Add a bot: a wall of 30 chips, then an empty textarea (M, ★★)
"Start from an example" shows 30 pill buttons before the user reaches the text box. Show the six most relevant for this team as
**cards** (icon, name, one line), with "See all 30" opening the picker; put the textarea first and the examples as suggestions
under it. The right-side "What happens next / What it cannot do" boxes are useful, keep them but make them lighter.

### 5.7 Recipes: nice cards; trim the metadata (S, ★★)
The 4-column grid is attractive. Noise: the `– Ready to add` pill on all 20 cards (it is the default state — hide it; show a pill
only when something is *missing*), "Needs: A channel called #bugs where…" in grey, the footer `Engineering · Weekdays at 08:00
UTC` wraps oddly. Add a clear primary "Add" button on hover and a thumbnail/icon per recipe. Sort "Popular" first.

### 5.8 Agents and Projects: heavy explanation, little action (M, ★)
Both start with a three-line paragraph, a tinted notice, then a card. For non-admins the Agents page is mostly "An admin sets
this up." Show a **status strip** first (host · Working · last checked), then "How to connect" collapsed by default. The URL
`http://10.42.0.1:8642` is internal; show it only to admins.

### 5.9 Bot conversation: "You cannot talk to this bot" for an admin (S, ★★)
As Omar (workspace owner, not a member of Customer support) `…/bots/support-responder/chat` shows "You cannot talk to this bot. Only
people on the bot's team can talk to it. A team lead can add you." Offer "Ask to join the team" or, for admins, "Join as admin".
In the Engineering team the page is good: a centred bot intro, three suggested prompts, a composer, and the explanatory line
"Sending starts a thread. There is no 'new conversation' button; the message is the button." — that line is a design note, not
user copy; cut it.

---

## 6. Settings, account, admin ★

### 6.1 Account page is a narrow centred column on its own shell (M, ★★)
Leaving the workspace (to `/account`) changes the entire layout (top bar, no sidebar), which is disorienting. Use the same
settings layout as the workspace settings (left nav with Profile · Notifications · Connections · Security), and have the account
page open from the sidebar account row. The notification toggles are good and visually clear — keep them.
- The `Default for team channels` select is truncated: "Mentions and keywords o…". Widen it.

### 6.2 Settings nav is long and unlabelled (S, ★★)
`Setup, General, Sign-in, Members, Roles, LLM, Runners, Memory sharing, Domain & HTTPS, System health, Data protection,
Usage, Audit, Import` + Teams + the selected team's pages (Roster, Template, Channels…) cut off at the bottom of the screen
with no visible scrollbar. Group under headings (People · Bots & models · Security · Operations), add icons, and make the nav
sticky. Page content is left-aligned at ≈ 980 px with 400 px of empty space on the right — fine; centre it or widen to
1100.

### 6.3 Members table: great, add actions (M, ★★)
Clean table with role pills and tags (`role:on-call` as mono chips). Add: avatars, last-active, a `⋯` row menu (change role,
remove, reset password), search, and an **Invite people** button (top right) — I saw no way to add a person from this page.

### 6.4 System health: status is text, not signal (S, ★★)
`Fine` / `Over limit` are tiny mono text in the left column. Use a coloured dot or pill (green/amber/red) and sort problems to
the top; the page asks an admin "is anything wrong?" and "Over limit" for the 37.5 h pending approval is the single most important
row and looks like all others.

### 6.5 Usage: great KPI tiles, empty charts (M, ★)
KPI tiles (18 bot runs, 56 tool calls, 2 answers, 0 approvals, $0.00) are exactly right. The "Bot runs per day" chart pushes all
bars to the far right with 70% empty; use a 30-day axis with a baseline and light grid, show a tooltip on hover, and draw "no data
yet" as a dotted line on the empty chart ("no dollars of model spend yet" is a footer under a blank box).

### 6.6 Audit: dense and good; give it filters at a glance (S, ★)
Filters take 200 px and are all native selects. Use chips for Who/Outcome with search, keep the table header sticky, and don't
write `4 Nov 2026, 19:36 UTC` seven times in the same minute (collapse repeated sign-ins: "Omar signed in ×7").

### 6.7 "Setup" page is excellent; shorten it (S, ★)
Nine numbered steps with state chips (done / start here / optional) is a good onboarding pattern. Collapse completed steps,
and show only the current one expanded with the progress bar pinned at the top.

### 6.8 Sign-in screen: tiny card in a big grey field (S, ★)
Card is 400 px in a 1440 px viewport, grey background, "m" logo tile. Add the product name large, a short tagline, "Show password"
eye, "Remember this device", and make the primary button full-width. Errors are well written ("Incorrect email or password.").

---

## 7. Visual system — what makes it look "2019" instead of modern ★★★

### 7.1 No dark mode (L, ★★★)
There is no dark theme at all (`prefers-color-scheme`, `data-theme` and the word "dark" do not appear in
`clients/web/src/styles`, and the gear at the bottom of the sidebar opens only the account menu: Account, Profile picture, Set status,
Pause notifications, Teams, Settings, Sign out — no Appearance). The colours are already tokenised in `styles/tokens.css`
(`--paper`, `--surface`, `--ink`, …), so a dark palette is mostly a second `:root[data-theme=dark]` block plus an audit of
hard-coded washes (`--agent-wash`, `--alert-wash`, hex colours in CSS). Add "System / Light / Dark" in Account → Appearance.
Also add "Compact / Comfortable" message density.

### 7.2 Typography is one level too flat (S, ★★★)
Almost everything is 13–14 px regular/medium; page titles (20 px) and card titles (13 px bold) are close in weight. Establish
a scale: H1 22/600, H2 16/600, body 14.5/400 with line-height 1.5, secondary 13/400 in `--mute`, captions 12/500 for chips
and tags. Reduce the number of grey values for text (I count at least four greys on one Files screen).

### 7.3 Make the primary action obvious on every screen (S, ★★)
There are dark filled buttons on most screens (Upload, Add a bot, Deploy, Talk to Brain, Add project), but some screens carry
two (the bot page has both Talk and Deploy filled, plus six outline buttons beside them). One primary per
view; everything else outline or text.

### 7.4 Rounded, softer surfaces (S, ★★)
Cards use 1 px grey borders and ~6 px corners; chips are 4–6 px radius and tags 3 px. Modern chat UIs use 8–12 px radius,
slightly larger tap targets, and a soft shadow on floating elements (menus have one, cards do not). Standardise tokens:
`--radius-sm 6`, `--radius-md 10`, `--radius-lg 14`, and use soft-wash backgrounds (`--human-wash`) rather than outlines for
selected/hover states.

### 7.5 Colour does not carry meaning enough (S, ★★)
Blue is used for links, mentions, unread badges, "Following" etc.; purple only for "agent" pills and `Fact`/`Journal` tags;
green for ready/ok. Define: blue = you/your things, purple = bots, amber = needs attention, red = mentions/errors,
grey = everything else — and apply to sidebar badges, thread rows, approval cards and the org chart. Bots should read purple
everywhere (avatar ring, name, tag), so a glance separates humans from bots.

### 7.6 Avatars are small and mono-coloured (S, ★★)
All human avatars are the same navy circle with two letters (OM, SA, NA, RA, PR) — in a channel with four people they are
indistinguishable. Give each person a stable colour from a 10-colour palette (hash of id) and make them 36 px with 8 px
radius (rounded square, as Slack) or keep circle + the status dot at the corner. Show photos when set.

### 7.7 Empty and loading states (S, ★★)
Loading is plain text "Loading…" (Approvals) or an empty block; use skeleton rows (grep found no skeleton/shimmer styles).
Empty states are good copy but have no icon; add a 48 px outline icon and a primary action.

### 7.8 Motion (S, ★)
There is little motion: popovers appear instantly, the thread panel slides in without easing, messages appear without a fade.
Add 120–160 ms ease-out on menus, a 200 ms slide on the right panel, and a one-off highlight (yellow wash → fade) when you
jump to a message from a link/search. Respect `prefers-reduced-motion` (only terminal/polls/meetings css do today).

### 7.9 Focus rings and keyboard (S, ★★)
Tab order starts sensibly (team → search → pages), but the focus indicator is inconsistent: `outline: solid` on links,
`none` on the search box (it relies on the border colour change). Provide one visible 2 px focus ring token
(`:focus-visible`) for every control. Add "Skip to messages" for screen-reader users.

---

## 8. Phone layout (390 px) ★★★

### 8.1 Channel name unreadable in the header (S, ★★★)
`#general` shows as `#.` — the topic takes the space. Show the full channel name on one line, put the topic under it in smaller
text or hide it; keep call/notify/star under a `⋯`.

### 8.2 Bot page header collides with the description (S, ★★★)
On `/bots/engineer` the buttons (`Talk to Engineer`, `Test`, `Deploy`, …) draw **on top of** the "Hermes · bots/engineer/BOT.md"
line and the avatar; the description wraps one word per line next to them. Stack: avatar+name, description, then a horizontal
scroll row for actions (or a `⋯` menu).

### 8.3 Thread panel: toolbar scrolls sideways, chips cut off (S, ★★)
Source chips (`1 @brain (check MVYDWDO2-2) Name every tool you…`) are clipped at the right edge, and the composer toolbar's last
icons are cut. Wrap chips to two lines and drop the formatting toolbar to a single `Aa` button on mobile (like iMessage/Slack).

### 8.4 No bottom navigation (M, ★★★)
Mobile has a hamburger to open the sidebar and everything else is nested. Slack/Teams mobile: a **bottom tab bar** — Home,
DMs, Activity (mentions), Search, You — with unread badges. The Threads page opens first, which is fine, but there is no
visible way back to a channel without opening the drawer. Add swipe-from-edge to open the drawer and swipe-right on a message
to reply.

### 8.5 Tap targets and gestures (S, ★★)
Message actions rely on hover. On touch a tap selects the row (`tapped` class exists) — verify the toolbar is reachable
and add long-press for the reaction picker. Header icons are 20 px with 8 px gaps; make them 40×40 touch targets.

### 8.6 Files/Bots on mobile (S, ★)
Files: filter chips run off the right edge (needs horizontal scroll with a fade) and the Size/When columns disappear —
fine, but show the date under the name. Bots: "12 bots · 11 agents, 1 automation" wraps beside the buttons; stack them.

---

## 9. Recommended order (highest return first)

| # | Do | Why | Effort |
|---|----|-----|--------|
| 1 | Message grouping + hover timestamp (1.1, 1.2) | Biggest visual win; makes channels dense and readable | M |
| 2 | Tab title + unread count (2.7) | Trivial, every Slack user expects it | S |
| 3 | Channel header cleanup: channel name never truncates, one bell, member stack, channel details (1.17, 1.18, 8.1) | Orientation on every screen, and a mobile bug | M |
| 4 | Page header unification (4.1) and remove "handover.mayTag"/internal strings (4.5, 5.4, 4.8, 1.21) | Looks polished immediately; removes jargon | S |
| 5 | Dark mode + density option (7.1) | Most-requested modern feature; tokens already exist | L |
| 6 | Quick reactions in hover bar + `:emoji:` autocomplete + richer @mention list (1.4, 1.10, 1.11) | Daily interactions people compare to Slack | M |
| 7 | Thread rows with avatars/unread, Threads page without the permanent welcome card (3.1, 3.2) | Threads inbox is the home page | M |
| 8 | Bot message treatment: tag instead of card, collapse sources (1.21) | Bots are the product's point — their output must be easiest to read | M |
| 9 | Mobile fixes: bot page header, thread panel, bottom tab bar (8.1–8.4) | Phone is currently unreliable | M |
| 10 | Esc no longer silently marks read; "Jump to latest" count and position (1.15, 1.16) | Prevents data-loss surprises | S |

Smaller quick wins (all **S**): sticky day pills (1.8), `+` reaction affordance (1.7), sidebar mention badges in red (2.3),
approvals amber age pill (4.7), health status dots (6.4), skeleton loading (7.7), consistent avatar colours (7.6),
focus-visible ring (7.9), the account row opening an Appearance page (6.1).

---

## 10. What is already good (keep it)

- **Consistent type and neutral palette** — self-hosted Inter, calm greys, a single accent. Feels trustworthy.
- **Keyboard**: Ctrl+K jump, Alt+↑/↓ unread jump, `j`/`k`/`e` in Threads, `?` sheet, Up-arrow to edit last message (code),
  drag-and-drop and paste for files (code).
- **Message features**: threads with follow toggle, "Also send to #channel", mark-unread-from-here, remind-me, send-later,
  polls, forward, send-to-memory, link previews, scheduled strip, drafts.
- **Slash menu** is discoverable and explains each command with an example.
- **Honest empty/error copy** ("You cannot see this channel. It may be private, or it may not exist…").
- **Typing indicator**, "New" divider, and presence exist already.
- **Settings → Setup checklist**, **Usage tiles**, **Members table**, and the **Recipes** grid are close to what a modern admin
  console looks like.
- **Approvals** two-pane layout and **Search** results grouping (Messages/Threads/Files/Pages) are the right models.

---

## 11. Method and gaps

- Seen as Omar (workspace owner) and Nadia (member) on `Customer support` and `Engineering`, desktop and phone.
- Not covered: Marketing team, Lena (guest) view, a real voice room (not set up on the server), outgoing webhook/API-token tabs,
  sign-in with Google/Microsoft, the desktop app, tablet width (768–1024), Windows high-contrast, screen-reader pass.
- The approvals inbox and the boards view were empty in the data I could see, so §4.2, §4.4 and §4.7 are based on the empty state
  plus the layout; re-check once there are cards and pending approvals.
- I did not send any messages or change any data (apart from the star toggle described at the top).
