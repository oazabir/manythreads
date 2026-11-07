# UI guide

How the web client looks and how to add a screen that looks right. It was written at the end of Phase 21 (the polish phase); the rules below are the ones
`docs/engineering/conventions.md` enforces with lint, plus the habits that lint cannot check. `PLAN.md` Phase 21 has the reasons, `docs/testing.md` §3a
the visual specs.

## 1. Look rules

- **Colours mean one thing each.** Blue is you and yours, purple is bots, amber is something that needs attention, red is a mention or an error, grey is
  everything else. The aliases are `--you`, `--bot`, `--attention`, `--danger`, `--mention` and `--focus` in `clients/web/src/styles/tokens.css`.
- **One type scale, three radii, one focus ring.** Do not write a font size or a radius as a number in a screen's CSS; use the token. A keyboard user sees
  the same 2 px ring everywhere.
- **One filled button per view.** The primary action is `btn primary`; everything else is a plain `btn` or a link.
- **Plain words.** No file name, path, slug, id or setting key in screen text. Say "the bot's definition", not `BOT.md`. `tools/lint-copy` scans the
  literals in `.tsx` files; it cannot see text built from data, so look at the screen too.
- **Icons are ProIcons** (`shell/icons.tsx`, `components/proicon.tsx`), never a text glyph. Emoji that people pick or type stay emoji.

## 2. Tokens, and both themes

- **A colour is a token.** `tokens.css` is the only file allowed to hold a colour value, and the only file allowed to mention `data-theme`
  (stylelint refuses `rgb()`, `hsl()` and `[data-theme]` anywhere else). A screen never has "a dark rule"; it uses the token, and the token changes
  value with the theme.
- **Two themes.** Light is the `:root` block. Dark is `:root[data-theme="dark"]` (graphite, not black: `--paper #0F1216`). `.theme-dark-scope` paints a
  small preview of dark inside a light page (the Appearance cards, `/dev/tokens`).
- **The person's choice** is System (follow the device), Light or Dark, stored with the person (`PUT /api/me/appearance`, served in `GET /api/session`).
  The browser keeps the last value in `localStorage['mt.appearance']` only so `public/theme-boot.js` can paint the right theme before the first frame
  (a classic script, because the CSP allows no inline script). `shell/appearance.ts` applies a change; no screen reads the theme itself.
- **Pictures stay on a light plate** (`--plate`): avatars, bot pictures, image, PDF and diagram viewers, embedded apps. Do not recolour them.
- **Contrast is a lint.** `tools/lint-contrast` (part of `pnpm lint`) checks every text token at 4.5:1 and every mark (icon, border, dot, placeholder) at
  3:1, on each surface and wash it sits on, in both themes. A new wash goes in `tools/lint-contrast/pairs.ts` in the same change.
- Look at `/dev/tokens` to see both palettes side by side.

## 3. Density

Two message densities, chosen in Account, Appearance: **Comfortable** (default) and **Compact**. They are `:root[data-density]` blocks in `tokens.css`
that change the spacing tokens (`--msg-pad-y`, `--msg-gap`, `--run-gap`, `--av-size`, `--gutter-w`, `--day-gap`). Compact applies to channels, direct
messages and the thread panel; Chat and the Threads inbox keep their own layout. A new message-like row must take its spacing from those tokens, not
from pixels.

Messages by one person inside five minutes form a **run**: one avatar and name, then plain lines; the time shows in the gutter on hover or tap. The
rule is `continuesRun` in `clients/web/src/channels/runs.ts` (same author, five minutes at the most, same day, nothing under the earlier message, and an
Answer, poll, forward or deleted message never joins). The "New" line splits a run.

## 4. Add a screen

1. **`PageHeader` first.** Every screen starts with `<PageHeader title description actions />`: one `h1`, one line of help, the actions on the right. The
   shell shows the breadcrumb and the bell; the screen never draws a second title. Register the route in `App.tsx`, and a title and section in
   `shell/nav.ts` and `shell/breadcrumb.ts` (with a line in `shell-nav.test.ts`).
