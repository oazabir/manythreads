import type { ToolApprovalCard } from '@manythreads/sdk';
import { hasNul, NO_NUL_MESSAGE } from '@manythreads/shared';
import { z } from 'zod';
import { asArray, asRecord, str } from './person-kit.ts';

// The shared pieces of the work-tracker tools (PLAN P16-06): the checked fields (an issue id is checked to the shape the tracker really uses, never "anything that
// encodes"), the card an approver reads, and the small readers of a tracker's answer. jira-tools.ts, linear-tools.ts, github-issues-tools.ts and asana-tools.ts are made of them.
//
//   * Every id is matched whole against the shape of the tracker's own ids and is then percent-encoded into the path, so `..`, `/`, `?` and `#` can never move a call to
//     another path (MISTAKES: P16-03 dots-only ids).
//   * Text the model writes is held to a length and refuses a NUL character (U+0000), which a stored approval cannot keep.
//   * An answer to the model is built field by field from the tracker's answer, each cut to a length. An error answer names no issue text, comment, title or key: only
//     our own words.
//   * The approval card is clipped by the platform at 300 characters a string, so what an approver must judge (the tracker, the target, the action) comes first, in the
//     summary, and a long text is shown from its start with its full length beside it (`chars`), never silently cut.

const noNul = (schema: z.ZodString): z.ZodString => schema.refine((v) => !hasNul(v), { message: NO_NUL_MESSAGE });

/** A one-line title for a new issue or task. */
export const issueTitle = noNul(z.string().min(1).max(250).regex(/^[^\r\n]+$/, 'one line'));
/** The text of an issue or task body. */
export const issueBody = noNul(z.string().min(1).max(8000));
/** The text of a comment. */
export const commentBody = noNul(z.string().min(1).max(4000));
/** Words to search for. */
export const words = noNul(z.string().min(1).max(200)).describe('Words to look for.');
/** The name of a status as the tracker spells it (In Progress, Done), compared without regard to case. */
export const statusName = noNul(z.string().min(1).max(60).regex(/^[^\r\n]+$/, 'one line')).describe('The status to move to, as the tracker names it (In Progress, Done).');
export const resultLimit = z.number().int().min(1).max(20).describe('Most results to answer with (default 10).').optional();

export const nonDotsOnly = (v: string): boolean => !/^\.+$/.test(v);

// ---- ids, in the shape each tracker really uses --------------------------------------------------------------------------------------------------------

/** A Jira issue key: the project key (capital letters, digits, underscore; two to ten) and a number. */
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,8}$/;
export const JIRA_PROJECT = /^[A-Z][A-Z0-9_]{1,9}$/;
/** A Linear team key, an issue identifier (`ENG-12`) and an issue id. */
export const LINEAR_TEAM = /^[A-Z][A-Z0-9]{0,9}$/;
export const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;
export const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** An Asana gid: digits only. */
export const ASANA_GID = /^[0-9]{1,20}$/;
/** A GitHub `owner/name`: an owner of letters, digits and hyphens, a name of letters, digits, dot, hyphen and underscore that is not only dots (`..` would climb a path). */
export const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export const jiraKey = z.string().regex(JIRA_KEY, 'not an issue key like PROJ-123').describe('The key of the issue (PROJ-123).');
export const jiraProject = z.string().regex(JIRA_PROJECT, 'not a project key like PROJ').describe('The key of the project (PROJ).');
export const linearIssue = z
  .string()
  .refine((v) => LINEAR_IDENTIFIER.test(v) || UUID.test(v), 'not an issue like ENG-123')
  .describe('The issue, as ENG-123 or the id a search answered.');
export const linearTeam = z.string().regex(LINEAR_TEAM, 'not a team key like ENG').describe('The key of the team (ENG).');
export const asanaGid = (what: string): z.ZodString => z.string().regex(ASANA_GID, 'not an id').describe(`The id of the ${what}, as an earlier answer gave it.`);
export const githubRepo = z
  .string()
  .regex(GITHUB_REPO, 'not a repository like owner/name')
  .refine((v) => nonDotsOnly(v.split('/')[1] ?? ''), 'not a repository like owner/name')
  .describe('The repository, as owner/name.');
