# Themes for manythreads: Graphite, Linen, Harbor

Status: built (2026-11-16, Phase 28 in `PLAN.md`). The values moved to `tools/design/themes.mjs` (generator `tools/design/build-themes.mjs`, output `clients/web/src/styles/themes/`); the app also keeps the original look as a fourth palette, `classic`, which stays the default until the owner picks one (one line: `DEFAULT_PALETTE` in `packages/shared/src/entities/appearance.ts`, then regenerate the visual baselines). Original proposal text follows (2026-11-15; "nothing in the app has changed" was true then). The preview is `temp/theme-preview/index.html` (one file, fonts inside it, no request
leaves the page); the six screenshots are in `temp/theme-preview/shots/`. The token values and the contrast numbers below are written by
`temp/theme-preview/gen-doc.mjs` from `temp/theme-preview/themes.mjs`, the same data the preview draws, so the two cannot drift. That folder is git-ignored:
whoever builds the theme system should move `themes.mjs` into `tools/` first.

## What stays the same in every theme

A theme changes how the app looks, never what a colour means. These rules come from `clients/web/src/styles/tokens.css` and hold in all three:

- **Blue is you** (`--human`): links, your mention, your unread count, the thing you selected.
- **Purple is a bot** (`--agent`): the Bot label, a bot mention, the dot of a run that is working, a helper.
- **Amber needs you** (`--warn`): an approval, a run that waits for a person.
- **Red is a danger or a failure** (`--alert`): a failed step, a field error, Remove, a mention count.
- **Green is done or on** (`--ok`): a finished step, the to-do bar, a switch that is on, presence.
- Colour is never the only sign: every state also has a word or an icon (Working, Failed, Needs you, a check).
- A theme is a light palette and a dark palette under the same names. A screen never writes a colour, a size or a dark rule of its own.

Every palette passes the app's own contrast lint (`tools/lint-contrast/pairs.ts`: text 4.5:1 on every surface and wash it can sit on, marks 3:1) and the
pairs of the new tokens: 138 pairs for each of the six palettes, none below the line.

## The three themes

| Theme | Mood | Type | Corners | Density | Depth |
|---|---|---|---|---|---|
| **Graphite** | Calm and exact: neutral greys, hairline borders, almost no shadow, colour only where something is happening. | Inter, JetBrains Mono | 6px / 8px / 12px | body 14px, controls 30px | borders only; a shadow only under a menu |
| **Linen** | Warm and unhurried: paper tones, a serif for titles, soft shadows; reads like a well-kept notebook. | IBM Plex Sans + Source Serif 4 titles, IBM Plex Mono | 8px / 12px / 18px | body 15px, controls 34px | soft warm shadow under every card |
| **Harbor** | Clear and confident: white panels on cool blue-grey, one strong blue for what you can press, crisp edges. | Geist, Geist Mono | 6px / 10px / 14px | body 14.5px, controls 32px | crisp border plus a small shadow |

What was taken from the three reference sites is the feel only: from the first, restraint (near-neutral greys, one-pixel borders, colour kept for state); from the
second, warmth (paper tones and a serif for titles); from the third, clarity (white panels, one confident blue for actions, state shown as small pills). No logo,
name or palette value is copied; every hex below was chosen for this app and checked against its contrast lint.

---

## Graphite

**Mood:** Calm and exact: neutral greys, hairline borders, almost no shadow, colour only where something is happening.

Screenshots: `temp/theme-preview/shots/graphite-light.png`, `temp/theme-preview/shots/graphite-dark.png`.

- **Fonts.** **Inter** for everything (already self-hosted in `clients/web/public/fonts`), **JetBrains Mono** for code. No new font file. Titles are the same face at 600 with slightly tight tracking (-0.014em).
- **Type scale.** display 26px · h1 20px · h2 15px · body 14px / 1.5 · small 13px · caption 12px · tiny 11px (count pills and table heads only). Titles 600, labels 500, text 400. Numbers that tick use tabular figures.
- **Radius.** 4 (code, checkbox) / 6 (buttons, fields, rows) / 8 (cards) / 12 (dialogs) / pill.
- **Density.** The densest of the three. Body 14 px on a 1.5 line, sidebar rows 28 px, controls 30 px, message padding 5 px. Spacing steps 4 / 8 / 12 / 16 / 24 / 32.
- **Shadows.** `--elev-1` is nothing: a card is a one-pixel border on the surface. `--elev-2` (menus) and `--elev-3` (dialogs) are one soft shadow plus a one-pixel ring, so a menu reads as lifted in dark too, where a shadow alone is invisible.
- **Motion.** Fast and small: 80 ms for hover and press, 110 ms for a menu (fade and rise 4 px), 180 ms for a side panel. The working dot breathes over 1.6 s. Nothing bounces. All of it sits under `prefers-reduced-motion: no-preference`, as `motion.css` does today.
- **Bots and accents.** Bot activity is quiet. The run card is a neutral card (`--run-bg` is a half-step off the surface, border `--rule`); purple appears only in the breathing dot, the state word, the Bot label and a helper's icon. The primary button is ink on paper (a light button with dark text in dark), so the only saturated colours on a screen are states. A thread with three bots working never turns purple.

### Tokens that already exist (same names as `tokens.css`)

