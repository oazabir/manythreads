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
/** Backgrounds of a filled badge or avatar whose text is the `surface` token (light text in light, dark text in dark). */
const FILLS = ['ink', 'human', 'agent', 'ok', 'alert', 'bot-grey'];

export function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const fg of READ_TEXT) {
    for (const bg of [...SURFACES, ...(WASHES[fg] ?? [])]) out.push({ fg, bg, min: TEXT, kind: 'text' });
  }
  for (const bg of FILLS) out.push({ fg: 'surface', bg, min: TEXT, kind: 'text' });
  for (let n = 1; n <= 10; n++) out.push({ fg: `av-${n}-ink`, bg: `av-${n}-bg`, min: TEXT, kind: 'text' });
  for (const fg of MARKS) {
    for (const bg of ['surface', 'shell', 'paper', 'nav-on']) out.push({ fg, bg, min: MARK, kind: 'mark' });
  }
  return out;
}