export const githubNumber = z.number().int().min(1).max(100_000_000).describe('The number of the issue in the repository.');

// ---- the card an approver reads -----------------------------------------------------------------------------------------------------------------------

/** One line: whitespace folded, cut at `max`. */
export const oneLine = (s: unknown, max = 120): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** How much of a text the card shows; the platform cuts a string at 300, so we cut first and say so. */
export const CARD_TEXT = 280;
/** The most of a title the card repeats beside the summary. */
export const CARD_TITLE = 250;
const shown = (s: unknown): string => {
  const t = String(s ?? '').trim();
  return t.length > CARD_TEXT ? `${t.slice(0, CARD_TEXT - 1)}…` : t;
};

/**
 * The card for a write. The summary leads with the tracker, the act and the target, which is what decides whether to approve; the preview carries the same, then the
 * text from its start, with `…Chars` giving the full length of each text so an approver knows when more is behind the part shown.
 */
export function trackerCard(tracker: string, act: string, target: string, fields: Record<string, unknown> = {}, texts: Record<string, unknown> = {}): ToolApprovalCard {
  const preview: Record<string, unknown> = { tracker, act, target: oneLine(target, 200), ...fields };
  for (const [name, value] of Object.entries(texts)) {
    if (value === undefined) continue;
    preview[name] = shown(value);
    preview[`${name}Chars`] = String(value).length;
  }
  return { summary: `${tracker}: ${act} ${oneLine(target, 150)}`.slice(0, 280), preview };
}

// ---- readers of an answer -------------------------------------------------------------------------------------------------------------------------------

/** A link only when it is an http or https address (the answer is outside text, and a model or a person may follow it). */
export const linkOf = (v: unknown): string | null => {
  const s = str(v, 500);
  return s !== null && /^https?:\/\/[^\s]+$/.test(s) ? s : null;
};

/** The names inside a list of `{ name }` objects. */
export const namesOf = (v: unknown, max = 10): string[] =>
  asArray(v)
    .slice(0, max)
    .flatMap((x) => {
      const n = str(asRecord(x)['name'], 80);
      return n === null ? [] : [n];
    });

/** An answer that says a status the tracker does not offer. The names are the tracker's own workflow words, a few of them, never an issue's text. */
export const unknownStatus = (tracker: string, wanted: string, offered: readonly string[]): { ok: false; code: string; message: string; statuses: string[] } => ({
  ok: false,
  code: 'unknown_status',
  message: `${tracker} has no status “${oneLine(wanted, 60)}” that this issue can move to now. The ones it can move to are listed in statuses.`,
  statuses: offered.slice(0, 20),
});

/** The text of an Atlassian Document (the form Jira keeps descriptions and comments in), flattened to plain lines. Bounded in depth and size. */
export function adfToText(doc: unknown, maxChars = 20_000): string {
  const out: string[] = [];
  let size = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 20 || size > maxChars) return;
    const n = asRecord(node);
    const type = str(n['type'], 40) ?? '';
    if (type === 'text') {
      const t = str(n['text'], 5000) ?? '';
      out.push(t);
      size += t.length;
      return;
    }
    if (type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (type === 'mention' || type === 'emoji' || type === 'inlineCard') {
      const t = str(asRecord(n['attrs'])['text'], 100) ?? str(asRecord(n['attrs'])['shortName'], 50) ?? '';
      out.push(t);
      size += t.length;
      return;
    }
    for (const child of asArray(n['content']).slice(0, 200)) walk(child, depth + 1);
    if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(type)) out.push('\n\n');
    else if (['listItem', 'rule', 'tableRow'].includes(type)) out.push('\n');
  };
  walk(doc, 0);
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/**
 * Plain text as an Atlassian Document: one paragraph per blank-line-separated block. Nothing is cut: the text a person approved (at most issueBody's or commentBody's
 * length, held by the schema) is the text sent, every character of it, apart from the blank lines between paragraphs and the spaces around each.
 */
export function textToAdf(text: string): Record<string, unknown> {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
  return { type: 'doc', version: 1, content: blocks.map((b) => ({ type: 'paragraph', content: [{ type: 'text', text: b }] })) };
}