```css
/* look: does not change with light or dark */
:root[data-palette="graphite"] {
  --sans: "Inter", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, monospace;
  --fs-display: 26px;
  --fs-h1: 20px;
  --fs-h2: 15px;
  --fs-body: 14px;
  --lh-body: 1.5;
  --fs-small: 13px;
  --fs-caption: 12px;
  --fs-tiny: 11px;
  --fw-title: 600;
  --fw-caption: 500;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-pill: 999px;
  --msg-pad-y: 5px;
  --msg-gap: 4px;
  --av-size: 30px;
  --gutter-w: 32px;
  --dur-menu: 110ms;
  --dur-panel: 180ms;
  --ease-out: cubic-bezier(0.2, 0.7, 0.3, 1);
}

:root[data-palette="graphite"][data-theme="light"] {
  color-scheme: light;
  --paper: #F0F1F3;
  --surface: #FFFFFF;
  --shell: #F7F7F8;
  --ink: #17181C;
  --txt: #26282E;
  --mute: #5B606B;
  --faint: #7B808B;
  --rule: #DFE1E5;
  --hairline: #ECEDF0;
  --table-head: #FAFAFB;
  --nav-on: #E8E9EC;
  --msg-hover: #F6F6F8;
  --human: #3156C4;
  --human-wash: #EEF2FC;
  --human-border: #BDCBF0;
  --agent: #7450C2;
  --agent-wash: #F5F2FC;
  --agent-border: #D7CCF0;
  --agent-ink: #4C3190;
  --ok: #2B7A52;
  --ok-wash: #EDF6F1;
  --ok-border: #B5D8C4;
  --ok-ink: #1E5C3D;
  --warn: #9F7416;
  --warn-wash: #FBF6E8;
  --warn-border: #E5D2A0;
  --warn-ink: #6E500E;
  --alert: #C2412C;
  --alert-wash: #FDF3F1;
  --alert-border: #ECBEB4;
  --alert-ink: #8E2E1D;
  --bot-grey: #646A76;
  --zip: #8A5A2B;
  --dot-off: #C4C7CE;
  --presence-ring: #787D88;
  --toggle-off: #C9CCD3;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 23 24 28;
  --card-alpha: 5%;
  --menu-alpha: 12%;
  --savebar-alpha: 20%;
  --scrim-alpha: 38%;
  --hover: rgb(23 24 28 / 5%);
  --skeleton: #E7E8EC;
  --skeleton-hi: #F3F4F6;
  --av-1-bg: #CFE6FE;
  --av-1-ink: #114472;
  --av-2-bg: #E7DDFB;
  --av-2-ink: #4A356C;
  --av-3-bg: #CEECD7;
  --av-3-ink: #00502B;
  --av-4-bg: #F0E1C5;
  --av-4-ink: #593D00;
  --av-5-bg: #FDDAD1;
  --av-5-ink: #6B2C1D;
  --av-6-bg: #C4EBF0;
  --av-6-ink: #004F5A;
  --av-7-bg: #F5D9EE;
  --av-7-ink: #602D56;
  --av-8-bg: #DFE8C9;
  --av-8-ink: #3C4900;
  --av-9-bg: #F8DDC8;
  --av-9-ink: #653400;
  --av-10-bg: #E1E3E7;
  --av-10-ink: #3E424B;
}

:root[data-palette="graphite"][data-theme="dark"] {
  color-scheme: dark;
  --paper: #08090A;
  --surface: #111214;
  --shell: #0C0D0F;
  --ink: #EDEEF0;
  --txt: #D5D7DB;
  --mute: #9A9FA9;
  --faint: #70757F;
  --rule: #26282D;
  --hairline: #1B1D21;
  --table-head: #15171A;
  --nav-on: #1E2024;
  --msg-hover: #17181B;
  --human: #8EA7F4;
  --human-wash: #161D33;
  --human-border: #2E3F73;
  --agent: #B49BEF;
  --agent-wash: #1C172B;
  --agent-border: #40346A;
  --agent-ink: #CDBBF6;
  --ok: #5DBB8A;
  --ok-wash: #11231A;
  --ok-border: #27543C;
  --ok-ink: #8AD3AB;
  --warn: #D6AB58;
  --warn-wash: #262012;
  --warn-border: #574722;
  --warn-ink: #E5C583;
  --alert: #EF8670;
  --alert-wash: #2A1815;
  --alert-border: #66362C;
  --alert-ink: #F5A794;
  --bot-grey: #8A909B;
  --zip: #D69E6C;
  --dot-off: #454850;
  --presence-ring: #8A909B;
  --toggle-off: #3A3D44;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 0 0 0;
  --card-alpha: 40%;
  --menu-alpha: 55%;
  --savebar-alpha: 70%;
  --scrim-alpha: 62%;
  --hover: rgb(255 255 255 / 6%);
  --skeleton: #1E2024;
  --skeleton-hi: #292B31;
  --av-1-bg: #1E3246;
  --av-1-ink: #A8D6FF;
  --av-2-bg: #342B44;
  --av-2-ink: #D9C5FF;
  --av-3-bg: #1C3726;
  --av-3-ink: #A6E2BA;
  --av-4-bg: #3B2E14;
  --av-4-ink: #EACD92;
  --av-5-bg: #442821;
  --av-5-ink: #FFBEAD;
  --av-6-bg: #0D373B;
  --av-6-ink: #8DE1EB;
  --av-7-bg: #3E2739;
  --av-7-ink: #F4BDE7;
  --av-8-bg: #2D3419;
  --av-8-ink: #CADA9C;
  --av-9-bg: #412B18;
  --av-9-ink: #FAC59A;
  --av-10-bg: #2E3034;
  --av-10-ink: #CDD1DA;
}
```

The message density tokens not listed (`--run-gap`, `--day-gap`) and `--lh-body`'s users keep today's values. `--card-shadow`, `--menu-shadow`, `--pop-shadow`
become aliases of `--elev-1`, `--elev-2`, `--elev-3`; the meaning aliases (`--you`, `--bot`, `--attention`, `--danger`, `--mention`, `--scrim`,
`--savebar-shadow`) are built as today; `--focus` becomes `var(--focus-ring)`.

### New tokens

```css
:root[data-palette="graphite"] {
  --font-display: "Inter", system-ui, sans-serif;
  --font-features: normal;
  --fw-display: 600;
  --ls-title: -0.014em;
  --ls-body: -0.006em;
  --ls-caps: 0.04em;
  --radius-xs: 4px;
  --ctl-h: 30px;
  --ctl-pad-x: 10px;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;
  --row-h: 28px;
  --dur-fast: 80ms;
  --dur-pulse: 1.6s;
  --run-rail-w: 0px;
  --border-w: 1px;
}

:root[data-palette="graphite"][data-theme="light"] {
  --accent: #17181C;
  --accent-hover: #2C2E35;
  --on-accent: #FFFFFF;
  --control-border: #8A8F9A;
  --control-bg: #FFFFFF;
  --focus-ring: #3156C4;
  --code-bg: #F5F5F7;
  --code-border: #E3E5E9;
  --code-ink: #26282E;
  --selection: #D5DFFA;
  --run-bg: #FBFBFC;
  --run-border: #DFE1E5;
  --run-rail: #7450C2;
  --run-state-ink: #4C3190;
  --run-pulse: #7450C2;
  --todo-bg: #FFFFFF;
  --todo-border: #DFE1E5;
  --todo-track: #E8E9EC;
  --todo-fill: #2B7A52;
  --elev-1: 0 0 0 0 transparent;
  --elev-2: 0 4px 16px rgb(23 24 28 / 10%), 0 0 0 1px rgb(23 24 28 / 4%);
  --elev-3: 0 16px 40px rgb(23 24 28 / 16%), 0 0 0 1px rgb(23 24 28 / 5%);
}

:root[data-palette="graphite"][data-theme="dark"] {
  --accent: #EDEEF0;
  --accent-hover: #FFFFFF;
  --on-accent: #111214;
  --control-border: #6A6F79;
  --control-bg: #0C0D0F;
  --focus-ring: #8EA7F4;
  --code-bg: #0C0D0F;
  --code-border: #26282D;
  --code-ink: #D5D7DB;
  --selection: #263562;
  --run-bg: #141518;
  --run-border: #26282D;
  --run-rail: #B49BEF;
  --run-state-ink: #CDBBF6;
  --run-pulse: #B49BEF;
  --todo-bg: #141518;
  --todo-border: #26282D;
  --todo-track: #26282D;
  --todo-fill: #5DBB8A;
  --elev-1: 0 0 0 0 transparent;
  --elev-2: 0 6px 20px rgb(0 0 0 / 50%), 0 0 0 1px rgb(255 255 255 / 6%);
  --elev-3: 0 20px 48px rgb(0 0 0 / 60%), 0 0 0 1px rgb(255 255 255 / 7%);
}
```

### Contrast (WCAG 2.x ratio; text needs 4.5, marks and control edges 3)

