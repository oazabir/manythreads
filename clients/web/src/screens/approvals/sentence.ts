import type { Approval } from '@manythreads/shared';
import { isShareApproval } from './shareApproval';

/*
 * One sentence for a request, built from who asked, which bot and what the call is about: "Nadia asked Support responder to send an email to
 * m.okafor". It reads the clipped preview the server already shows to every reader (never the raw call), so it can say no more than the card does.
 * A tool the table does not know still gets a plain sentence ("to use files.move (pages/old.md)") rather than nothing.
 */

type Preview = Approval['argsPreview'];

/** The tool every bot has to ask a person something (P24-03); a question is not an action to describe. */
export const ASK_TOOL = 'approvals.ask';
/** The bot's own program stopped at a command and asks whether to run it (P24-02). */
export const COMMAND_TOOL = 'agent.command';

/** The first non-empty text among these keys of the preview, trimmed to one short line. */
function pick(preview: Preview, keys: readonly string[]): string {
  if (typeof preview !== 'object' || preview === null) return '';
  for (const key of keys) {
    const v = preview[key];
    if (typeof v === 'string' && v.trim() !== '') {
      const line = v.trim().replace(/\s+/g, ' ');
      return line.length > 60 ? `${line.slice(0, 59)}…` : line;
    }
  }
  return '';
}

const to = (verb: string, target: string): string => (target ? `${verb} to ${target}` : verb);

type Phrase = (preview: Preview) => string;

const PHRASES: Record<string, Phrase> = {
  'email.send': (p) => to('send an email', pick(p, ['to', 'recipient'])),
  'gmail.send': (p) => to('send an email', pick(p, ['to', 'recipient'])),
  'email.draft': (p) => to('draft an email', pick(p, ['to', 'recipient'])),
  'intercom.reply': (p) => (pick(p, ['customer']) ? `reply to ${pick(p, ['customer'])} on Intercom` : 'reply to a customer on Intercom'),
  'pages.write': (p) => {
    const path = pick(p, ['path', 'title']);
    const create = typeof p === 'object' && p !== null && p['mode'] === 'create';
    return path ? `${create ? 'create' : 'change'} the page ${path}` : `${create ? 'create' : 'change'} a page`;
  },
  'files.write': (p) => (pick(p, ['path']) ? `write the file ${pick(p, ['path'])}` : 'write a file'),
  'files.delete': (p) => (pick(p, ['path']) ? `delete ${pick(p, ['path'])}` : 'delete a file'),
  'files.purge': (p) => (pick(p, ['path']) ? `permanently delete ${pick(p, ['path'])}` : 'permanently delete a file'),
  'brain.write': () => 'save something to the team’s memory',
  'jira.create_issue': (p) => (pick(p, ['title', 'summary']) ? `open the Jira issue “${pick(p, ['title', 'summary'])}”` : 'open a Jira issue'),
  'jira.comment': (p) => (pick(p, ['issue', 'key']) ? `comment on Jira issue ${pick(p, ['issue', 'key'])}` : 'comment on a Jira issue'),
  'ssh.exec': (p) => (pick(p, ['host', 'server']) ? `run a command on ${pick(p, ['host', 'server'])}` : 'run a command on a server'),
  'llm.call': () => 'send a message to the model',
  'agent.command': () => 'run a command',
};

/** The action alone, as a verb phrase ("send an email to m.okafor"). */
export function approvalAction(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source'>): string {
  // own keys only: a tool called "constructor" or "toString" must not pick a function off the prototype
  const known = Object.hasOwn(PHRASES, a.tool) ? PHRASES[a.tool] : undefined;
  if (known) return known(a.argsPreview);
  if (a.source === 'dlp') return 'send a message to the model';
  // the server's summary is "tool · what it is about": keep the "what" when there is one
  const summary = typeof a.summary === 'string' ? a.summary : '';
  const hint = summary.includes(' · ') ? summary.slice(summary.indexOf(' · ') + 3).trim() : pick(a.argsPreview, ['to', 'path', 'name', 'title', 'subject', 'query']);
  return hint ? `use ${a.tool} (${hint})` : `use ${a.tool}`;
}

/** The question of a bot's own ask, whole: the stored preview holds all of it (the summary is the list's one clipped line). */
export function askText(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview'>): string {
  const q = (a.argsPreview as Record<string, unknown>)['question'];
  if (typeof q === 'string' && q.trim() !== '') return q.trim();
  return typeof a.summary === 'string' ? a.summary.trim() : '';
}

/** "Nadia asked Support responder to send an email to m.okafor"; a bot that asked for itself reads "Support responder wants to ...". */
export function approvalSentence(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source' | 'botName' | 'requesterName'>): string {
  if (isShareApproval(a)) return `${a.requesterName} asked: ${a.summary}`;
  const bot = a.botName ?? 'a bot';
  // a bot's own question (`approvals.ask`) reads as the question; the bot's program stopping at a command reads as the bot wanting to run it
  if (a.tool === ASK_TOOL && askText(a) !== '') return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} asks: ${askText(a)}`;
  const action = approvalAction(a);
  const asker = typeof a.requesterName === 'string' ? a.requesterName : '';
  if (asker === bot || asker.trim() === '') return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} wants to ${action}`;
  return `${asker} asked ${bot} to ${action}`;
}

const LINE_MAX = 300;
export const oneLine = (text: string): string => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

/**
 * The sentence for a list row, an aria-label or a live region: a bot's own question reads from its `summary` (one clipped line, at most 300), never from the whole stored question
 * (up to 4,000 characters, line breaks and all). The cards draw the whole text in their bodies.
 */
export function approvalLine(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source' | 'botName' | 'requesterName'>): string {
  if (a.tool === ASK_TOOL && !isShareApproval(a)) {
    const bot = a.botName ?? 'a bot';
    const q = oneLine(typeof a.summary === 'string' ? a.summary : '');
    if (q !== '') return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} asks: ${q}`;
  }
  return oneLine(approvalSentence(a));
}

/**
 * A bot's own ask or command that carries more than its one line (details, a command, or a cut-short preview) is read in the card before it is answered: the list shows Open, never a
 * one-click Approve. The one rule for the inbox row and anything else that offers a quick answer from a list.
 */
export function needsOpen(a: Pick<Approval, 'source' | 'argsTruncated' | 'argsPreview'>): boolean {
  if (a.argsTruncated) return true;
  if (a.source !== 'agent') return false;
  const p = a.argsPreview as Record<string, unknown>;
  return ['details', 'command'].some((k) => typeof p[k] === 'string' && (p[k] as string).trim() !== '');
}

/** A bot's own ask or command keeps its whole text in the card; the list responses carry the first 300 characters of its details and say so (`argsTruncated`). Anyone who reads it may open the rest. */
export const ownsText = (a: Pick<Approval, 'tool'>): boolean => a.tool === ASK_TOOL || a.tool === COMMAND_TOOL;