2. **Loading is a `Skeleton`.** `SkeletonRows` for a list, `SkeletonMessages` for a conversation. Both carry `role="status" aria-busy="true"` and a label,
   which is also what the visual specs wait on. The word "Loading…" is only for a wait inside a dialog or a button.
3. **Nothing to show is an `EmptyState`.** A 48 px outline icon, a title, one line of help and at most one action, the next thing to do. Never a bare
   "No items".
4. **An error says what happened and what to do**, in one sentence, with a retry when one helps.
5. **Take colours, radii and spacing from the tokens.** If you need a new colour, add the token (both themes) and its contrast pair.
6. **Write the spec** that goes with it (§7).

## 5. Motion

`styles/motion.css` is loaded last and only adds animation. Menus and pop-overs fade in and rise 4 px (`--dur-menu`), the thread panel slides in
(`--dur-panel`), a message a link jumped to glows once. Everything sits inside `@media (prefers-reduced-motion: no-preference)`, so a person who asked
for no motion, and every visual spec, sees the end state at once. Do not animate layout properties of a list that is virtualised.

## 6. Phone rules (390 px, up to 760 px wide)

- **Bottom bar**: Home (unread threads), Messages, Activity, Search, You (the account sheet). 56 px plus the safe area, published as
  `--bottom-bar-h`; anything fixed to the bottom (toasts, a sticky bar) sits above it, never at a number of pixels. It steps aside while a text box has focus
  and inside a full-screen thread, and waits a moment before it comes back so a tap on Send is not moved from under the finger.
- **Touch targets are at least 40 px** in the header and 44 px in a list row. One search icon in a header.
- **Gestures**: a swipe in from the left edge opens the drawer; a swipe right on a message opens its thread; a long press opens the reactions. They are
  off on a wide screen and never fight scrolling (`touch-action: pan-y` on the list).
- **No sideways scroll**, ever. Every polish plate asserts it.
- A channel name wraps to two lines at the most and is never cut with "…"; the topic is hidden.

## 7. Specs and plates

- Visual specs for the look live in `e2e/visual/polish/`: `channel`, `shell`, `screens` and `phone`. Each **plate** is one picture in light and dark,
  at 1440 and 390 (`<name>-<1440|390>-<light|dark>.png`), made by `plate()` in `e2e/visual/support/polish.ts`. A plate also asserts what a picture
  cannot say: the page was drawn in the theme asked for, the dark body background is not the light one, and nothing scrolls sideways at 390.
- They run on a stack seeded with `MANYTHREADS_STACK_SEED=polish` (seed v21: `#polish`, with a run of twelve messages, a 40-line one, an Answer with
  three sources and a thread). It is opt-in, so the default world and every older baseline stay as they were.
- Behaviours that are not pixels are in `e2e/shell/theme.spec.ts`, `e2e/mobile/bottom-bar.spec.ts`, `e2e/channels/runs.spec.ts` and the others named in
  `PLAN.md` Phase 21.
- **Refreshing a plate.** A baseline is changed only on purpose: delete the PNG of the plate that should move, run
  `pnpm -C e2e exec playwright test visual/polish/<spec> --project=desktop --update-snapshots=missing`, open the new picture and look at it, then
  commit it with a line about why. Do not use `--update-snapshots` without a name list: the 0.2% tolerance keeps a stale plate green, and a wrong picture
  would be saved as right. To look at a plate before any baseline exists, set `MANYTHREADS_VT_DRY=1` and `MANYTHREADS_VT_DUMP=<folder>`: the pictures are
  written to the folder and nothing is compared or saved.
- **The live check** of a release is `e2e/screens/task.verify-bundle-b.shots.ts` (see its header): it signs in through the real form, walks about 30 routes in
  both themes at both sizes, and records PASS or FAIL per check.
