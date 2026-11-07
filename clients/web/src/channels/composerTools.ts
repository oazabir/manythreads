/*
 * The composer's toolbar as plain data (PLAN P21-04): which tool is which, the shortcut each one names in its tooltip, which keys the box answers to, and
 * which tools a narrow box keeps in view. Nothing here touches the page, so tests need none of it.
 */

export type ToolId = 'bold' | 'italic' | 'strike' | 'code' | 'codeblock' | 'quote' | 'bullet' | 'number' | 'link' | 'mention' | 'channel' | 'emoji' | 'poll';

/** `full`: every tool in a row. `more`: the common ones, the rest under "…" (the thread panel). `aa`: one "Aa" button that opens the row (a phone). */
export type ToolLayout = 'full' | 'more' | 'aa';

/** The tools a `more` layout keeps in the row; the others go under "…". Mention and emoji stay, because they open a list and are used most. */
const COMMON: ReadonlySet<ToolId> = new Set<ToolId>(['bold', 'italic', 'code', 'link', 'mention', 'emoji']);
/** The tools an `aa` layout keeps beside the "Aa" button. */
const PHONE: ReadonlySet<ToolId> = new Set<ToolId>(['mention', 'emoji']);

export const TOOL_ORDER: readonly ToolId[] = ['bold', 'italic', 'strike', 'code', 'codeblock', 'quote', 'bullet', 'number', 'link', 'mention', 'channel', 'emoji', 'poll'];

/** Which tools sit in the bar for a layout, in order. */
export function barTools(layout: ToolLayout, tools: readonly ToolId[], formatOpen: boolean): ToolId[] {
  if (layout === 'full') return [...tools];
  if (layout === 'aa') return formatOpen ? [...tools] : tools.filter((t) => PHONE.has(t));
  return tools.filter((t) => COMMON.has(t));
}

/** The tools a `more` layout puts under "…". */
export function moreTools(layout: ToolLayout, tools: readonly ToolId[]): ToolId[] {
  return layout === 'more' ? tools.filter((t) => !COMMON.has(t)) : [];
}

export type Chord = { key: string; shift?: boolean };

/** The keys that run a tool from inside the box. Ctrl on most machines, Cmd on a Mac. */
export const TOOL_CHORDS: Readonly<Partial<Record<ToolId, Chord>>> = {
  bold: { key: 'b' },
  italic: { key: 'i' },
  link: { key: 'k' },
  strike: { key: 'x', shift: true },
};

/** Whether the machine is a Mac (the shortcut is then written with the Command mark). */
export function isMac(platform: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.platform): boolean {
  return platform !== undefined && /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

/** "Ctrl+B", "Ctrl+Shift+X", or on a Mac "⌘B", "⌘⇧X". */
export function chordText(chord: Chord, mac: boolean): string {
  const key = chord.key.toUpperCase();
  return mac ? `⌘${chord.shift ? '⇧' : ''}${key}` : `Ctrl+${chord.shift ? 'Shift+' : ''}${key}`;
}

/** The tooltip of a tool: its name, then its shortcut in brackets when it has one. */
export function toolTitle(label: string, id: ToolId, mac: boolean): string {
  const chord = TOOL_CHORDS[id];
  return chord ? `${label} (${chordText(chord, mac)})` : label;
}

export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/** The tool a key press runs, or null: Ctrl or Cmd with B, I, K, or Shift with X. */
export function toolForKey(e: KeyLike): ToolId | null {
  if ((!e.ctrlKey && !e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  for (const id of ['bold', 'italic', 'link', 'strike'] as const) {
    const chord = TOOL_CHORDS[id];
    if (chord && chord.key === key && (chord.shift ?? false) === e.shiftKey) return id;
  }
  return null;
}

// ---- @channel and @here ---------------------------------------------------------------------------------------------------------------

export const BROADCAST_OPTIONS = [
  { word: 'channel', hint: 'Notify everyone who can read this' },
  { word: 'here', hint: 'Notify the people who are online now' },
] as const;

/** `@channel` and `@here` that a typed query points at (`@ch`, `@he`); all of them for a bare `@`. */
export function matchBroadcast(query: string): ReadonlyArray<(typeof BROADCAST_OPTIONS)[number]> {
  const q = query.toLowerCase();
  return BROADCAST_OPTIONS.filter((o) => q === '' || o.word.startsWith(q));
}

// ---- commands a screen brings (the Chat screen's /new, /model) -----------------------------------------------------------------------------

/** A command the screen around the box answers itself. `run` may answer with one line to show under the box. */
export type LocalCommand = { name: string; summary: string; usage?: string; run: (arg: string) => string | void };

/** The commands whose name starts with what is typed after the first `/`, while that first word is still being typed. */
export function matchLocalCommands(commands: readonly LocalCommand[], text: string): LocalCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const q = (m[1] ?? '').toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

/** The command a finished message runs (`/new`, `/model smart`), with the words after it; null when the first word is not one of them. */
export function parseLocalCommand(commands: readonly LocalCommand[], text: string): { command: LocalCommand; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = commands.find((c) => c.name === (m[1] ?? '').toLowerCase());
  return command ? { command, arg: (m[2] ?? '').trim() } : null;
}
