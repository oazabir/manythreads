# Phase 21 retro (polish: look, dark mode, phone, states)

Written at the end of Bundle B (the second half of Phase 21: P21-21 to P21-24 and the unfinished parts of P21-04, P21-10 and P21-15). Bundle A (P20) and the
first half of Phase 21 (P21-01 to P21-20) are in `STATUS.md`. This page says what was decided, what went well, what cost time and what is still open. Live
results are in `STATUS.md`, not here: nothing in this page claims a screen was seen on the site.

## What was built, in the order it landed

1. **Foundation (P21-21).** Dark palette and the other tokens in `tokens.css`, the boot script that paints the right theme before the first frame, the
   contrast check in `pnpm lint`, and the light `--faint` moved to pass 3:1. The visual suite had to stay green with no baseline touched before anything else was
   built on it (the "pixel-neutral" gate), and it did.
2. **Appearance in Account (P21-21).** Theme and density are two columns on the person, served in the session; the browser keeps a copy only for the boot script.
3. **Skeletons, empty states, motion (P21-22).**
4. **Jump to, search and the bell with avatars and badges; the Activity page (P21-10).**
5. **Phone shell (P21-23).** Bottom bar, edge swipe, 40 px header controls, one search icon, the Messages page; then swipe to reply, long press and the thread
   chips. Toasts clear the bottom bar through `--bottom-bar-h`.
6. **Boards templates, Jobs tiles, the Org chart grid and the Memory preview (P21-15);** Confirm and Deprecate on a concept really change it (see below).
7. **Composer polish (P21-04).** Long names are cut with an ellipsis, the handle kept whole.
8. **The Bundle A defects (WP-F):** Chat reply actions wait for a finished answer, an answer drops a `Citation:` line the model wrote, the Security chip reads
   as the method's name with a check, a routine drafted in words reaches the model for the workspace Brain, deleting a routine deletes its folder.
9. **Look checks (P21-24):** seed v21, the polish plates in light and dark, the runs spec, `docs/ui-guide.md`, and the live probe.

## Decisions taken without the owner (B1 to B18, reversible)

They are listed in `STATUS.md` with the date. In short: the default theme is System; the choice is stored with the person; dark is graphite with the
primary button inverted; pictures keep a light plate; text needs 4.5:1 and marks 3:1 in both themes; Compact is at most 70% of Comfortable; the phone bar has
five entries; the gestures are off on a wide screen; the header search icon is hidden on a phone; deleting a routine deletes its folder; the answer strip
removes `Citation:` and `Sources:` lines only when the answer has real citations; and seed v21 is opt-in so no older baseline moves.

One more was taken in this last package: **Confirm** on a memory concept is a commit as the person that rewrites the concept as it is, which the writer
stamps with a human verifier, so the concept reaches the top trust level; **Deprecate** is a commit that sets `status: deprecated`. Both are one-way in the
screen, a second press changes nothing, and a deprecated concept is still readable. If the owner wants a confirmation to expire, or Deprecate to be
undoable from the screen, that is a new row; the repository history already keeps every earlier version. The rules are in `docs/plugins/memory.md`.

## What went well

- **Tokens first.** Because every colour was a token before dark was added, dark was one block and one contrast table, not a sweep through every screen. The lint
  that refuses a colour or `data-theme` outside `tokens.css` is what keeps it that way.
- **The pixel-neutral gate.** Proving that the token work changed no existing picture before building on it meant a later difference had a known cause.
- **Disjoint files.** Each package owned its files, and a change needed in someone else's file was handed over, not made. Almost no merge cost.
- **Plates assert more than pixels.** A dark plate that was the light page would have passed a picture check on its own first baseline. Every polish plate also
  checks `data-theme`, the body background and sideways scroll.

## What cost time

- **A dark shot was the light page.** Before the theme existed, a Playwright `colorScheme: 'dark'` run produced the light page and was reported as checked.
  Now a dark claim needs the root attribute and a body colour that is not the light one. (MISTAKES P21-01/03.)
- **Stubs that look like features.** The memory Confirm and Deprecate routes returned `{ ok: true }` and changed nothing; the screen was built over them and
  its spec asserted no change. They are real now, with a unit test through the HTTP routes and a browser test.
- **Baselines are not looked at by the one who makes them.** A baseline made on the first run is right by definition. The polish specs therefore never create
  one by themselves: they fail on a missing baseline, and a person opens each picture before it is committed. `MANYTHREADS_VT_DRY` takes pictures to a folder for
  that look, without a baseline.
- **Shared machine.** Several agents ran Playwright at once: stacks failed to start (connection slots, a web build removed under a running test). One process at a
  time, `--workers=1`, and a re-run before debugging a surprising first failure.
- **Layout that moves on blur.** A bottom bar that came back the moment focus left the box moved the Send button from under the finger. It now waits 300 ms.

## Still open

- The plates exist as specs; their baselines are made in the integration pass, after each picture is opened. About 106 new pictures.
- `e2e/channels/esc.spec.ts` was not written: Esc on the list and in a menu is already covered by `hover-bar.spec.ts` (its fifth test).
- Answer citations at 390 can run past the right edge of their card (the long source title is cut, not wrapped); it needs a CSS change in the answer card.
- The Memory trust levels below "reviewed by a person" cannot be made through the UI or the API (the writer stamps every person); the lower levels come from a
  bot's own write, as in the unit test.
- Light `--warn` text on the page grey is under 3:1 and is listed in `tools/lint-contrast/allow.json`, each with its reason; a darker amber is an owner decision.

## Mistakes added to MISTAKES.md

See the lines tagged P21-15, P21-21 to P21-24 there. The ones from the last package: a stub route that returns `ok` while the screen assumes it works; a
visual spec that cannot be looked at before its baseline exists; a seed that must stay out of the default world.
