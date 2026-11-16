/*
 * The colour pairs the contrast lint checks, by token name (P21 plan B7). A pair added later (a new wash, a new filled badge) is listed here in
 * the same change that adds the token.
 *  - text pairs need 4.5:1: reading text on every surface and wash it can sit on, and the text on a filled badge;
 *  - mark pairs need 3:1: things that are seen but not read (the faint grey, a coloured icon or dot) on the four page backgrounds.
 */

export interface Pair {
  fg: string;
  bg: string;
  min: number;
  kind: 'text' | 'mark';
  /** Palettes the pair is not asked of. `classic` keeps the divider colour on its fields (it is the look the app always had), so the 3:1 edge is asked of the others. */
  except?: readonly string[];
}

const SURFACES = ['surface', 'shell', 'paper', 'nav-on', 'msg-hover'] as const;
const TEXT = 4.5;
const MARK = 3;

/** The washes a token's colour is meant to sit on, besides the plain surfaces. */
const WASHES: Record<string, readonly string[]> = {
  ink: ['human-wash', 'agent-wash', 'warn-wash', 'alert-wash', 'ok-wash'],
  txt: ['human-wash', 'agent-wash', 'warn-wash', 'alert-wash', 'ok-wash'],
  mute: ['human-wash', 'agent-wash', 'warn-wash', 'alert-wash', 'ok-wash'],
  human: ['human-wash'],
  'agent-ink': ['agent-wash'],
  'ok-ink': ['ok-wash'],
  'warn-ink': ['warn-wash'],
  'alert-ink': ['alert-wash'],
};

/** Text that is read, on the surfaces and its own wash. */
const READ_TEXT = Object.keys(WASHES);
/** Marks on the page backgrounds. */
const MARKS = ['faint', 'agent', 'ok', 'warn', 'alert'];
/** Fills and the token of the text that sits on each (P28: `--on-*`, which every palette keeps equal to the page colour unless it sets its own). */
const FILLS: ReadonlyArray<readonly [fill: string, on: string]> = [
  ['ink', 'on-ink'],
  ['human', 'on-you'],
  ['agent', 'on-bot'],
  ['agent-ink', 'on-bot'],
  ['ok', 'on-ok'],
  ['alert', 'on-alert'],
  ['bot-grey', 'on-grey'],
  ['accent', 'on-accent'],
  ['accent-hover', 'on-accent'],
];
const NO_CLASSIC = ['classic'] as const;

export function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const fg of READ_TEXT) {
    for (const bg of [...SURFACES, ...(WASHES[fg] ?? [])]) out.push({ fg, bg, min: TEXT, kind: 'text' });
  }
  for (const [bg, on] of FILLS) out.push({ fg: on, bg, min: TEXT, kind: 'text' });
  for (let n = 1; n <= 10; n++) out.push({ fg: `av-${n}-ink`, bg: `av-${n}-bg`, min: TEXT, kind: 'text' });
  for (const fg of MARKS) {
    for (const bg of ['surface', 'shell', 'paper', 'nav-on']) out.push({ fg, bg, min: MARK, kind: 'mark' });
  }
  // P28: the pairs of the new tokens (docs/design/themes.md, "Contrast")
  for (const bg of ['surface', 'shell', 'paper']) out.push({ fg: 'accent', bg, min: MARK, kind: 'mark' });
  for (const bg of ['surface', 'shell', 'control-bg']) out.push({ fg: 'control-border', bg, min: MARK, kind: 'mark', except: NO_CLASSIC });
  for (const bg of [...SURFACES.slice(0, 4), 'run-bg', 'todo-bg']) out.push({ fg: 'focus-ring', bg, min: MARK, kind: 'mark' });
  for (const fg of ['ink', 'txt', 'mute']) for (const bg of ['run-bg', 'todo-bg', 'code-bg', 'control-bg', 'table-head']) out.push({ fg, bg, min: TEXT, kind: 'text' });
  out.push({ fg: 'code-ink', bg: 'code-bg', min: TEXT, kind: 'text' }, { fg: 'run-state-ink', bg: 'run-bg', min: TEXT, kind: 'text' });
  out.push({ fg: 'run-pulse', bg: 'run-bg', min: MARK, kind: 'mark' }, { fg: 'run-rail', bg: 'run-bg', min: MARK, kind: 'mark' });
  out.push({ fg: 'todo-fill', bg: 'todo-bg', min: MARK, kind: 'mark' });
  for (const bg of ['run-bg', 'todo-bg']) out.push({ fg: 'faint', bg, min: MARK, kind: 'mark' });
  // the syntax colours of a code block are read as text
  for (const fg of ['syn-keyword', 'syn-string', 'syn-number', 'syn-title', 'syn-comment']) out.push({ fg, bg: 'code-bg', min: TEXT, kind: 'text' });
  out.push({ fg: 'ink', bg: 'selection', min: TEXT, kind: 'text' });
  return out;
}