| Pair | Used for | Light | Dark |
|---|---|---|---|
| `--ink` on `--surface` | main text | 17.74 | 16.14 |
| `--txt` on `--surface` | message text | 14.73 | 13.01 |
| `--mute` on `--surface` | secondary text | 6.31 | 7.06 |
| `--mute` on `--nav-on` | secondary text on the selected sidebar row | 5.19 | 6.14 |
| `--faint` on `--surface` | icons, marks (3:1) | 3.96 | 4.05 |
| `--human` on `--surface` | links, your mention | 6.44 | 8.02 |
| `--human` on `--human-wash` | your chip | 5.75 | 7.14 |
| `--agent-ink` on `--agent-wash` | bot chip, Bot label | 8.83 | 9.97 |
| `--ok-ink` on `--ok-wash` | Done pill | 7.18 | 9.37 |
| `--warn-ink` on `--warn-wash` | Needs you | 6.90 | 9.74 |
| `--alert-ink` on `--alert-wash` | Failed pill, field error | 7.53 | 8.74 |
| `--on-accent` on `--accent` | primary button | 17.74 | 16.14 |
| `--surface` on `--human` | unread count | 6.44 | 8.02 |
| `--surface` on `--alert` | mention count | 5.14 | 7.42 |
| `--control-border` on `--surface` | field, checkbox, switch edge (3:1) | 3.24 | 3.72 |
| `--focus-ring` on `--surface` | focus ring (3:1) | 6.44 | 8.02 |
| `--focus-ring` on `--shell` | focus ring in the sidebar (3:1) | 6.02 | 8.32 |
| `--run-state-ink` on `--run-bg` | run card state word | 9.45 | 10.46 |
| `--mute` on `--run-bg` | run card small text | 6.10 | 6.87 |
| `--run-pulse` on `--run-bg` | run card dot (3:1) | 5.53 | 7.72 |
| `--todo-fill` on `--todo-bg` | to-do bar (3:1) | 5.24 | 7.77 |
| `--code-ink` on `--code-bg` | code | 13.53 | 13.49 |
| lowest text pair of all checked | light: `surface` on `alert`; dark: `surface` on `bot-grey` | 5.14 | 5.84 |
| lowest mark pair of all checked | light: `control-border` on `shell`; dark: `faint` on `nav-on` | 3.03 | 3.53 |

---

## Linen

**Mood:** Warm and unhurried: paper tones, a serif for titles, soft shadows; reads like a well-kept notebook.

Screenshots: `temp/theme-preview/shots/linen-light.png`, `temp/theme-preview/shots/linen-dark.png`.

- **Fonts.** **IBM Plex Sans** (400, 500, 600) for UI text, **Source Serif 4** (variable) for page and panel titles only (`--font-display`: the team name, a screen title, a settings heading; never a button, a label or a card title), **IBM Plex Mono** for code. All three are SIL OFL and on npm: `@fontsource/ibm-plex-sans`, `@fontsource-variable/source-serif-4`, `@fontsource/ibm-plex-mono`; copy the latin and latin-ext woff2 files into `clients/web/public/fonts` the way Inter is done today. IBM Plex Sans also ships Cyrillic, Greek and (as IBM Plex Sans Arabic) Arabic.
- **Type scale.** display 32px · h1 24px · h2 17px · body 15px / 1.6 · small 13.5px · caption 12.5px · tiny 11.5px (count pills and table heads only). Titles 600, labels 500, text 400. Numbers that tick use tabular figures.
- **Radius.** 5 / 8 / 12 / 18 / pill. Cards are visibly rounded; chips stay pills.
- **Density.** The roomiest. Body 15 px on a 1.6 line, sidebar rows 32 px, controls 34 px, message padding 8 px. Spacing steps 4 / 8 / 14 / 20 / 28 / 40. The existing Compact density still applies on top.
- **Shadows.** Two-layer shadows tinted with the ink (brown, never black, in light): `--elev-1` under every card, to-do card and field group; `--elev-2` under menus; `--elev-3` under dialogs. In dark the tint is black and borders carry more of the edge.
- **Motion.** Slower and softer: 120 ms hover, 160 ms menu, 240 ms panel, with a long ease-out. The working dot breathes over 2 s. All of it sits under `prefers-reduced-motion: no-preference`, as `motion.css` does today.
- **Bots and accents.** Bot activity is a tinted note. The run card sits on the plum wash (`--run-bg` = `--agent-wash`) with a plum border, like a sticky note from the bot; the to-do card stays plain paper with a shadow, because the plan belongs to the thread, not to one bot. The accent (primary button) is espresso ink, not a colour, so plum, ochre and brick keep their meanings.

### Tokens that already exist (same names as `tokens.css`)

```css
/* look: does not change with light or dark */
:root[data-palette="linen"] {
  --sans: "IBM Plex Sans", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  --fs-display: 32px;
  --fs-h1: 24px;
  --fs-h2: 17px;
  --fs-body: 15px;
  --lh-body: 1.6;
  --fs-small: 13.5px;
  --fs-caption: 12.5px;
  --fs-tiny: 11.5px;
  --fw-title: 600;
  --fw-caption: 500;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --radius-pill: 999px;
  --msg-pad-y: 8px;
  --msg-gap: 6px;
  --av-size: 34px;
  --gutter-w: 36px;
  --dur-menu: 160ms;
  --dur-panel: 240ms;
  --ease-out: cubic-bezier(0.22, 0.8, 0.3, 1);
}

:root[data-palette="linen"][data-theme="light"] {
  color-scheme: light;
  --paper: #EDE7DD;
  --surface: #FCFAF6;
  --shell: #F4EFE7;
  --ink: #2C2420;
  --txt: #3A312C;
  --mute: #65594F;
  --faint: #85786C;
  --rule: #DDD4C6;
  --hairline: #EAE3D8;
  --table-head: #F7F3EC;
  --nav-on: #E6DED1;
  --msg-hover: #F6F2EA;
  --human: #2A5A85;
  --human-wash: #EBF1F5;
  --human-border: #B4C9D9;
  --agent: #80488C;
  --agent-wash: #F7F0F6;
  --agent-border: #DEC8E0;
  --agent-ink: #5B2F66;
  --ok: #3F7140;
  --ok-wash: #EEF4EA;
  --ok-border: #BFD5B8;
  --ok-ink: #2D5730;
  --warn: #9A6B14;
  --warn-wash: #FAF2DF;
  --warn-border: #E4CF9B;
  --warn-ink: #6C4A0C;
  --alert: #B23F28;
  --alert-wash: #FBEFEA;
  --alert-border: #E6BBAD;
  --alert-ink: #84301D;
  --bot-grey: #6E6258;
  --zip: #8A5A2B;
  --dot-off: #CBC1B3;
  --presence-ring: #85786C;
  --toggle-off: #CFC5B7;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 70 50 30;
  --card-alpha: 8%;
  --menu-alpha: 16%;
  --savebar-alpha: 24%;
  --scrim-alpha: 36%;
  --hover: rgb(70 50 30 / 6%);
  --skeleton: #E6DED1;
  --skeleton-hi: #F2ECE2;
  --av-1-bg: #D3E5F9;
  --av-1-ink: #204569;
  --av-2-bg: #E6DEF6;
  --av-2-ink: #493864;
  --av-3-bg: #D3EAD9;
  --av-3-ink: #1A4E30;
  --av-4-bg: #EDE2CB;
  --av-4-ink: #553F05;
  --av-5-bg: #F8DCD4;
  --av-5-ink: #643226;
  --av-6-bg: #CBEAED;
  --av-6-ink: #004D55;
  --av-7-bg: #F2DBEC;
  --av-7-ink: #5A3252;
  --av-8-bg: #E0E7CE;
  --av-8-ink: #3D4814;
  --av-9-bg: #F4DECE;
  --av-9-ink: #5F3813;
  --av-10-bg: #E6E2DF;
  --av-10-ink: #49413B;
}

:root[data-palette="linen"][data-theme="dark"] {
  color-scheme: dark;
  --paper: #161311;
  --surface: #211D1A;
  --shell: #1B1815;
  --ink: #F0E9E0;
  --txt: #DDD4C9;
  --mute: #B3A699;
  --faint: #877B6F;
  --rule: #3B342E;
  --hairline: #2D2824;
  --table-head: #26221E;
  --nav-on: #352E29;
  --msg-hover: #282320;
  --human: #92BBDC;
  --human-wash: #1C2933;
  --human-border: #375369;
  --agent: #D2A6DC;
  --agent-wash: #2B2030;
  --agent-border: #59405F;
  --agent-ink: #E3C3EA;
  --ok: #93C48C;
  --ok-wash: #1D2A1C;
  --ok-border: #3D5A3A;
  --ok-ink: #B1D9AB;
  --warn: #DDB265;
  --warn-wash: #2E2615;
  --warn-border: #5F4D25;
  --warn-ink: #EBCB8C;
  --alert: #EE9077;
  --alert-wash: #331D17;
  --alert-border: #6F3C30;
  --alert-ink: #F6AE9A;
  --bot-grey: #A09385;
  --zip: #DDA774;
  --dot-off: #544B43;
  --presence-ring: #A09385;
  --toggle-off: #4A423B;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 0 0 0;
  --card-alpha: 36%;
  --menu-alpha: 50%;
  --savebar-alpha: 66%;
  --scrim-alpha: 60%;
  --hover: rgb(255 240 220 / 7%);
  --skeleton: #2D2824;
  --skeleton-hi: #3B342E;
  --av-1-bg: #223242;
  --av-1-ink: #B1D5FB;
  --av-2-bg: #332C40;
  --av-2-ink: #D7C8F7;
  --av-3-bg: #213628;
  --av-3-ink: #AFDEBE;
  --av-4-bg: #392F1B;
  --av-4-ink: #E5CEA0;
  --av-5-bg: #412A24;
  --av-5-ink: #F9C2B4;
  --av-6-bg: #183639;
  --av-6-ink: #9DDEE6;
  --av-7-bg: #3C2938;
  --av-7-ink: #EDC1E2;
  --av-8-bg: #2E331E;
  --av-8-ink: #CBD8A8;
  --av-9-bg: #3E2C1D;
  --av-9-ink: #F2C8A6;
  --av-10-bg: #332F2D;
  --av-10-ink: #D8CFC9;
}
```

