import type { Approval } from '@manythreads/shared';
import { isShareApproval } from './shareApproval';

/*
 * One sentence for a request, built from who asked, which bot and what the call is about: "Nadia asked Support responder to send an email to
 * m.okafor". It reads the clipped preview the server already shows to every reader (never the raw call), so it can say no more than the card does.
 * A tool the table does not know still gets a plain sentence ("to use files.move (pages/old.md)") rather than nothing.
 */

type Preview = Approval['argsPreview'];

/** The first non-empty text among these keys of the preview, trimmed to one short line. */
function pick(preview: Preview, keys: readonly string[]): string {
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
    const create = p['mode'] === 'create';
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
};

/** The action alone, as a verb phrase ("send an email to m.okafor"). */
export function approvalAction(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source'>): string {
  const known = PHRASES[a.tool];
  if (known) return known(a.argsPreview);
  if (a.source === 'dlp') return 'send a message to the model';
  // the server's summary is "tool · what it is about": keep the "what" when there is one
  const hint = a.summary.includes(' · ') ? a.summary.slice(a.summary.indexOf(' · ') + 3).trim() : pick(a.argsPreview, ['to', 'path', 'name', 'title', 'subject', 'query']);
  return hint ? `use ${a.tool} (${hint})` : `use ${a.tool}`;
}

/** "Nadia asked Support responder to send an email to m.okafor"; a bot that asked for itself reads "Support responder wants to ...". */
export function approvalSentence(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source' | 'botName' | 'requesterName'>): string {
  if (isShareApproval(a)) return `${a.requesterName} asked: ${a.summary}`;
  const bot = a.botName ?? 'a bot';
  const action = approvalAction(a);
  if (a.requesterName === bot || a.requesterName.trim() === '') return `${bot.charAt(0).toUpperCase()}${bot.slice(1)} wants to ${action}`;
  return `${a.requesterName} asked ${bot} to ${action}`;
}
