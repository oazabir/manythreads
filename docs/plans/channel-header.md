# Phase 33 · A calmer channel header (owner request 2026-11-18)

The owner's words: the channel's top area "has become too busy and looks inconsistent". Today, at 1440 px, `#dev` shows in one row: the title,
the topic cut to "P…", a "Schedule a room" button with a calendar, a "Bot Board" pill, a search box, a tall green "Join voice room" button with the
phone above the label, three avatars and a count, the bookmark button, the bell. Four different button shapes, two heights.

## What the owner asked for, and what each becomes

| # | Owner ask | Built as |
|---|---|---|
| 1 | All member avatars become one member icon | One icon button (people icon + count, e.g. "6"), same size as the other header icons. `MembersStack` is replaced. |
| 2 | Clicking it opens a sidebar with the channel's members and the members not in the channel | It opens the right panel (the same panel search and threads use, new panel type `members:<channelId>`), titled "Members of #dev". Two lists: **In this channel (N)** and **Not in this channel (M)**: the team's people who are not members. A filter box at the top filters both. Each row: avatar, name, and "(you)" for the reader. Bots are not listed (they are not channel members). |
| 3 | An easy way to add non-members | Each row of "Not in this channel" has an **Add** button (44 px target) for a reader who may manage the channel (`GetChannelResponse.canManage`: a team lead or a workspace admin, which is what `POST /api/channels/:id/members` allows). After Add the row moves to the top list at once, with a polite live-region line "Added Nadia to #dev". A reader who may not add sees no Add buttons and one line under the heading: "A team lead can add people to this channel." A DM shows no member icon (as today). A guest shows none (as today). |
| 4 | Bot Board, video call and voice call as icons that clearly say what they are | One row of square icon buttons, all one size (32 px drawn, 44 px hit area by padding where the header allows; at least 32 px with 8 px gap), one style (`icon-btn`), each with `aria-label` and a tooltip (`title`): **Bot Board** (a kanban icon: three columns of cards), **Schedule a room** (calendar with a plus), **Start a voice room** (headset or phone). There are no video calls in the product yet (Phase 17 not built), so there is no video icon; say so in STATUS. The scheduled-room chip ("Design review, today 15:00") stays as a small chip only while a room is due within 12 hours. |
| 5 | "Join voice room" is a button, on the "Started a voice room" message; the header's voice room button goes | The header's large Start/Join button is removed. The voice icon (4) starts a room when none is live. While a room is live it carries a small green dot and its tooltip says "A voice room is live: join it from its message"; pressing it scrolls the list to that message and highlights it (the existing `?message=` highlight). The start message (`meeting.threadRootId === message.id`) draws a **voice room card** under its text while the room is live: the room title, "N in the room" with up to three avatars, a primary **Join** button (or "You are in this room" when the reader is in it), and, for the starter only, **End room**. After the room ends the card shows "Ended · 14 min" with no buttons. |
| 6 | The starter can end the room | **End room** on the card (starter only, as the owner asked; leads and admins may also end on the server, but the button shows to the starter) and an **End for everyone** item in the call dock for the starter. It asks once ("End the voice room for everyone? The 3 people in it will leave.") with End room / Cancel, then calls `POST /api/meetings/:id/end`. Everybody's dock closes through the existing ended push. |
| 7 | Search is a bar that takes the free space | The per-channel search is always a visible input ("Search #dev", in a DM "Search this conversation") that grows to fill the header's free space between the title and the icon row (`flex: 1 1 auto; min-width: 160px; max-width: 560px`). It replaces the magnifier that unfolds. It searches with `in:` this channel as today and opens the results in the right panel. Ctrl K stays the workspace search in the sidebar. |

