import type { MeetingNoteItem, MeetingSeriesFrequency } from '@manythreads/shared';
import { stripHostileText } from './limits.ts';
import { escapeMarkdown } from './writer.ts';

// The agenda page of a meeting series (P17-05, docs/plans/meeting-series.md): what the platform writes for each meeting, and how it finds the action items still
// open in the last one. Pure functions over strings: one pass over the lines, no regex with a quantifier inside another (the text is the team's, so hostile input).

/** How many open items are carried into one agenda, and how long one may be. */
export const CARRY_MAX = 50;
export const CARRY_TEXT_MAX = 300;

export const AGENDA_HEADING = 'Agenda';
export const CARRIED_HEADING = 'Open action items from the last meeting';
export const ACTIONS_HEADING = 'Action items';
export const ACTIONS_HINT = "*Tick an item when it is done. Items not ticked are copied into the next meeting's agenda.*";

/** A heading's words, or null for a line that is not a heading (`#` to `######`, then a space). */
function headingOf(line: string): string | null {
  let n = 0;
  while (n < line.length && n < 7 && line[n] === '#') n += 1;
  if (n === 0 || n > 6 || line[n] !== ' ') return null;
  return line.slice(n + 1).trim().toLowerCase();
}

const isActionHeading = (heading: string): boolean => heading === ACTIONS_HEADING.toLowerCase() || heading.startsWith(CARRIED_HEADING.toLowerCase());

/** A task-list line: `- [ ] text`, `* [x] text` or `+ [X] text`, at any indentation. Null for any other line. */
function taskOf(line: string): { done: boolean; text: string } | null {
  const t = line.trimStart();
  if (t.length < 6 || !'-*+'.includes(t[0]!) || t[1] !== ' ' || t[2] !== '[' || t[4] !== ']' || t[5] !== ' ') return null;
  const mark = t[3];
  if (mark !== ' ' && mark !== 'x' && mark !== 'X') return null;
  return { done: mark !== ' ', text: t.slice(6).trim() };
}

/** The same item said twice: case, spaces and the trailing full stop do not count. */
export const itemKey = (text: string): string => stripHostileText(text).toLowerCase().replace(/\.$/, '');

/** One line of at most `CARRY_TEXT_MAX` characters, never cut inside a character outside the basic plane. */
function oneLine(text: string): string {
  const clean = stripHostileText(text);
  const chars = [...clean];
  return chars.length <= CARRY_TEXT_MAX ? clean : `${chars.slice(0, CARRY_TEXT_MAX - 1).join('')}…`;
}

/**
 * The boxes not ticked under the agenda's action-item headings ("Open action items from the last meeting" and "Action items"), in order, each once. A box elsewhere
 * (an agenda point written as a checklist) and anything inside a code fence is not an action item.
 */
export function openActionItems(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inActions = false;
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3);
      continue;
    }
    const heading = headingOf(trimmed);
    if (heading !== null) {
      inActions = isActionHeading(heading);
      continue;
    }
    if (!inActions) continue;
    const task = taskOf(line);
    if (!task || task.done || task.text === '') continue;
    const text = oneLine(task.text);
    const key = itemKey(text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= CARRY_MAX) break;
  }
  return out;
}

/** The action items of written notes as agenda lines ("Send the draft — Priya"), Markdown escaped: the words came from a model reading what people said. */
export function noteActionItems(items: readonly MeetingNoteItem[]): string[] {
  return items
    .filter((i) => i.kind === 'action')
    .map((i) => {
      const owner = i.ownerName ? stripHostileText(i.ownerName) : '';
      return oneLine(`${escapeMarkdown(stripHostileText(i.text))}${owner ? ` — ${escapeMarkdown(owner)}` : ''}`);
    })
    .filter((t) => t !== '');
}

/** The items to carry: the last agenda's first, then the notes' ones not already there, at most `CARRY_MAX`. */
export function mergeCarried(fromAgenda: readonly string[], fromNotes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...fromAgenda, ...fromNotes]) {
    const key = itemKey(t.replace(/\\/g, ''));
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= CARRY_MAX) break;
  }
  return out;
}

/** "Every week", "Every 2 weeks until 2027-03-31". */
export function ruleLabel(frequency: MeetingSeriesFrequency, untilDate: string | null): string {
  const every = frequency === 'weekly' ? 'Every week' : frequency === 'biweekly' ? 'Every 2 weeks' : 'Every month';
  return untilDate ? `${every} until ${untilDate}` : every;
}

