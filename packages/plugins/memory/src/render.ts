import { createHash } from 'node:crypto';
import { memoryContentDigest } from '@manythreads/sdk';

// Pure text work for the feed: what a source becomes as a memory document, the hash that recognises it again, and the id the engine files it
// under. No database, no clock, no engine. Everything here is linear in the input (slices, joins and one hash; no regular expression with a
// nested quantifier), and every output is bounded: a document is at most `MAX_DOC_CHARS`, a metadata value at most 500 characters.

/** The engine takes 20,000 characters per item; the feed stays under it with room for the header. */
export const MAX_DOC_CHARS = 18_000;
/** One message inside a thread document. */
export const MAX_MESSAGE_CHARS = 4_000;
/** Replies read into a thread document: the root and this many replies, oldest first; the rest are counted, not quoted. */
export const MAX_THREAD_REPLIES = 100;

/** What the feed hands the memory provider for one source. `content` is what the engine distils facts from. */
export interface FeedItem {
  content: string;
  /** The label of the document (`Message in #dev`), at most 200 characters. */
  context: string;
  /** When the thing happened (ISO 8601). */
  timestamp: string;
  tags: string[];
  /** Provenance: source, actor, time, link, ... (values are at most 500 characters; the provider adds team, workspace and `source: platform`). */
  metadata: Record<string, string>;
}

/** The first `max` characters of `text`, never ending inside a surrogate pair, with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose partner was cut
  return `${text.slice(0, end)}…`;
}

/** Collapses runs of blank lines and trailing spaces; keeps the author's own line structure. Linear: one pass over the lines. */
export function tidy(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * HMAC-SHA-256 of the text under the workspace's key (`src/keys.ts`), lowercase hex: what the retain log keeps instead of the text and what the
 * document id carries. Keyed because an unkeyed digest of a message is a dictionary oracle for whoever reads the log or a document id — and a
 * `forgotten` line is a deleted, perhaps secret, text. The same text in the same workspace always has the same digest (idempotency).
 */
export const contentHash = (text: string, key: Buffer | string): string => memoryContentDigest(text, key);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * The engine document of one source in one version: `feed:<kind>:<source>:<first 16 hex of the content hash>`. A source that is
 * delivered again with the same text gets the same id (an upsert: nothing changes); an edit gets a new id, and the platform forgets the
 * old one (the retain log remembers which). A source id that is not a uuid (a page path) is hashed so the id stays short and plain.
 */
export function documentIdFor(kind: string, sourceId: string, hash: string): string {
  const part = isUuid(sourceId) ? sourceId.toLowerCase() : createHash('sha256').update(sourceId, 'utf8').digest('hex').slice(0, 24);
  return `feed:${kind}:${part}:${hash.slice(0, 16)}`;
}

/** `prefix:value`, at most 64 characters (a tag's limit in the provider's schema). */
export const tagOf = (prefix: string, value: string): string => `${prefix}:${value}`.slice(0, 64);

const isoDate = (at: string): string => at.slice(0, 16).replace('T', ' ');

/** Metadata values are at most 500 characters and keys at most 64 (the provider's schema); a value is clipped, an empty one left out. */
export function metadataOf(entries: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined || value === '') continue;
    out[key.slice(0, 64)] = clip(value, 500);
  }
  return out;
}

export interface MessageFacts {
  channelName: string;
  authorName: string;
  at: string;
  body: string;
}

export function renderMessage(facts: MessageFacts): { content: string; context: string } {
  const body = clip(tidy(facts.body), MAX_DOC_CHARS);
  return {
    content: `${facts.authorName} wrote in #${facts.channelName} on ${isoDate(facts.at)}:\n${body}`,
    context: clip(`Message in #${facts.channelName}`, 200),
  };
}

export interface ThreadFacts {
  channelName: string;
  title: string;
  /** Oldest first; the first is the root. */
  messages: ReadonlyArray<{ authorName: string; at: string; body: string }>;
  /** Replies beyond the ones quoted. */
  moreReplies: number;
}

export function renderThread(facts: ThreadFacts): { content: string; context: string } {
  const head = `Thread in #${facts.channelName}${facts.title.trim() === '' ? '' : `: ${clip(tidy(facts.title).replace(/\n/g, ' '), 200)}`}`;
  const parts: string[] = [head];
  let used = head.length;
  let dropped = 0;
  for (const m of facts.messages) {
    const entry = `\n[${isoDate(m.at)}] ${m.authorName}: ${clip(tidy(m.body), MAX_MESSAGE_CHARS)}`;
    // Never past the engine's limit: what does not fit is counted, so the document says it is partial.
    if (used + entry.length > MAX_DOC_CHARS - 60) {
      dropped += 1;
      continue;
    }
    parts.push(entry);
    used += entry.length;
  }
  const more = facts.moreReplies + dropped;
  if (more > 0) parts.push(`\n(${more} more ${more === 1 ? 'message' : 'messages'} in the thread are not included.)`);
  return { content: parts.join(''), context: clip(`Thread in #${facts.channelName}`, 200) };
}

