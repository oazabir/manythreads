# Phase 34 · The everyday screens (owner request 2026-11-19)

The owner asked for a pass over the screens people spend most of their time in (the channel, the composer, how each kind of message is drawn,
the thread, the Threads view, DMs) on desktop and phone, to find what renders inconsistently and what would make it calmer, clearer and nicer to read.

**How it was looked at:** the live site as Omar (Linen light, the owner's own choice) at 1440×900 and at 390×844 (touch, 2×), on 2026-11-19 at web
`dacd7eab`: #dev, #general, #load-test, #incidents, #alerts, #releases, #standup, a long bot thread (`01a1eb05…`, proof 5) and a short one in #general,
the composer (empty, @, /, a long draft, the format bar), Threads, Messages (DMs), a DM, Brain chat, Search, Activity. Pictures are not committed
(`temp/screenshots/p34-before/`, copied from the session scratchpad). Dark mode and the Graphite and Harbor palettes were not looked at in this pass.

## What was found

Each finding names where it shows (D = desktop 1440, P = phone 390) and the likely place in the code.

### A. The message list
1. **Same-author lines sit far apart.** A run of short messages from one person (Nadia's DM: "verify wpf ping …" ×6; #load-test voice messages) has
   about 40 px from line to line at a 24 px line height, so a run reads as separate paragraphs. `.msg.run` sets only `padding-top: var(--run-gap)`;
   the bottom `--msg-pad-y` (8 px in Linen) stays on every row. D, P.
2. **A presence dot on every avatar in the list.** Each message avatar carries a green dot or a hollow ring; offline people get a ring that reads like
   a radio button. In the list this is noise (the sidebar, DM header and member list already say who is here). D, P.
3. **The day label covers text.** The sticky day pill ("Monday 16 November", "Today") floats over the first visible line instead of sitting in a
   band, e.g. over a voice player's waveform and over "every 1 h…gets the". D, P.
4. **"Show more" looks like a different control from everything else.** It is underlined, bold, larger than the caption text, and shares a line with
   the reply avatars and "22 replies", so the two links compete. On the phone it is the biggest text in the row. D, P.
5. **Room events read as stray text.** "Started a voice room: Voice room · 22:14" after the room ended is a plain line under the previous person's
   name; two in a row look like a glitch, and in search they are most of the results for "voice". They need an event look (icon, muted, one line,
   who, how long, how many joined once ended). The same applies to "Earlier to-do list · moved to Committer's list below". D, P.
6. **The voice caption repeats.** Every voice message ends with "Transcript" in small text; five in a row repeat it five times. Say only what is
   unusual ("First 20 seconds", "No words were heard"); the normal case needs no caption. The played dot sits between the length and "1×" with no
   meaning a newcomer can guess. D, P.
7. **Reply avatars mix two looks.** The reply stack beside "N replies" mixes initials circles with bot emoji faces at a smaller size; on the phone the
   first initials circle is cut ("ON"). D, P.
8. **The hover bar stays after a tap on the phone,** covering the time of the row ("17:10" under 👍✅👀). P.
9. **The run summary row ("Worked 7 min · 39 steps · …") starts at the avatar column on the phone** but at the text column on desktop. P.
10. **Long tokens.** Commit hashes and paths in bot messages break mid-word across lines (`8ac36456…` split over two lines in a narrow pane).
    Prefer `overflow-wrap: anywhere` only for code spans, `break-word` for prose. D (thread pane), P.

### B. Link previews (bot threads are full of them)
11. **The same preview repeats.** In the proof-5 thread the GitHub PR #17 preview is drawn under four messages in a row, and the test-site preview
    under every smoke-tester message. A URL already previewed in the thread (or in the last N channel messages) should show once; later mentions
    stay plain links.
12. **Empty cards.** A page with only a title (the test site) draws a ~100 px card with a title and empty space. A title-only preview should be one line.
13. **The description is cut through the middle of a line** (fixed height, not a line clamp): the second line shows only its top half. D, P.

### C. The composer
14. **Four different composers.** Channel: an always-open bar of 12 format buttons above the box, then attach, mic, send and a chevron at the bottom
    right. Thread pane: a different set (B, I, code, link, @, emoji, …). Brain chat: the 12 buttons and no microphone. Phone: "Aa @ ☺" on a row of
    their own above the box. One composer component, one tool order, in all four.
15. **Too tall when empty.** The desktop composer is ~92 px with nothing typed (the format bar is always shown); the phone composer is ~210 px of 844,
    plus the tab bar. Proposal: one row (+ for files, Aa for formatting, @, emoji, mic, send) with the format bar shown only after Aa, on desktop too
    (remember the choice per person).
16. **Send changes size.** Empty: a faint 20 px glyph; with text: a 36 px dark filled square (48 px on the phone). Keep one size, change only colour.
    The lone chevron (^) beside it has no label a person can guess (it expands the box): fold it into the box (drag handle or Shift+↑) or label it.
17. **The mention list's "Everyone" rows** show their help text in the monospace font with the handle missing (`@.` then "Notify everyone who can read
    this"), unlike the people rows. Show `@channel` / `@here` as names in the normal font.
18. **A newline is easy to send by mistake on desktop when a list is being typed:** Enter sends in the middle of a "- one" list. Inside a list or a
    code block, Enter should continue the block and Ctrl/⌘+Enter (or Enter on an empty item) sends.

### D. Headers and the frame
19. **Screens use three header styles.** Channel and DM: a title with the icon row. Brain chat and Search: a breadcrumb ("Engineering / Chat / Brain")
    and then a second title row ("New chat", "Search"). Threads: tabs in the header. One pattern for the main screens: the title on the left, the
    screen's own tools on the right, no breadcrumb for top-level screens.
20. **Phone: the channel header takes two rows for most names.** `#dev` fits on one row; `#general`, `#load-test` push the icons to a second row
    (~100 px). The title should truncate and Members/Bookmarks go into the details menu at 390, so the header is always one row.
21. **Phone: two bells.** The header bell (99+) and the Activity tab (99+) say the same thing. On the phone the header bell goes; Activity is the tab.
22. **Phone: the Threads filter row does not fit.** The filter's placeholder is cut ("Filter, or @na"), "Needs you first" is a large pill, the tabs
    row is right-aligned with an empty left half.
23. **Phone: Messages is a bare list.** Names only: no avatar, no last line, no time; the hollow presence ring next to the name. A phone person
    expects the chat-app list (avatar, name, last line, time, unread count).
24. **Sidebar headings differ:** "Channels" is larger and darker than "Direct messages" and "Projects"; the "Finish setting up" count ("10 of 13")
    is in the monospace font. D.
25. **The thread pane's header** ("Thread / # dev", a lone expand icon beside the title, close at the far right) and the full thread view header
    ("Following ▾", "Open channel", "Overview" as bordered buttons) use different controls from the channel's icon row. D.

### E. What already works and should stay
The day separators' lines, the reaction chips, the hover bar on desktop, the "Jump to latest" pill, the mention pill colour for bots, the slash
command list (clear, with examples), the Threads view's "Needs you" grouping, the to-do progress line in a thread row, the voice player itself.

## The tasks

| ID | Task | Findings | Size |
|---|---|---|---|
| P34-00 | This plan and its independent review; pictures before (`temp/screenshots/p34-before/`) | — | S |
| P34-01 | **Message list rhythm:** a run of one author's messages 2–4 px apart (bottom padding of a run row follows `--run-gap`; each palette's density kept), no presence on message avatars, the day pill in its own band that never covers text, "Show more" as a quiet text button on its own line under the text (caption size, no underline until hover), one avatar look in the reply stack (same size, bots in a rounded square as elsewhere, never cut), long tokens wrap only in code | 1–4, 7, 10 | M |
| P34-02 | **Event and status rows:** a voice room start becomes an event row (headset icon, muted, "Omar started a voice room · 22:14"; once ended "Voice room · 14 min · 3 joined" if the client knows, else just the start line) with consecutive events folded ("2 voice rooms"); the same look for "moved to …'s list" and other system lines; the run summary row aligned to the text column on the phone; the voice caption only when the transcript is partial, missing or failed, and the played dot replaced by the time turning from faint to normal once played (or a tooltip "Played") | 5, 6, 9 | M |
| P34-03 | **One composer:** a single component and tool order for channel, thread, DM and Brain chat (mic everywhere a voice message is allowed); one bottom row (+, Aa, @, emoji, mic, send); the format bar opens from Aa and the choice is remembered; send keeps one size; the expand chevron labelled or removed; Enter inside a list or code block continues it; the Everyone rows of the mention list in the normal font with their handles; phone composer one row + box (≤ 120 px empty) | 14–18 | M–L |
| P34-04 | **Link previews:** one preview per URL per thread (and per channel within the last 20 messages); a title-only page draws one line; descriptions clamp by lines; a dismissed preview stays dismissed for the reader | 11–13 | S–M |
| P34-05 | **Phone frame:** the channel header always one row (title truncates, Members and Bookmarks into the details menu at ≤ 430 px, keep `members-open` reachable there), no header bell on the phone (Activity tab), the Threads filter row stacked to fit, a tap never leaves the hover bar over the time, Messages as a chat-app list (avatar, name, last line, time, unread) | 8, 20–23 | M |
| P34-06 | **Headers and sidebar:** one header pattern for Channel, DM, Thread pane, Threads, Brain chat and Search (title left, tools right as `icon-btn`, no breadcrumb on top-level screens); the thread pane's expand and close in the icon row; sidebar section headings one style; the setup count in the body font | 19, 24, 25 | M |
| P34-07 | Tests (unit for grouping/preview dedupe/composer keys; e2e specs whose ids move), baselines re-shot after deleting the old PNGs, pictures after at 1440 and 390 in Linen light and Graphite dark | — | M |
| P34-08 | Deploy and a live check as Omar on the same channels and threads as the before pictures, side by side | — | S |

Rules: conventions.md (tokens only, both themes and all four palettes, 44 px touch targets, `aria-label` + tooltip on every icon button, ProIcons
through `proIcon()`, plain words, no new dependency). No server change is expected except possibly P34-02's ended-room summary: if the client cannot
know the length and the count without a new route, the event row shows only the start line and the summary waits for the plan to be amended.
See correction 9 (the DM list data exists) and correction 10 (event rows need a server stamp).

## Findings the review added
26. **The clamp fade hides more than it shows.** The mask fades 1.6 of the 4 clamped lines, so about 2.4 lines are readable and the last is
    half-drawn (`channels.css:242-246`). In the 380 px thread pane almost every bot message ends in "Show more". D, P.
27. **The hand-off prefix repeats the author:** "Web smoke tester → @committer:" under the header "Web smoke tester"; "Omar → @plan-reviewer". Draw "→ @committer". D, P.
28. **Glued text** "tree.ALL DONEALL DONE" in a bot reply (`desktop/15-threads.png`): find whether the bot wrote it or text deltas were joined without a separator.
29. **Threads view:** the first face of the avatar stack is cut ("ON") and a stray "…" sits at the bottom right of every Latest reply box. D, P.
30. **Phone format bar:** after Aa it replaces @ and emoji, its last icon is cut at the edge with no sign the row scrolls; "Jump to latest" sits on top of the day pill. P (D for the pill).
31. **Brain chat on the phone:** the composer is inset narrower than the page under a rule; "Shortcuts" is an underlined link among dropdowns. P.
32. **DM header:** the presence ring overlaps the 22 px avatar. D.
33. **The sticky day pill sits over an approval card's buttons.** D.

## Corrections after the independent review (binding; they override the text above where they differ)
1. **P34-01 run spacing:** the gap is the previous row's bottom `--msg-pad-y` + `--run-gap` + the virtual row's `.vrow` `padding-bottom: var(--msg-gap)` (`channels.css:34-37`). Move the gap to the *top* of non-run rows so a run row has none above it; re-test the virtualizer's measuring. Palettes are generated: change `tools/design/themes.mjs` and run `build-themes.mjs`. Comfortable keeps 4–6 px between run lines, Compact 2 px.
2. **Owner decisions this phase would reverse** (each waits for the owner's yes; until then the task builds the rest). **Decided by the owner on 2026-11-19:**
   a. no presence dot on message avatars — **yes**; b. the voice caption only when unusual, the played dot replaced — **yes**; c. format bar from Aa — **no, keep
   the always-open bar on desktop** (P21-04 stands); d. no breadcrumb on top-level screens — **yes**; e. phone channel header — **every header icon except
   the notification bell moves into the channel details menu** (the header is the title and the bell; the bell stays, so "one bell" is not taken up).
   The list as it was proposed:
   - no presence dot on message avatars (reverses P21-01);
   - the voice caption only when the transcript is partial, missing or failed, and the played dot replaced (P32-10, owner 2026-11-18);
   - the format bar opened from Aa on desktop (reverses P21-04's always-reserved toolbar; when opened it must reserve or animate its height so the list never jumps);
   - no breadcrumb on top-level screens (reverses P21-12; its one-`h1` test stays);
   - the phone channel header on one row (reverses B13 and P21-06's "the title never truncates") and no header bell on the phone (P21-06's "one bell").
3. **Day pill (P21-05 keeps it sticky):** it gets a solid band in the paper colour behind it so no text shows through; "never covers text" is dropped.
4. **Hover bar (F8):** the cause is its position (`top:-12px; right:8px`, `channels.css:935-938`) in a narrow column, also in the desktop thread pane. Under `(pointer: coarse)` there is no hover bar (long-press already opens reactions and actions); in narrow columns it sits so it never covers the time.
5. **Long tokens (F10):** hashes are code spans, so code spans keep `anywhere` but hashes over 12 characters are shown shortened (`8ac36456…`, full value on hover and in copy).
6. **Link previews (P34-04):** the card's fixed 94 px height and the 96 px reserved slot stay ("never moves a row"); the description clamps to one line when the title takes two. Dedupe only inside a thread and within one author's run in a channel (never across loaded pages). The × removes a preview for everyone (`removeLinkPreviewRoute`); the per-reader dismiss is dropped.
7. **Mention list (F17):** the handle is present; `.pk-hint` is styled as the mono handle column and squeezes `@channel` (`Composer.tsx:952-956`). Fix the CSS. Monospace is for code only (conventions.md:60), which also covers F24.
8. **Phone header (P34-05):** keep Members (Phase 33's one icon); Bookmarks and the voice icon go into the details menu at 390 by extending P33-08's `data-room="tight"` rules (today only at `width > 760`, `channels.css:2664`). Update `e2e/channels/channel-header.spec.ts:307-345`.
9. **Messages list (F23, desktop too):** no server change; `DirectMessageSummary` has `lastMessage {preview, createdAt, authorId}` and `unreadCount` (`packages/shared/src/api/dm/dm.ts:20-35`). The client must update `lastMessage` when a message arrives.
10. **Event rows need a server change and merge with P15-26.** The start message is plain text (`meetings/src/routes.ts:162`) with no meta, and matching text is spoofable. P34-02's voice-room part is built with P15-26 (the call card): a `meta.meeting` stamp on the start message plus a backfill, the ended state from `listTeamMeetingsRoute?state=ended` (start, end) and a joined count the server keeps. That combined task comes back as its own plan before building. The status-line and run-row parts of P34-02 stay web-only.
11. **Thread pane:** no clamp in the thread pane (or 10 lines), and the clamp fade covers at most the last line (finding 26). The hand-off prefix drops the author's own name (27).
12. **P34-07** re-shoots all four palettes in light and dark, not two.
13. **Disk first:** every P34 task deploys, and the guard refused at 81% on 2026-11-19, so P31-05 comes before them.