The message density tokens not listed (`--run-gap`, `--day-gap`) and `--lh-body`'s users keep today's values. `--card-shadow`, `--menu-shadow`, `--pop-shadow`
become aliases of `--elev-1`, `--elev-2`, `--elev-3`; the meaning aliases (`--you`, `--bot`, `--attention`, `--danger`, `--mention`, `--scrim`,
`--savebar-shadow`) are built as today; `--focus` becomes `var(--focus-ring)`.

### New tokens

```css
:root[data-palette="linen"] {
  --font-display: "Source Serif 4", Georgia, serif;
  --font-features: normal;
  --fw-display: 600;
  --ls-title: -0.012em;
  --ls-body: 0;
  --ls-caps: 0.05em;
  --radius-xs: 5px;
  --ctl-h: 34px;
  --ctl-pad-x: 12px;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 14px;
  --sp-4: 20px;
  --sp-5: 28px;
  --sp-6: 40px;
  --row-h: 32px;
  --dur-fast: 120ms;
  --dur-pulse: 2s;
  --run-rail-w: 0px;
  --border-w: 1px;
}

:root[data-palette="linen"][data-theme="light"] {
  --accent: #3A2D26;
  --accent-hover: #4D3D34;
  --on-accent: #FCFAF6;
  --control-border: #94877A;
  --control-bg: #FFFEFB;
  --focus-ring: #2A5A85;
  --code-bg: #F4EFE7;
  --code-border: #E2D9CB;
  --code-ink: #3A312C;
  --selection: #D9E4EC;
  --run-bg: #F7F0F6;
  --run-border: #DEC8E0;
  --run-rail: #80488C;
  --run-state-ink: #5B2F66;
  --run-pulse: #80488C;
  --todo-bg: #FFFEFB;
  --todo-border: #DDD4C6;
  --todo-track: #E6DED1;
  --todo-fill: #3F7140;
  --elev-1: 0 1px 2px rgb(70 50 30 / 6%), 0 2px 8px rgb(70 50 30 / 5%);
  --elev-2: 0 2px 4px rgb(70 50 30 / 6%), 0 10px 28px rgb(70 50 30 / 14%);
  --elev-3: 0 4px 8px rgb(70 50 30 / 8%), 0 24px 56px rgb(70 50 30 / 20%);
}

:root[data-palette="linen"][data-theme="dark"] {
  --accent: #F0E9E0;
  --accent-hover: #FFFAF2;
  --on-accent: #211D1A;
  --control-border: #8B7F73;
  --control-bg: #1B1815;
  --focus-ring: #92BBDC;
  --code-bg: #1B1815;
  --code-border: #3B342E;
  --code-ink: #DDD4C9;
  --selection: #2F4758;
  --run-bg: #2B2030;
  --run-border: #59405F;
  --run-rail: #D2A6DC;
  --run-state-ink: #E3C3EA;
  --run-pulse: #D2A6DC;
  --todo-bg: #26221E;
  --todo-border: #3B342E;
  --todo-track: #3B342E;
  --todo-fill: #93C48C;
  --elev-1: 0 1px 2px rgb(0 0 0 / 30%), 0 2px 10px rgb(0 0 0 / 22%);
  --elev-2: 0 2px 6px rgb(0 0 0 / 35%), 0 12px 32px rgb(0 0 0 / 45%);
  --elev-3: 0 4px 10px rgb(0 0 0 / 40%), 0 28px 64px rgb(0 0 0 / 55%);
}
```

### Contrast (WCAG 2.x ratio; text needs 4.5, marks and control edges 3)