export interface RunFacts {
  botName: string;
  teamSlug: string;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  askerName: string | null;
  channelName: string | null;
  /** Counts of what the run read by source type (`message`, `page`, `memory`, ...), in a stable order. Types and counts only: no ids, no text. */
  sources: ReadonlyArray<{ type: string; count: number }>;
}

const TRIGGER_WORDS: Record<string, string> = {
  conversation: 'a conversation',
  mention: 'a mention',
  routine: 'a routine',
  task_assigned: 'an assigned task',
  inbox: 'the inbox',
  channel_message: 'a channel message',
  webhook: 'a webhook',
};

export function renderRun(facts: RunFacts): { content: string; context: string } {
  const lines: string[] = [];
  const where = facts.channelName === null ? '' : ` in #${facts.channelName}`;
  const asker = facts.askerName === null ? '' : `, asked by ${facts.askerName}`;
  lines.push(`The bot ${facts.botName} of team ${facts.teamSlug} ran for ${TRIGGER_WORDS[facts.trigger] ?? facts.trigger}${where}${asker}.`);
  lines.push(`It started ${isoDate(facts.startedAt)}${facts.endedAt === null ? '' : ` and ended ${isoDate(facts.endedAt)}`}; the run ${facts.status === 'done' ? 'finished' : facts.status === 'failed' ? 'failed' : 'stopped'}.`);
  const total = facts.sources.reduce((n, s) => n + s.count, 0);
  if (total === 0) lines.push('It read nothing from the workspace.');
  else lines.push(`It read ${total} ${total === 1 ? 'source' : 'sources'}: ${facts.sources.map((s) => `${s.count} ${s.type}`).join(', ')}.`);
  return { content: clip(lines.join('\n'), MAX_DOC_CHARS), context: clip(`Run of ${facts.botName}`, 200) };
}

export interface ApprovalFacts {
  tool: string;
  source: string;
  summary: string;
  status: string;
  outcome: string;
  outcomeDetail: string;
  requesterName: string;
  botName: string | null;
  deciderName: string | null;
  decidedAt: string | null;
  channelName: string | null;
}

export function renderApproval(facts: ApprovalFacts): { content: string; context: string } {
  const lines: string[] = [];
  const by = facts.botName === null ? facts.requesterName : `${facts.botName} (for ${facts.requesterName})`;
  lines.push(`Approval requested by ${by}${facts.channelName === null ? '' : ` in #${facts.channelName}`}: ${clip(tidy(facts.summary).replace(/\n/g, ' '), 300)}`);
  lines.push(`Tool ${facts.tool}, raised by ${facts.source === 'grant' ? 'the bot’s grant' : `the ${facts.source} rule`}.`);
  if (facts.status === 'expired') lines.push('Nobody decided it in time; it lapsed.');
  else {
    lines.push(`${facts.status === 'approved' ? 'Approved' : 'Denied'}${facts.deciderName === null ? '' : ` by ${facts.deciderName}`}${facts.decidedAt === null ? '' : ` on ${isoDate(facts.decidedAt)}`}.`);
    if (facts.status === 'approved' && facts.outcome !== 'none') {
      lines.push(`The call ${facts.outcome === 'ran' ? 'ran' : facts.outcome === 'failed' ? 'did not run' : 'was queued'}${facts.outcomeDetail === '' ? '' : `: ${clip(facts.outcomeDetail, 300)}`}`);
    }
  }
  return { content: clip(lines.join('\n'), MAX_DOC_CHARS), context: clip(`Approval of ${facts.tool}`, 200) };
}

export interface PageFacts {
  path: string;
  text: string;
  authorName: string | null;
  at: string;
}

export function renderPage(facts: PageFacts): { content: string; context: string } {
  const head = `Page ${facts.path}${facts.authorName === null ? '' : `, last written by ${facts.authorName}`} on ${isoDate(facts.at)}:\n`;
  return { content: head + clip(tidy(facts.text), MAX_DOC_CHARS - head.length), context: clip(`Page ${facts.path}`, 200) };
}
