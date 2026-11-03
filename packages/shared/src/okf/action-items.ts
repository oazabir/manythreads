// The line convention of an `Action Items` concept (PLAN P8-18, P8-20): what the Archivist writes and what the Inbox tab reads to offer "Add to board".
//
//     - [ ] Send the revised quote to Acme (owner: Nadia; due: 2026-11-20)
//
// A checkbox line (`-`, `*` or `+`, then `[ ]` open or `[x]` done), the action in plain words, and an optional trailing group in parentheses with
// `owner:` and/or `due:` (a `YYYY-MM-DD` date), separated by `;`. Any other line is not an action. The parser is a plain scan, linear in the size of the
// text, and it never throws: a malformed owner or date is left out of the item, the words stay in `what`.

export interface ActionItemLine {
  /** The place of this action among the actions of the concept (0-based, in body order). */
  index: number;
  /** The action in words, without the checkbox and without the trailing group. */
  what: string;
  /** The person named after `owner:`, as written; null when none. */
  owner: string | null;
  /** The date after `due:` (`YYYY-MM-DD`); null when none or when it is not a real calendar date. */
  due: string | null;
  done: boolean;
}

/** The most actions read from one concept (a longer list is cut, not refused). */
export const ACTION_ITEMS_MAX = 200;
const WHAT_MAX = 500;
const OWNER_MAX = 120;

function realDate(text: string): string | null {
  if (text.length !== 10 || text[4] !== '-' || text[7] !== '-') return null;
  const y = Number(text.slice(0, 4));
  const m = Number(text.slice(5, 7));
  const d = Number(text.slice(8, 10));
  if (![y, m, d].every(Number.isInteger) || y < 1970 || y > 2999 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last ? text : null;
}

/** The trailing `( ... )` group of a line, split at its start; null when the line does not end with a group that holds `owner:` or `due:`. */
function trailingGroup(line: string): { head: string; owner: string | null; due: string | null } | null {
  if (!line.endsWith(')')) return null;
  const open = line.lastIndexOf('(');
  if (open < 0) return null;
  const inside = line.slice(open + 1, -1);
  let owner: string | null = null;
  let due: string | null = null;
  let known = false;
  for (const part of inside.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key === 'owner') {
      known = true;
      if (value !== '' && value.length <= OWNER_MAX) owner = value;
    } else if (key === 'due') {
      known = true;
      due = realDate(value);
    }
  }
  return known ? { head: line.slice(0, open), owner, due } : null;
}

/** The actions in a concept's body, in order. Lines that are not a checkbox line are skipped. */
export function parseActionItems(body: string): ActionItemLine[] {
  const out: ActionItemLine[] = [];
  for (const raw of body.split('\n')) {
    if (out.length >= ACTION_ITEMS_MAX) break;
    const line = raw.trim();
    const bullet = line[0];
    if ((bullet !== '-' && bullet !== '*' && bullet !== '+') || line[1] !== ' ') continue;
    const rest = line.slice(2).trimStart();
    if (rest.length < 3 || rest[0] !== '[' || rest[2] !== ']') continue;
    const mark = rest[1];
    if (mark !== ' ' && mark !== 'x' && mark !== 'X') continue;
    let text = rest.slice(3).trim();
    let owner: string | null = null;
    let due: string | null = null;
    const group = trailingGroup(text);
    if (group) {
      text = group.head.trim();
      owner = group.owner;
      due = group.due;
    }
    if (text === '') continue;
    out.push({ index: out.length, what: text.slice(0, WHAT_MAX), owner, due, done: mark !== ' ' });
  }
  return out;
}