| Pair | Used for | Light | Dark |
|---|---|---|---|
| `--ink` on `--surface` | main text | 14.59 | 13.89 |
| `--txt` on `--surface` | message text | 12.17 | 11.42 |
| `--mute` on `--surface` | secondary text | 6.51 | 7.03 |
| `--mute` on `--nav-on` | secondary text on the selected sidebar row | 5.08 | 5.61 |
| `--faint` on `--surface` | icons, marks (3:1) | 4.11 | 4.06 |
| `--human` on `--surface` | links, your mention | 6.95 | 8.26 |
| `--human` on `--human-wash` | your chip | 6.36 | 7.33 |
| `--agent-ink` on `--agent-wash` | bot chip, Bot label | 9.18 | 9.81 |
| `--ok-ink` on `--ok-wash` | Done pill | 7.45 | 9.56 |
| `--warn-ink` on `--warn-wash` | Needs you | 7.18 | 9.58 |
| `--alert-ink` on `--alert-wash` | Failed pill, field error | 7.70 | 8.61 |
| `--on-accent` on `--accent` | primary button | 12.72 | 13.89 |
| `--surface` on `--human` | unread count | 6.95 | 8.26 |
| `--surface` on `--alert` | mention count | 5.54 | 7.08 |
| `--control-border` on `--surface` | field, checkbox, switch edge (3:1) | 3.35 | 4.29 |
| `--focus-ring` on `--surface` | focus ring (3:1) | 6.95 | 8.26 |
| `--focus-ring` on `--shell` | focus ring in the sidebar (3:1) | 6.33 | 8.72 |
| `--run-state-ink` on `--run-bg` | run card state word | 9.18 | 9.81 |
| `--mute` on `--run-bg` | run card small text | 6.06 | 6.53 |
| `--run-pulse` on `--run-bg` | run card dot (3:1) | 5.82 | 7.57 |
| `--todo-fill` on `--todo-bg` | to-do bar (3:1) | 5.71 | 7.91 |
| `--code-ink` on `--code-bg` | code | 11.08 | 12.07 |
| lowest text pair of all checked | light: `mute` on `nav-on`; dark: `surface` on `bot-grey` | 5.08 | 5.58 |
| lowest mark pair of all checked | light: `control-border` on `shell`; dark: `faint` on `nav-on` | 3.05 | 3.24 |

---

## Harbor

**Mood:** Clear and confident: white panels on cool blue-grey, one strong blue for what you can press, crisp edges.

Screenshots: `temp/theme-preview/shots/harbor-light.png`, `temp/theme-preview/shots/harbor-dark.png`.