/** One meeting's agenda page. `dateLabel` is the day in the series' time zone ("Tuesday 1 December 2026"). */
export function renderAgenda(input: { title: string; dateLabel: string; carried: readonly string[]; agendaLine: string }): string {
  const line = stripHostileText(input.agendaLine);
  return [
    `# ${escapeMarkdown(stripHostileText(input.title))} · ${input.dateLabel}`,
    '',
    `## ${AGENDA_HEADING}`,
    line ? `- ${escapeMarkdown(line)}` : '- ',
    '',
    `## ${CARRIED_HEADING}`,
    ...(input.carried.length > 0 ? input.carried.map((t) => `- [ ] ${t}`) : ['*Nothing was left open.*']),
    '',
    `## ${ACTIONS_HEADING}`,
    ACTIONS_HINT,
    '',
    '- [ ] ',
    '',
    '## Notes',
    '',
  ].join('\n');
}

/** The series folder's README: what the folder is. */
export function renderReadme(input: { title: string; teamName: string; frequency: MeetingSeriesFrequency; untilDate: string | null }): string {
  return [
    `# ${escapeMarkdown(stripHostileText(input.title))}`,
    '',
    `A meeting series of ${escapeMarkdown(stripHostileText(input.teamName))}: ${ruleLabel(input.frequency, input.untilDate).toLowerCase()}.`,
    '',
    "Each meeting has its agenda page here, named by its day. Everyone on the team can edit it, together, from the meeting on the Schedule. Action items not ticked are copied into the next meeting's agenda.",
    '',
  ].join('\n');
}

/**
 * Whether the next meeting's agenda is due: the first meeting's at once; a later one's once the meeting before it ended an hour ago and its call is over, and in any
 * case an hour before it starts.
 */
export function agendaDue(input: { previousEndsAt: Date | null; startsAt: Date; now: Date; callLive: boolean }): boolean {
  if (input.previousEndsAt === null) return true;
  if (input.startsAt.getTime() - input.now.getTime() <= 3600_000) return true;
  return !input.callLive && input.previousEndsAt.getTime() + 3600_000 <= input.now.getTime();
}

/** Every task line of a page, ticked or not, by its key: what a page already holds. Code fences skipped. */
function taskKeys(lines: readonly string[]): Set<string> {
  const keys = new Set<string>();
  let fence: string | null = null;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3);
      continue;
    }
    const task = taskOf(line);
    if (task) keys.add(itemKey(task.text.replace(/\\/g, '')));
  }
  return keys;
}

/**
 * Notes written after the next agenda (P17-05 step 2): the items not yet on the page, ticked or not, are added at the end of its "Open action items from the
 * last meeting" section (in place of "Nothing was left open."), or in a new section of that name at the end when a person took the heading out. Null when every
 * item is already there. One pass over the lines; at most `CARRY_MAX` items added.
 */
export function addCarriedItems(markdown: string, items: readonly string[]): string | null {
  const lines = markdown.split('\n');
  const have = taskKeys(lines);
  const fresh: string[] = [];
  for (const t of items) {
    const key = itemKey(t.replace(/\\/g, ''));
    if (key === '' || have.has(key)) continue;
    have.add(key);
    fresh.push(`- [ ] ${t}`);
    if (fresh.length >= CARRY_MAX) break;
  }
  if (fresh.length === 0) return null;
  // the carried section: from its heading to the next heading (outside a code fence)
  let start = -1;
  let end = lines.length;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).trimStart();
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3);
      continue;
    }
    const heading = headingOf(trimmed);
    if (heading === null) continue;
    if (start === -1) {
      if (heading.startsWith(CARRIED_HEADING.toLowerCase())) start = i;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) {
    const body = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
    return `${body}\n## ${CARRIED_HEADING}\n${fresh.join('\n')}\n`;
  }
  const section = lines.slice(start + 1, end).filter((l) => l.trim() !== '*Nothing was left open.*');
  // the new items go after the section's last line that is not blank, so the blank line before the next heading stays
  let last = section.length;
  while (last > 0 && section[last - 1]!.trim() === '') last -= 1;
  const tail = section.slice(last);
  if (tail.length === 0 && end < lines.length) tail.push('');
  return [...lines.slice(0, start + 1), ...section.slice(0, last), ...fresh, ...tail, ...lines.slice(end)].join('\n');
}
