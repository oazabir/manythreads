import { LIMITS, clip, compose, defang, inline, linkWithHost, safeUrl, stripControl, stripHtml } from './md.ts';
import { MARKS, markFromColor, markFromWord, markOf, withMark, type Mark } from './status.ts';
import { isObj, str, type Adapted, type Obj } from './types.ts';

// The generic JSON shape and the Slack/Mattermost shape in one reader. A sender writes `{ text, title?, url?, status?, color?, fields? }`; a Slack
// or Mattermost script writes `{ text, attachments: [...], blocks: [...] }`. Both come out as Markdown. The sender's own `text` is taken as
// Markdown (the person who made the webhook trusts the program that calls it) but loses raw HTML and control characters; everything else
// (titles, field names and values) is escaped like any text from outside.

/** Slack's mrkdwn → Markdown: `<url|label>` links, `<@U1>` / `<!here>` names, `*bold*`, and the three escaped characters. */
export function slackToMarkdown(s: string): string {
  let out = s.replace(/<(!|@|#)([^>|]{0,60})(?:\|([^>]{0,60}))?>/g, (_m, kind: string, id: string, label: string | undefined) =>
    kind === '!' ? `@\u200b${id.replace(/^here$|^channel$|^everyone$/, (w) => w)}` : (label ?? id),
  );
  out = out.replace(/<(https?:\/\/[^>|\s]{1,1000})(?:\|([^>]{0,200}))?>/g, (_m, url: string, label: string | undefined) => {
    const safe = safeUrl(url);
    if (safe === null) return label ?? '';
    return label ? `[${label.replace(/[[\]]/g, '')}](${safe})` : safe;
  });
  out = out.replace(/(^|[\s(])\*([^*\n]{1,200})\*(?=[\s).,!?:;]|$)/g, '$1**$2**');
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The sender's text: its own Markdown, minus raw HTML and control characters, cut to a sane length. */
function body(s: unknown, slack: boolean, max = 4000): string {
  if (typeof s !== 'string') return '';
  // Slack's `<url|label>` links are converted before raw HTML is stripped (they look like tags); mentions are broken last, so nobody is pinged
  const clean = stripControl(s).replace(/\r\n?/g, '\n');
  return clip(defang(stripHtml(slack ? slackToMarkdown(clean) : clean)).trim(), max);
}

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
function card(o: Obj, slack: boolean): string | null {
  const mark = markOfObject(o);
  const titleText = inline(o['title'] ?? o['fallback'] ?? '', LIMITS.title);
  const url = safeUrl(o['url'] ?? o['title_link']);
  const head = titleText === '' ? null : withMark(mark, `**${url ? linkWithHost(titleText, url) : titleText}**`);
  const author = str(o['author_name']);
  const text = body(o['text'], slack);
  const pretext = body(o['pretext'], slack, 500);
  const fields = fieldLines(o['fields']);
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

/** The Block Kit subset: header, section (text and fields), context, divider. */
function blocksToMarkdown(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const out: string[] = [];
  for (const b of blocks.slice(0, 20)) {
    if (!isObj(b)) continue;
    const type = str(b['type']);
    const textOf = (t: unknown): string => (isObj(t) ? body(t['text'], type !== 'header' && t['type'] !== 'plain_text', 1500) : '');
    if (type === 'header') {
      const t = inline(isObj(b['text']) ? b['text']['text'] : '', LIMITS.title);
      if (t) out.push(`**${t}**`);
    } else if (type === 'section') {
      const t = textOf(b['text']);
      if (t) out.push(t);
      const f = Array.isArray(b['fields']) ? b['fields'].slice(0, LIMITS.fields).map((x) => inline(isObj(x) ? slackToMarkdown(String(x['text'] ?? '')) : '', LIMITS.fieldValue)).filter((x) => x !== '') : [];
      if (f.length > 0) out.push(f.map((x) => `- ${x}`).join('\n'));
    } else if (type === 'context') {
      const els = Array.isArray(b['elements']) ? b['elements'].map((e) => (isObj(e) ? inline(slackToMarkdown(String(e['text'] ?? '')), 200) : '')).filter((x) => x !== '') : [];
      if (els.length > 0) out.push(`_${els.join(' · ')}_`);
    } else if (type === 'divider') {
      out.push('---');
    }
  }
  const text = compose(out);
  return text === '' ? null : text;
}

/** Whether a payload is written the Slack/Mattermost way (its `text` is mrkdwn). */
export function looksLikeSlack(o: Obj): boolean {
  return 'attachments' in o || 'blocks' in o || 'mrkdwn' in o || 'icon_emoji' in o || 'username' in o || 'response_type' in o;
}

/** A generic or Slack-shaped object as Markdown, or ignore when it has nothing a person could read. */
export function adaptGeneric(o: Obj): Adapted | null {
  const slack = looksLikeSlack(o);
  const known = ['text', 'title', 'message', 'fields', 'attachments', 'blocks', 'status', 'content'];
  if (!known.some((k) => k in o)) return null;
  const top = card({ ...o, text: o['text'] ?? o['message'] ?? o['content'] }, slack);
  const blocks = blocksToMarkdown(o['blocks']);
  const attachments = Array.isArray(o['attachments'])
    ? o['attachments'].slice(0, 5).map((a) => (isObj(a) ? card(a, slack) : null))
    : [];
  const text = compose([top, blocks, ...attachments]);
  if (text === '') return { kind: 'reject', reason: 'The payload has no text, title or fields to show.' };
  return { kind: 'post', text };
}
