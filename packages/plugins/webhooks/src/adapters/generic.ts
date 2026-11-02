import { LIMITS, compose, inline, linkWithHost, safeUrl } from './md.ts';
import { blocksToMarkdown, cleanBody } from './slack.ts';
import { MARKS, markFromColor, markFromWord, markOf, withMark, type Mark } from './status.ts';
import { isObj, str, type Adapted, type Obj } from './types.ts';

// The generic JSON shape and the Slack/Mattermost shape in one reader. A sender writes `{ text, title?, url?, status?, color?, fields? }`; a Slack
// or Mattermost script writes `{ text, attachments: [...], blocks: [...] }`. Both come out as Markdown. The sender's own `text` is taken as
// Markdown (the person who made the webhook trusts the program that calls it) but loses raw HTML and control characters; everything else
// (titles, field names and values) is escaped like any text from outside.

/** `fields` as list lines: an array of `{title|name|label|key, value}`, of `[name, value]` pairs, or an object of name → value. */
export function fieldLines(fields: unknown): string[] {
  const pairs: Array<[unknown, unknown]> = [];
  if (Array.isArray(fields)) {
    for (const f of fields.slice(0, LIMITS.fields)) {
      if (Array.isArray(f) && f.length >= 2) pairs.push([f[0], f[1]]);
      else if (isObj(f)) pairs.push([f['title'] ?? f['name'] ?? f['label'] ?? f['key'], f['value'] ?? f['text']]);
      else if (typeof f === 'string') pairs.push([undefined, f]);
    }
  } else if (isObj(fields)) {
    for (const [k, v] of Object.entries(fields).slice(0, LIMITS.fields)) pairs.push([k, v]);
  }
  const lines: string[] = [];
  for (const [k, v] of pairs) {
    const value = inline(typeof v === 'boolean' ? String(v) : v, LIMITS.fieldValue);
    if (value === '') continue;
    const name = inline(k, LIMITS.fieldName);
    lines.push(name === '' ? `- ${value}` : `- **${name}:** ${value}`);
  }
  return lines;
}

function markOfObject(o: Obj): Mark {
  return markOf(markFromWord(o['status']), markFromWord(o['level']), markFromWord(o['severity']), markFromWord(o['state']), markFromColor(o['color']));
}

/** One card: a title (linked when there is an address), the text, the fields. */
function card(o: Obj, slack: boolean, textMax = 4000): string | null {
  const mark = markOfObject(o);
  const text = cleanBody(o['text'], slack, textMax);
  const fields = fieldLines(o['fields']);
  // Slack's `fallback` is the plain line for places that cannot draw the card: it stands in only when the card has nothing else to say
  const titleText = inline(o['title'] ?? (text === '' && fields.length === 0 ? o['fallback'] : '') ?? '', LIMITS.title);
  const url = safeUrl(o['url'] ?? o['title_link']);
  const head = titleText === '' ? null : withMark(mark, `**${url ? linkWithHost(titleText, url) : titleText}**`);
  const author = str(o['author_name']);
  const pretext = cleanBody(o['pretext'], slack, 500);
  const footer = inline(o['footer'] ?? '', LIMITS.line);
  // with no title the marker goes in front of the text (or stands alone when there is only a marker and fields)
  const main = head === null && text !== '' ? withMark(mark, text) : text;
  const parts = [
    pretext || null,
    head,
    author ? inline(author, 80) : null,
    main || (head === null && fields.length === 0 && mark !== 'none' ? MARKS[mark] : null),
    fields.length > 0 ? fields.join('\n') : null,
    footer === '' ? null : `_${footer}_`,
  ];
  const out = compose(parts);
  return out === '' ? null : out;
}

/** Whether a payload is written the Slack/Mattermost way (its `text` is mrkdwn). */
export function looksLikeSlack(o: Obj): boolean {
  return 'attachments' in o || 'blocks' in o || 'mrkdwn' in o || 'icon_emoji' in o || 'username' in o || 'response_type' in o;
}

/** A generic or Slack-shaped object as Markdown, or ignore when it has nothing a person could read. */
export function adaptGeneric(o: Obj, options: { slack?: boolean; textMax?: number } = {}): Adapted | null {
  const slack = options.slack ?? looksLikeSlack(o);
  const known = ['text', 'title', 'message', 'fields', 'attachments', 'blocks', 'status', 'content'];
  if (!known.some((k) => k in o)) return null;
  const top = card({ ...o, text: o['text'] ?? o['message'] ?? o['content'] }, slack, options.textMax);
  const blocks = blocksToMarkdown(o['blocks']);
  const attachments = Array.isArray(o['attachments'])
    ? o['attachments'].slice(0, 5).map((a) => (isObj(a) ? card(a, slack) : null))
    : [];
  const text = compose([top, blocks.text, ...attachments]);
  if (text === '') return { kind: 'reject', reason: 'The payload has no text, title or fields to show.' };
  return { kind: 'post', text, ...(blocks.skipped > 0 ? { skipped: blocks.skipped } : {}) };
}