- **Fonts.** **Geist** (variable) for everything, **Geist Mono** for code; both SIL OFL, on npm as `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (latin, latin-ext and Cyrillic subsets). Titles are the same face at 600 with tight tracking (-0.02em); body text gets a hair of positive tracking (0.008em) because Geist sets tight at 13 px.
- **Type scale.** display 28px · h1 22px · h2 16px · body 14.5px / 1.5 · small 13px · caption 12px · tiny 11px (count pills and table heads only). Titles 600, labels 500, text 400. Numbers that tick use tabular figures.
- **Radius.** 4 / 6 / 10 / 14 / pill.
- **Density.** Between the other two. Body 14.5 px on a 1.5 line (the app's numbers today), sidebar rows 30 px, controls 32 px. Spacing steps 4 / 8 / 12 / 16 / 24 / 32.
- **Shadows.** A crisp border does the work and a small cool shadow adds lift: `--elev-1` is one pixel of shadow under cards, `--elev-2` and `--elev-3` are two-layer navy-tinted shadows.
- **Motion.** Snappy with a long tail: 100 ms hover, 130 ms menu, 200 ms panel, on an expo-style ease-out. The working dot breathes over 1.4 s. All of it sits under `prefers-reduced-motion: no-preference`, as `motion.css` does today.
- **Bots and accents.** Bot activity is marked, not tinted. The run card is a white (dark: raised navy) card with a 3 px purple rail on its leading edge (`--run-rail-w: 3px`, mirrored in right-to-left), and states are small filled pills. This is the one theme with a coloured accent: the primary button, a ticked checkbox and a chosen radio are the same blue as "you" (in dark a deeper blue, `--accent`, with white text, while links use the lighter `--human`). Blue therefore always means "yours to press"; purple stays with bots.

### Tokens that already exist (same names as `tokens.css`)

```css
/* look: does not change with light or dark */
:root[data-palette="harbor"] {
  --sans: "Geist", system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, monospace;
  --fs-display: 28px;
  --fs-h1: 22px;
  --fs-h2: 16px;
  --fs-body: 14.5px;
  --lh-body: 1.5;
  --fs-small: 13px;
  --fs-caption: 12px;
  --fs-tiny: 11px;
  --fw-title: 600;
  --fw-caption: 500;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-pill: 999px;
  --msg-pad-y: 6px;
  --msg-gap: 6px;
  --av-size: 32px;
  --gutter-w: 34px;
  --dur-menu: 130ms;
  --dur-panel: 200ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

:root[data-palette="harbor"][data-theme="light"] {
  color-scheme: light;
  --paper: #E9EEF4;
  --surface: #FFFFFF;
  --shell: #F3F6FA;
  --ink: #0F1B2D;
  --txt: #1E2B3E;
  --mute: #4F5D72;
  --faint: #72809A;
  --rule: #D5DDE8;
  --hairline: #E6EBF2;
  --table-head: #F7F9FC;
  --nav-on: #DEE6F0;
  --msg-hover: #F4F7FB;
  --human: #0B5CBF;
  --human-wash: #E8F1FC;
  --human-border: #A9C8EE;
  --agent: #6D45C9;
  --agent-wash: #F3EFFD;
  --agent-border: #CFC1F2;
  --agent-ink: #4A2A9A;
  --ok: #0F7A4B;
  --ok-wash: #E7F6EE;
  --ok-border: #A6D9BE;
  --ok-ink: #0A5C38;
  --warn: #A46A04;
  --warn-wash: #FDF4E0;
  --warn-border: #EDD195;
  --warn-ink: #744A02;
  --alert: #CC3327;
  --alert-wash: #FEF1EF;
  --alert-border: #F2B9B2;
  --alert-ink: #962018;
  --bot-grey: #596780;
  --zip: #8A5A2B;
  --dot-off: #BCC6D4;
  --presence-ring: #72809A;
  --toggle-off: #C2CCDA;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 15 27 45;
  --card-alpha: 7%;
  --menu-alpha: 14%;
  --savebar-alpha: 22%;
  --scrim-alpha: 42%;
  --hover: rgb(15 27 45 / 5%);
  --skeleton: #E1E7EF;
  --skeleton-hi: #F0F3F8;
  --av-1-bg: #CBE6FF;
  --av-1-ink: #00447B;
  --av-2-bg: #E8DCFF;
  --av-2-ink: #4C3174;
  --av-3-bg: #CAEDD5;
  --av-3-ink: #005325;
  --av-4-bg: #F2E1BE;
  --av-4-ink: #5D3B00;
  --av-5-bg: #FFD8CD;
  --av-5-ink: #722512;
  --av-6-bg: #BDEDF3;
  --av-6-ink: #00515E;
  --av-7-bg: #F9D7F0;
  --av-7-ink: #65265A;
  --av-8-bg: #DEE8C4;
  --av-8-ink: #3B4A00;
  --av-9-bg: #FDDCC3;
  --av-9-ink: #6B2F00;
  --av-10-bg: #E0E3E7;
  --av-10-ink: #3C434A;
}

:root[data-palette="harbor"][data-theme="dark"] {
  color-scheme: dark;
  --paper: #070C14;
  --surface: #101826;
  --shell: #0B121D;
  --ink: #EAF0F8;
  --txt: #D2DBE8;
  --mute: #98A6BA;
  --faint: #6C7B92;
  --rule: #243044;
  --hairline: #1A2434;
  --table-head: #141D2C;
  --nav-on: #1D2940;
  --msg-hover: #151E2E;
  --human: #78B4FF;
  --human-wash: #10233F;
  --human-border: #254A7C;
  --agent: #B6A0FF;
  --agent-wash: #1D1A3A;
  --agent-border: #40377A;
  --agent-ink: #CFC0FF;
  --ok: #4CC98A;
  --ok-wash: #0C2620;
  --ok-border: #1E5743;
  --ok-ink: #82DDB0;
  --warn: #EDB04C;
  --warn-wash: #2A2212;
  --warn-border: #5E4A1E;
  --warn-ink: #F4CA82;
  --alert: #FF8272;
  --alert-wash: #30171A;
  --alert-border: #703036;
  --alert-ink: #FFA99D;
  --bot-grey: #8492A8;
  --zip: #DDA774;
  --dot-off: #3E4B61;
  --presence-ring: #8492A8;
  --toggle-off: #344056;
  --plate: #FFFFFF;
  --on-color: #FFFFFF;
  --on-color-line: rgb(255 255 255 / 35%);
  --shadow-color: 0 0 0;
  --card-alpha: 40%;
  --menu-alpha: 55%;
  --savebar-alpha: 70%;
  --scrim-alpha: 64%;
  --hover: rgb(200 220 255 / 7%);
  --skeleton: #1A2434;
  --skeleton-hi: #243044;
  --av-1-bg: #1A324B;
  --av-1-ink: #9FD6FF;
  --av-2-bg: #352A48;
  --av-2-ink: #DBC3FF;
  --av-3-bg: #173824;
  --av-3-ink: #9CE5B5;
  --av-4-bg: #3D2E0B;
  --av-4-ink: #EFCC84;
  --av-5-bg: #48261D;
  --av-5-ink: #FFBAA5;
  --av-6-bg: #00383D;
  --av-6-ink: #7BE4F0;
  --av-7-bg: #41253B;
  --av-7-ink: #FAB9EB;
  --av-8-bg: #2D3413;
  --av-8-ink: #C8DB91;
  --av-9-bg: #442912;
  --av-9-ink: #FFC28E;
  --av-10-bg: #2E3134;
  --av-10-ink: #CBD2DA;
}
```

The message density tokens not listed (`--run-gap`, `--day-gap`) and `--lh-body`'s users keep today's values. `--card-shadow`, `--menu-shadow`, `--pop-shadow`
become aliases of `--elev-1`, `--elev-2`, `--elev-3`; the meaning aliases (`--you`, `--bot`, `--attention`, `--danger`, `--mention`, `--scrim`,
`--savebar-shadow`) are built as today; `--focus` becomes `var(--focus-ring)`.

### New tokens

```css
:root[data-palette="harbor"] {
  --font-display: "Geist", system-ui, sans-serif;
  --font-features: normal;
  --fw-display: 600;
  --ls-title: -0.02em;
  --ls-body: 0.008em;
  --ls-caps: 0.06em;
  --radius-xs: 4px;
  --ctl-h: 32px;
  --ctl-pad-x: 12px;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;
  --row-h: 30px;
  --dur-fast: 100ms;
  --dur-pulse: 1.4s;
  --run-rail-w: 3px;
  --border-w: 1px;
}

:root[data-palette="harbor"][data-theme="light"] {
  --accent: #0B5CBF;
  --accent-hover: #094FA6;
  --on-accent: #FFFFFF;
  --control-border: #7C8AA1;
  --control-bg: #FFFFFF;
  --focus-ring: #0B5CBF;
  --code-bg: #F3F6FA;
  --code-border: #D5DDE8;
  --code-ink: #1E2B3E;
  --selection: #CCE0FA;
  --run-bg: #FFFFFF;
  --run-border: #D5DDE8;
  --run-rail: #6D45C9;
  --run-state-ink: #4A2A9A;
  --run-pulse: #6D45C9;
  --todo-bg: #FFFFFF;
  --todo-border: #D5DDE8;
  --todo-track: #DEE6F0;
  --todo-fill: #0F7A4B;
  --elev-1: 0 1px 2px rgb(15 27 45 / 7%);
  --elev-2: 0 1px 2px rgb(15 27 45 / 6%), 0 8px 24px rgb(15 27 45 / 13%);
  --elev-3: 0 2px 4px rgb(15 27 45 / 8%), 0 20px 48px rgb(15 27 45 / 20%);
}

:root[data-palette="harbor"][data-theme="dark"] {
  --accent: #1B66D2;
  --accent-hover: #2470DC;
  --on-accent: #FFFFFF;
  --control-border: #63738C;
  --control-bg: #0B121D;
  --focus-ring: #78B4FF;
  --code-bg: #0B121D;
  --code-border: #243044;
  --code-ink: #D2DBE8;
  --selection: #1D4480;
  --run-bg: #131C2C;
  --run-border: #243044;
  --run-rail: #B6A0FF;
  --run-state-ink: #CFC0FF;
  --run-pulse: #B6A0FF;
  --todo-bg: #131C2C;
  --todo-border: #243044;
  --todo-track: #243044;
  --todo-fill: #4CC98A;
  --elev-1: 0 1px 2px rgb(0 0 0 / 40%);
  --elev-2: 0 2px 4px rgb(0 0 0 / 40%), 0 10px 28px rgb(0 0 0 / 50%);
  --elev-3: 0 4px 8px rgb(0 0 0 / 45%), 0 24px 56px rgb(0 0 0 / 60%);
}
```

### Contrast (WCAG 2.x ratio; text needs 4.5, marks and control edges 3)

| Pair | Used for | Light | Dark |
|---|---|---|---|
| `--ink` on `--surface` | main text | 17.28 | 15.51 |
| `--txt` on `--surface` | message text | 14.28 | 12.74 |
| `--mute` on `--surface` | secondary text | 6.69 | 7.20 |
| `--mute` on `--nav-on` | secondary text on the selected sidebar row | 5.31 | 5.89 |
| `--faint` on `--surface` | icons, marks (3:1) | 3.98 | 4.14 |
| `--human` on `--surface` | links, your mention | 6.37 | 8.28 |
| `--human` on `--human-wash` | your chip | 5.59 | 7.32 |
| `--agent-ink` on `--agent-wash` | bot chip, Bot label | 8.89 | 10.02 |
| `--ok-ink` on `--ok-wash` | Done pill | 7.23 | 9.83 |
| `--warn-ink` on `--warn-wash` | Needs you | 7.05 | 10.19 |
| `--alert-ink` on `--alert-wash` | Failed pill, field error | 7.57 | 9.04 |
| `--on-accent` on `--accent` | primary button | 6.37 | 5.42 |
| `--surface` on `--human` | unread count | 6.37 | 8.28 |
| `--surface` on `--alert` | mention count | 5.16 | 7.36 |
| `--control-border` on `--surface` | field, checkbox, switch edge (3:1) | 3.50 | 3.69 |
| `--focus-ring` on `--surface` | focus ring (3:1) | 6.37 | 8.28 |
| `--focus-ring` on `--shell` | focus ring in the sidebar (3:1) | 5.88 | 8.74 |
| `--run-state-ink` on `--run-bg` | run card state word | 10.05 | 10.27 |
| `--mute` on `--run-bg` | run card small text | 6.69 | 6.91 |
| `--run-pulse` on `--run-bg` | run card dot (3:1) | 6.28 | 7.69 |
| `--todo-fill` on `--todo-bg` | to-do bar (3:1) | 5.38 | 8.15 |
| `--code-ink` on `--code-bg` | code | 13.18 | 13.45 |
| lowest text pair of all checked | light: `human` on `nav-on`; dark: `on-accent` on `accent-hover` | 5.06 | 4.74 |
| lowest mark pair of all checked | light: `faint` on `nav-on`; dark: `accent` on `surface` | 3.17 | 3.28 |

---

## The new tokens, and what they are for

| Token | Why it is needed | What uses it |
|---|---|---|
| `--accent`, `--accent-hover`, `--on-accent` | Today the primary button is hard-wired to `--ink` with `--surface` text (`app.css:140`). A theme with a coloured button (Harbor) needs its own pair, and in dark that pair is not "dark text on a light fill". | `.btn.primary`, a ticked checkbox, a chosen radio, the send button |
| `--control-border`, `--control-bg` | `--rule` is a divider (about 1.3:1). The edge of a field, a checkbox or an off switch is how a person finds the control, so it needs 3:1 (WCAG 1.4.11). | inputs, selects, the composer, checkbox, radio, the off switch |
| `--focus-ring` | The ring colour, checked at 3:1 on every surface. `--focus` becomes an alias. Ring: 2 px solid, 2 px offset; a field also gets a 3 px halo at 28%. | the one focus rule in `app.css:26` |
| `--code-bg`, `--code-border`, `--code-ink` | Code blocks use `--shell` today, which ties code to the sidebar colour. | `.md code`, `.md-codeblock`, `.code-pre` |
| `--selection` | Selected text; the browser default is a loud blue on the warm theme. | `::selection` |
| `--run-bg`, `--run-border`, `--run-rail`, `--run-rail-w`, `--run-state-ink`, `--run-pulse` | The run card is `--agent-wash` + `--agent-border` today, so every theme must tint it. These let a theme choose quiet (Graphite), tinted (Linen) or a rail (Harbor). | `run-card.css` `.rc`, `.rcState`, `.rcPulse` |
| `--todo-bg`, `--todo-border`, `--todo-track`, `--todo-fill` | Same for the to-do card; the track is `--hover` today, which is see-through, so its colour depends on what is under the card. | `todo-card.css` `.td`, `.tdBar` |
| `--elev-1`, `--elev-2`, `--elev-3` | Whole shadows per theme, not one shadow shape with a theme alpha: Graphite has none on cards, Linen has two layers. | cards, menus and pop-overs, dialogs |
| `--font-display`, `--fw-display`, `--ls-title`, `--ls-body`, `--ls-caps`, `--font-features` | A second face for titles and per-face tracking. | screen titles, the team name, settings headings; `body` |
| `--radius-xs` | The 3, 4 and 5 px corners written raw in `channels.css` (code, chips, checkbox). | inline code, chips, checkbox |
| `--ctl-h`, `--ctl-pad-x`, `--row-h`, `--sp-1` to `--sp-6` | Control height, row height and a spacing scale per theme. `--sp-2` is already read by `chat.css:449` and `chat.css:452` but is defined nowhere. | buttons, fields, sidebar rows, gaps |
| `--dur-fast`, `--dur-pulse` | Hover and press timing; the breathing dot (1.4 s raw in `motion.css:33`). | transitions, `.rcPulse`, `.tdPulse` |
| `--border-w` | One place for the hairline width (1 px in all three now). | borders |

Suggested syntax aliases, declared once in the shared block so a theme can retune code without touching meanings: `--syn-keyword: var(--agent-ink)`,
`--syn-string: var(--ok-ink)`, `--syn-number: var(--warn-ink)`, `--syn-title: var(--human)`, `--syn-comment: var(--mute)` (today `viewers.css:727-760`
reads `--agent`, `--faint` and `--alert` directly; `--faint` comments are 3:1, too low for text that is read).

---

## How to build the theme system

### 1. How a theme is applied

Keep what exists and add one attribute. `<html>` already carries `data-theme-choice` (system, light, dark), `data-theme` (light or dark, what is drawn) and
`data-density`. Add **`data-palette`** (graphite, linen, harbor, and today's look under a name such as `classic`).

- `data-theme` keeps meaning light or dark, so every rule, test and `.theme-dark-scope` box that reads it today keeps working. Do not fold the palette into it
  (`data-theme="linen-dark"`): that breaks `tokens.css:104`, the contrast lint's selectors (`tools/lint-contrast/check.ts:29-30`) and `color-scheme`.
- Selectors in `tokens.css`: `:root[data-palette="linen"]` for the look, `:root[data-palette="linen"][data-theme="light"]` and `…[data-theme="dark"]` for the
  colours. The palette with no attribute (`:root`) stays today's, so a missing or unknown value falls back safely.
- **Follow the device with the attribute, not with a media query in CSS.** `theme-boot.js` already resolves "system" with `matchMedia` and listens for a change.
  Writing each palette twice (once under `[data-theme="dark"]`, once under `@media (prefers-color-scheme: dark)`) doubles the file and lets the two copies drift.
  Keep one fallback only: `<meta name="color-scheme" content="light dark">` (already in `index.html:6`) so the page background is right even if the script fails.
- Split `tokens.css` into one file per palette (`styles/themes/graphite.css` …) plus the shared block, and extend the stylelint override
  (`stylelint.config.js:23-24`) to that folder; raw hex stays forbidden everywhere else.
- The derived block (`tokens.css:192-211`) must list no palette at all: move it to `:root, .theme-light-scope, .theme-dark-scope` so adding a palette never
  means editing it. For the Appearance previews add `.palette-<id>-scope` beside the existing `.theme-*-scope`.
- Stored choice: one new field, `palette`, beside `theme` and `density`: `packages/shared/src/entities/appearance.ts:7`, a forward-only migration after
  `packages/kernel/migrations/0017_person_appearance.sql:8` (a new column with a CHECK; do not widen the theme CHECK), `clients/web/src/shell/appearance.ts:34`
  and `:75`, and the Appearance screen (`clients/web/src/screens/account/Appearance.tsx:29`). An admin default for the team can come later; a person's choice wins.

### 2. Keeping it fast: no flash on load

- `clients/web/public/theme-boot.js` is the right design already: a blocking script of our own origin, first in `<head>`, before the styles (the page's CSP
  forbids inline script). It only needs to read `palette` from the same `mt.appearance` entry (`theme-boot.js:18`) and set `data-palette` beside
  `data-theme` (`theme-boot.js:28`). Unknown value: set nothing.
- Ship **all palettes in the one stylesheet**. Each palette is about 110 short custom properties, a few KB in all once compressed; a per-theme stylesheet loaded on demand
  would cost a request and bring the flash back.
- **Fonts are the real cost.** `index.html:10` preloads `inter-latin.woff2` for everyone. With themes, preload nothing in the HTML and let `theme-boot.js`
  add the one `<link rel="preload" as="font" crossorigin>` for the chosen palette's text face (Inter, IBM Plex Sans 400 or Geist); the title face and the mono
  face load when first used. Keep `font-display: swap` and give each face a metric-matched fallback (`size-adjust`, `ascent-override` on a local
  `@font-face` for Arial/Georgia) so the swap does not move the text. Declare every face in `fonts.css` with `unicode-range` as today: a face nobody
  uses is never downloaded.
- Switching in the session: set the attributes and nothing else. No React re-render is needed, because no screen reads the theme (`appearance.ts:7` says so and
  the code agrees). To stop every element animating its colour during the switch, add a `data-theme-switching` attribute for one frame that sets
  `transition: none` on `*`.
- Add `<meta name="theme-color">` (there is none in `index.html`) and let `appearance.ts` set it to the drawn `--shell`, so the phone browser bar and the
  Capacitor status bar match.
- Server truth still wins after sign-in (`clients/web/src/app/session.tsx:62-65`); keep writing the cache so the next load is right before the session answers.

### 3. What in the current CSS blocks theming

The codebase is in good shape: no stylesheet outside `tokens.css` contains a hex or an `rgb()` colour (stylelint enforces it), no screen writes a dark rule, and
no TypeScript reads the theme. What is left:

| # | Blocker | Where | What to do |
|---|---|---|---|
| 1 | Text on a filled colour is `color: var(--surface)` in 35 rules. It works only while every fill is dark in light and light in dark; Harbor's dark button (white on blue) breaks it. | `app.css:142`, `app.css:148`, `avatars.css:212`, `channels.css:463`, `channels.css:746`, `channels.css:842`; counts per file: screens 6, files 6, channels 5, shell 3, discover 2, app 2, and one each in eleven more | Use `--on-accent` on `--accent` fills and add `--on-you`, `--on-bot`, `--on-ok`, `--on-alert` (or one `--on-fill`) for the rest; update `FILLS` in `tools/lint-contrast/pairs.ts` |
| 2 | The primary button is ink by rule, and `--on-accent` is an alias of `--surface`. | `app.css:140-144`, `tokens.css:206`; `--on-accent` has one reader, `discover.css:40` | `.btn.primary` reads `--accent` / `--on-accent`; each palette sets them |
| 3 | `channels.css` is exempt from the look-token lint: 81 raw pixel font sizes and 41 raw radii, so the message list (the most seen screen) ignores a theme's type scale and corners. | `stylelint.config.js:20`; `channels.css:54` (14.5px), `:62`, `:77`, `:187` (13.5px), `:193` (11.5px), `:214` (10.5px), `:91` (12px radius), `:138`, `:308`, `:352`, `:461` | Map each to a `--fs-*` / `--radius-*` token (add `--radius-xs`), then drop the override |
| 4 | Markdown headings are sized in `em` (allowed by the lint), so they follow `--fs-body` but not a theme's `--fs-h1` / `--fs-h2`. | `surfaces.css:45` (1.25em), `surfaces.css:49` (1.1em), 22 such sizes in that file | Leave unless a theme wants its title face in rendered pages; then use `--font-display` there too |
| 5 | Two tokens are read but never defined (the declarations are silently dropped today). | `switcher.css:181` (`--muted`), `chat.css:449`, `chat.css:452` (`--sp-2`) | `--muted` is a typo for `--mute`; define the `--sp-*` scale |
| 6 | Two shadows ignore `--shadow-color` and are always black, so a warm theme gets cold shadows. | `tokens.css:209` (`--pop-shadow`), `tokens.css:210` (`--savebar-shadow`) | Alias to `--elev-3`; build the save-bar shadow from `--shadow-color` |
| 7 | One font for everything, by token and by rule. | `tokens.css:231-232`, `fonts.css` (Inter and JetBrains Mono only), `index.html:10` (preload), `docs/engineering/conventions.md:60` ("Inter (default for all UI text)"), `public/mermaid-sandbox.js:23` (`fontFamily: 'Inter…'`, `theme: 'neutral'`) | `--sans`, `--mono`, `--font-display` per palette; reword the convention to "the palette's faces, self-hosted"; pass the face and a light/dark flag into the diagram sandbox |
| 8 | Font weight is written raw (600 × 214, 500 × 54, 700 × 4, 650 × 1; only 13 rules read `--fw-*`). A face with other weight steps (Plex has no 650; Geist looks heavier at 600) cannot be tuned. | all screen files; e.g. `run-card.css` `.rcName`, `app.css:131` | Low priority: replace 600 with `var(--fw-title)` and 500 with `var(--fw-caption)` mechanically |
| 9 | 18 raw durations, so a theme's motion tokens do not reach them. | `motion.css:27`, `motion.css:33`, `chat.css:469`, `chat.css:762`, `boards.css:885`, `states.css:17`, `polls.css:103`, `setup.css:167`, `shell.css:592`, `shell.css:720`, `recorder.css:47`, `:87`, `:178`, `terminal.css:148`, `meetings.css:38`, `:58`, `workshop.css:407`, `channels.css:504` | `--dur-fast`, `--dur-pulse`; spinners can stay raw |
| 10 | 44 focus, selection and drop-target outlines name `--human` (43) or `--ink` (1) instead of `--focus`. Fine while the two are equal; wrong the day a palette separates them. | `files.css` (10: `:83`, `:371`, `:425`, …), `channels.css` (5), `workshop.css` (5), `terminal.css` (3: `:23`), `meetings.css` (3), `setup.css` (3), `agents.css:83` (`--ink`) | `outline: 2px solid var(--focus)`; drop-target outlines (dashed) may keep `--human` |
| 11 | Field and switch edges use `--rule` / `--toggle-off` (about 1.3:1 to 1.5:1 on the surface), below the 3:1 a control edge needs. Not a theming blocker but the brief asks AA for controls. | `tokens.css:66` (`--toggle-off`), every `border: 1px solid var(--rule)` on an input | `--control-border` on inputs, checkbox, radio and the off switch only; dividers keep `--rule` |
| 12 | The run card and the to-do card read bot tokens directly. | `run-card.css:16`, `run-card.css:18` (`--agent-border`, `--agent-wash`), `todo-card.css:12`, `todo-card.css:59` (`--hover` track), `todo-card.css:199` | The `--run-*` and `--todo-*` tokens above; today's values are the default |
| 13 | The tools know two palettes. | `tools/lint-contrast/check.ts:29-30` (two selector lists), `clients/web/src/pages/DevTokens.tsx:36` (`Scope = 'light' \| 'dark'`), `Appearance.tsx:29` | Loop the contrast lint over every palette file; it is the gate that lets a new theme ship without a full visual pass |
| 14 | Live-edit caret colours are computed in code at one lightness for every theme. | `clients/web/src/viewers/markdown/live.ts:43` (`hsl(h 72% 45%)`, white text on it) | Acceptable (white on these passes); better: ten `--peer-n` tokens, like the avatars |
| 15 | The tab icon is one fixed blue. | `clients/web/public/favicon.svg:1` (`#2F5D8A`) | Leave: it is the product mark, not a theme colour |
| 16 | Visual baselines (not checked in detail for this proposal) would multiply by the number of palettes if every screen were shot in each. | `e2e/__baselines__` | Keep full baselines for the default palette only; for the others run the contrast lint plus one baseline of `/dev/tokens` and of a thread with a run card |

Order of work that keeps every step shippable: (a) blockers 5, 6, 2 and the alias tokens, with today's look as the only palette: no visible change; (b) blockers
1, 3, 10, 12: still no visible change, baselines prove it; (c) `data-palette`, the boot script, the stored field and the lint loop; (d) add one palette at a
time, Graphite first (no new font), then Harbor, then Linen (two new faces).

### Things a theme must never do

- Change what a colour means, or use purple, amber or red as decoration.
- Put a serif (or any `--font-display`) on a control, a label, a message or a number.
- Set a colour, a size or a shadow in a screen file "just for this theme": add or reuse a token.
- Ship without the contrast lint passing for both of its palettes.
- Load a font from another origin at run time.
