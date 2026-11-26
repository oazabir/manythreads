# The New menu (P38-07, owner 2026-11-26)

Owner request: one button that pulls down everything a person can create, the likeliest first, and each item takes the person to the place where the thing is made
and starts the making.

## Where it is
A **New** button (plus icon, caret) in its own region of the sidebar, under the search box. It shows in the desktop sidebar and in the phone drawer. It is hidden
for a guest, and while the teams are still loading. The menu uses the shared menu look (`.menu`, `.menu-item`, `.menu-sep`), opens on click or ArrowDown, moves with
the arrow keys, Home and End, picks with Enter, and closes with Esc, which puts focus back on the button (`aria-haspopup="menu"`, `aria-expanded`, `role="menuitem"`).
Each row has an icon, a label and a one-line hint. Code: `clients/web/src/shell/NewMenu.tsx`.

## The list, the order and who sees it
One list in `clients/web/src/shell/newMenu.ts` (`NEW_ORDER`, `newMenuFor`), tested in `clients/web/test/new-menu.test.ts`. Three groups, a thin line between them:

| # | Row | Needs | Where it goes | What starts |
|---|-----|-------|---------------|-------------|
| 1 | New chat with a bot | a team | `/t/<team>/chat?new=chat` | the chat's message box takes focus (a new chat with the last bot) |
| 2 | Message a person | a team | `/t/<team>/dms?new=person` (phone: Messages) | the "New message" people picker |
| 3 | New channel | a lead or admin | dialog on the spot | the New channel dialog |
| 4 | New meeting | a team | dialog on the spot | the New meeting dialog |
| 5 | New personal file | anyone | `/files?new=file` | a note in Personal (steps into the first folder, or opens New folder when there is none) |
| 6 | New team file | a team | `/t/<team>/files?new=file` | the New page dialog (the propose dialog where the folder changes by proposal) |
| 7 | Schedule a meeting | a team | `/t/<team>/schedule?new=appointment` | the New appointment form |
| 8 | New action item | anyone | `/account/action-items?new=action` | the cursor in the add box |
| 9 | New card | a team | `/t/<team>/boards?new=card` | the new card form |
| 10 | Add to knowledge | anyone | `/knowledge?new=upload` | the open base's file chooser (the name box when there is no base yet) |
| 11 | New folder | a team | `/t/<team>/files?new=folder` | the New folder dialog |
| 12 | New board | a lead or admin | `/t/<team>/boards?new=board` | the new board form |
| 13 | New job | a lead or admin | `/t/<team>/jobs?new=job` | the New job form |
| 14 | New routine | anyone | `/account/routines?new=routine` | the New routine dialog |
| 15 | New bot | a team | `/t/<team>/bots/new` | the Add a bot helper page (it is a page already) |
| 16 | New project | a lead or admin | `/t/<team>/projects?new=project` | the Add a project form |
| 17 | New knowledge base | anyone | `/knowledge?new=base` | the cursor in the new base's name box |

Why this order: talking to someone is the likeliest thing, then making a file, then the planning things done now and then, and last the set-up things that happen
rarely. "A team" means the team on screen, not archived. A lead or admin sees the rows that the team screens keep for leads, as those screens show their own buttons.
A guest sees no menu. New bot follows the roster (everyone but a guest), not admin only.

## How an item starts its journey
The address carries a one-shot `?new=<kind>`. The screen calls `useNewRequest([...kinds])` (`shell/useNewRequest.ts`), which reads it once on arrival and takes it
out of the address with a replace, so Back and a reload do not start it again. The screen keeps the request until its data is there, opens its **existing** dialog,
picker or box (no new create or upload code), puts focus in it, and answers with `done()`. A request the screen cannot honour (a member on a lead-only screen, a
routine limit reached) ends quietly on the screen. Using the menu again on the screen you are on starts it again.

## Not done, and why
- A separate "Upload files" row: a team's root takes text pages only and Personal needs a folder first, so upload lives in New file, New folder and Knowledge.
- Command palette entries: the palette (`app/QuickSwitcher.tsx`) is a ranked search over things that exist, with a tab and a result kind for each; a "create" kind needs its own tab, ranking and icons, so it is its own change.
- Add to knowledge presses the file chooser only when the browser still counts the menu click as the person's own; otherwise the Upload button takes focus.