Header order, left to right: title and topic · search bar (grows) · scheduled chip (only when due) · Bot Board · Schedule a room · Voice room · Members · Bookmarks · (shell's bell).
At 390 px (phone): title, then the icons; the search bar becomes the magnifier icon that opens the right panel's search (the phone has no room for a bar), Members and Bookmarks stay; Bot Board and Schedule a room move into the existing channel details menu if the row overflows. Topic hidden on the phone as today.

## Where the code is
- `clients/web/src/screens/ChannelView.tsx` (portals into `useHeaderActionsSlot()`: MembersStack, ChannelSearch, StartButton, ScheduledChip, the Bot Board link; BookmarksBar).
- `clients/web/src/shell/MembersStack.tsx`, `clients/web/src/search/ChannelSearch.tsx`, `clients/web/src/meetings/StartButton.tsx`, `clients/web/src/meetings/schedule/ScheduledChip.tsx`, `clients/web/src/meetings/CallDock.tsx`, `clients/web/src/meetings/store.ts` (`useLiveRoom`, `callController`), `clients/web/src/meetings/api.ts` (`endMeeting` exists, no caller yet), `clients/web/src/meetings/icons.tsx`, `clients/web/src/shell/icons`.
- The start message: `packages/plugins/meetings/src/routes.ts` posts "Started a voice room: <title>" and stores its id as `meetings.thread_root_id`; the client draws messages in `clients/web/src/channels/MessageRow.tsx`.
- Right panel: `clients/web/src/kernel/panel` (search uses `search:` entries; add `members:`).
- Team roster for the "not in channel" list: `packages/shared/src/api/teams/roster.ts` (find the list route the web already uses for a team's people; reuse it, no new server route unless none fits).

## No server change expected
End, add-member and the roster exist. If the live-room data the client has lacks the starter's id or the start message id (`Meeting.startedBy`, `Meeting.threadRootId` exist in the entity), use the meeting summary route already in `meetings/api.ts`. A server change, if one turns out to be needed, comes back to the plan first.

## Rules (conventions.md)
Tokens only for colours; both themes; 44 px targets where the layout allows (the icon row may use 36 px hit boxes with the gap kept, as the shell band does: say which); every icon button has an `aria-label` and a tooltip; plain words; no new dependency; the icons are inline SVG in `shell/icons` in the style of the others (1.5 px stroke, 20 px box).

## Tests and pictures
- Unit (vitest, `clients/web`): members panel splits members and non-members and filters both; Add calls the route and moves the row; Add hidden without `canManage`; the start-message card shows Join while live, End only to the starter, "Ended" after; the voice icon starts when nothing is live and scrolls to the message when live; End asks and calls `endMeeting`.
- e2e (`e2e/`, existing channel and meetings specs updated where they press `call-start` or `members-stack`; keep test ids where the thing still exists, change specs where it does not).
- Pictures at 1440 and 390, light and dark: header with no room, header with a live room, the card on the message (live, in it, ended), the members panel as a lead and as a member, the End confirm.
- Live check on the site as Omar: open #dev, the header, the members panel, add a team member who is not in a test channel (use a scratch channel, not #dev; remove them after through the same panel or the details menu), start a room, see the card, end it.

## Ledger
New Phase 33 rows P33-00 (this plan), P33-01 header layout and icons, P33-02 members panel with Add, P33-03 voice room card with Join and End, P33-04 search bar, P33-05 tests and pictures, P33-06 live.

## Corrections after the independent review (binding; they override the text above where they differ)
1. **No "Ended" state on the card.** The client keeps only live rooms (`meetings/model.ts:41-48`, `store.ts:299`) and no route finds a meeting by message. The card draws only while the room is live and matches only on `meeting.threadRootId === message.id` (it may be null); after the end the message is plain text as before. No server change.
2. **The voice icon keeps `data-testid="call-start"`.** With no live room it starts one; with a live room it scrolls to the start message (channel) — `e2e/meetings/support.ts:77` join helper changes to press the card's Join (`data-testid="room-card-join"`) when a room is live, and specs `room.spec.ts`, `mobile-web.spec.ts`, `L4-rooms-and-groups.journey.ts`, `meetings.visual.spec.ts` follow. If the start message is not loaded in the list (far up), the icon joins directly instead.
3. **DM:** a "Call" icon (PhoneIcon) that starts, or joins directly when live (no card hunt). `call-in-here` stays as a small icon-state ("In this call") in both.
4. **End:** `controller.endForAll()` and `call-end-all` in the dock already exist (`CallDock.tsx:146,175`): add the one confirm there. The card's End room (starter only, `meeting.startedBy === channelStore.selfActor`) calls `endMeeting` then `liveRooms().refresh()`.
5. **Icons:** ProIcons wrapped with `proIcon()` only (conventions.md:61); reuse `BoardsIcon`, `ScheduleCalendarIcon`, `PhoneIcon`/`HeadphonesIcon`; add a people icon the same way.
6. **Search bar growth:** `.chead-tools` must flex-grow for the channel screen only (Files uses the slot too — do not change it), the search bar gets an `order` before the icons, and the topic must keep a sensible minimum (it must not collapse to "P…" at 1440 with a normal title; give the topic at least ~160 px before the bar shrinks it).
7. **Phone (≤760 px):** keep the existing fold-out magnifier for search (the panel has no input). A fixed ≤760 px rule moves Bot Board and Schedule a room into the channel details menu. `channel-header.spec.ts:261-295` (44-character name) and `bottom-bar.spec.ts:220-257` (exactly one "Search this conversation" button) must keep passing.
8. **Sizes:** icon buttons 32 px drawn in the header, 44 px under `(pointer: coarse)` as `schedule.css:217-224` does.
9. **Members panel:** `registerPanelType({ type: 'members', ... })` in `kernel/panel/builtins.tsx`; a row press opens the existing `member:<personId>` panel; roster from `fetchRoster(slug)`; guests and (archived channel) are never offered Add; the details menu's Members view stays (tests use it) but links to the panel.
10. **Cleanup in the live check** goes through `removeChannelMember` by API (no Remove button in this phase).
11. **Scheduled chip:** split the Schedule button from the chip (`ScheduledChip.tsx:89`); the chip no longer draws for a started room (the card does that).
12. **Bot Board:** icon only when the board exists, keeps `bot-board-link`, `aria-label` and tooltip carry the board's name.
13. **Tests:** update the ids/specs listed in the review (`members-stack` → `members-open`, `schedule-open` kept on the new icon); re-shoot `dm.visual.spec.ts`, `phone.visual.spec.ts`, channel header baselines after deleting the old PNGs (MISTAKES:1120); measure every header control with a long name (MISTAKES:1023,1119).
