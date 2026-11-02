import { LIMITS, clip, compose, defang, escapeInline, inline, linkWithHost, safeUrl, stripControl, stripHtml } from './md.ts';
import { isObj, str } from './types.ts';

// Slack's message language, read for the incoming webhook (PLAN P14-14) and for `chat.postMessage` / `chat.update` of the Slack-shaped API.
//
//  - `slackToMarkdown`: Slack's "mrkdwn" text becomes Markdown. `<https://x|label>` is a link, `<@U123>` / `<#C1|name>` / `<!here>` / `<!subteam^S1|@team>` become
//    plain text that notifies nobody (the `@` is broken, a name is only a name), `*bold*` / `~strike~` are converted, and Slack's three escapes (`&lt; &gt; &amp;`)
//    are undone. Everything runs in one pass per pattern with bounded classes: linear time (hostile-input tests pin it).
//  - `blocksToMarkdown`: the Block Kit subset: header, section (text, fields, an image or link button beside it), divider, context, image (as a link) and
//    actions (their buttons that carry an address, as links). Any other block is skipped and counted: it is the sender's richer message, never an error.
//
// Text from outside is untrusted: the callers pass the result through the same cleaning as every other payload (no raw HTML, no pings, no control characters).

const ZWSP = '​';
/** Most blocks read from one message (Slack allows 50); the rest are skipped and counted. */
export const MAX_BLOCKS = 50;

/** A label that goes inside `[...]` of a Markdown link: no brackets, one line. */
const linkLabel = (s: string): string => escapeInline(stripHtml(stripControl(s)).replace(/\s+/g, ' ').trim()).slice(0, 200);

/** A host-like word in a label: an optional scheme, then dotted name parts ending in letters (`bank.com`, `https://www.bank.com/login`). Labels are cut to 200 characters first. */
const HOSTISH = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const bareHost = (h: string): string => h.replace(/^https?:\/\//i, '').toLowerCase().replace(/^www\./, '');

/**
 * A link written by the sender. A label that names some other site than the address goes to (`[https://bank.com](https://evil.com)`) would mislead the
 * reader, so it is followed by the real host, like every other card with a sender-chosen link; an ordinary label (`the docs`) is shown as it is.
 * `rawLabel` is the label before escaping, `label` after.
 */
function senderLink(rawLabel: string, label: string, safe: string): string {
  let target: string;
  try {
    target = new URL(safe).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return `[${label}](${safe})`;
  }
  const named = rawLabel.slice(0, 200).match(HOSTISH) ?? [];
  const misleading = named.some((n) => bareHost(n) !== target);
  return misleading ? linkWithHost(label, safe) : `[${label}](${safe})`;
}

/** Slack's mrkdwn → Markdown. Pure; never throws. */
export function slackToMarkdown(s: string): string {
  // <!here> <!channel> <!everyone> <!subteam^S1|@team> <!date^1392734382^{date_num}|fallback>: a special mention. It is shown as plain text with the `@` broken.
  let out = s.replace(/<!([^>|]{0,80})(?:\|([^>]{0,80}))?>/g, (_m, id: string, label: string | undefined) => {
    const word = (label ?? id).replace(/^@+/, '').replace(/^subteam\^/, '').replace(/^date\^.*$/, label ?? 'date');
    return /^(here|channel|everyone)$/.test(id) || id.startsWith('subteam^') ? `@${ZWSP}${word}` : word;
  });
  // <@U123> <@U123|name> <#C123|name>: a person or a channel. Only the readable name is kept (or the id when there is none), as plain text.
  out = out.replace(/<([@#])([^>|]{0,60})(?:\|([^>]{0,60}))?>/g, (_m, kind: string, id: string, label: string | undefined) => {
    const word = (label ?? id).replace(/^[@#]+/, '');
    return kind === '@' ? `@${ZWSP}${word}` : `#${word}`;
  });
  // <https://example.com|label> and <https://example.com>
  out = out.replace(/<(https?:\/\/[^>|\s]{1,1000})(?:\|([^>]{0,200}))?>/g, (_m, url: string, label: string | undefined) => {
    const safe = safeUrl(url);
    if (safe === null) return label === undefined ? '' : linkLabel(label);
    const text = label === undefined ? '' : linkLabel(label);
    return text === '' ? safe : senderLink(label ?? '', text, safe);
  });
  // <mailto:a@b.c|label> <tel:...>: not links here; only the label (or nothing)
  out = out.replace(/<(?:mailto|tel):[^>|]{0,200}(?:\|([^>]{0,200}))?>/g, (_m, label: string | undefined) => (label === undefined ? '' : linkLabel(label)));
  // *bold* → **bold**, ~strike~ → ~~strike~~ (a pair on one line, next to a space or punctuation, so 2*3*4 and a_b_c stay as they are)
  out = out.replace(/(^|[\s(])\*([^*\n]{1,300})\*(?=[\s).,!?:;]|$)/g, '$1**$2**');
  out = out.replace(/(^|[\s(])~([^~\n]{1,300})~(?=[\s).,!?:;]|$)/g, '$1~~$2~~');
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The sender's own text as a message body: control characters and raw HTML gone, `@` broken, cut to `max`. `slack` turns mrkdwn into Markdown first. */
export function cleanBody(s: unknown, slack: boolean, max = 4000): string {
  if (typeof s !== 'string') return '';
  // Slack's `<url|label>` links are converted before raw HTML is stripped (they look like tags); mentions are broken last, so nobody is pinged
  const clean = stripControl(s).replace(/\r\n?/g, '\n');
  return clip(defang(stripHtml(slack ? slackToMarkdown(clean) : clean)).trim(), max);
}

/** The text of a Block Kit text object (`{type: 'mrkdwn' | 'plain_text', text}`). Plain text is not mrkdwn: it is escaped instead of converted. */
function textObject(t: unknown, max: number): string {
  if (!isObj(t)) return '';
  const text = t['text'];
  if (typeof text !== 'string') return '';
  return t['type'] === 'plain_text' ? inline(text, max) : cleanBody(text, true, max);
}

/** `[label](address)` for something that has an address, null when it has none that is safe. */
const linkTo = (label: unknown, url: unknown, fallbackLabel: string): string | null => {
  const safe = safeUrl(url);
  if (safe === null) return null;
  const text = inline(label, 200);
  return text === '' ? `[${fallbackLabel}](${safe})` : senderLink(typeof label === 'string' ? label : String(label ?? ''), text, safe);
};

/** An element beside a section or inside a context/actions block: an image or a button, as a link; null for anything else. */
function elementLink(el: unknown): string | null {
  if (!isObj(el)) return null;
  const type = str(el['type']);
  if (type === 'image') return linkTo(el['alt_text'], el['image_url'], 'image');
  if (type === 'button') return linkTo(isObj(el['text']) ? el['text']['text'] : undefined, el['url'], 'link');
  return null;
}

export interface ReadBlocks {
  /** The Markdown, or null when no block gave anything. */
  text: string | null;
  /** How many blocks were left out: of a kind this server does not show, or with nothing in them it can show, or past the limit. */
  skipped: number;
}

/** The Block Kit subset as Markdown, with the number of blocks that were skipped. Never throws. */
export function blocksToMarkdown(blocks: unknown): ReadBlocks {
  if (!Array.isArray(blocks)) return { text: null, skipped: 0 };
  const out: string[] = [];
  let skipped = Math.max(0, blocks.length - MAX_BLOCKS);
  for (const b of blocks.slice(0, MAX_BLOCKS)) {
    const piece = blockToMarkdown(b);
    if (piece === null) skipped += 1;
    else out.push(piece);
  }
  const text = compose(out);
  return { text: text === '' ? null : text, skipped };
}

function blockToMarkdown(b: unknown): string | null {
  if (!isObj(b)) return null;
  const type = str(b['type']);
  const parts: string[] = [];
  if (type === 'header') {
    const t = inline(isObj(b['text']) ? b['text']['text'] : '', LIMITS.title);
    return t === '' ? null : `**${t}**`;
  }
  if (type === 'section') {
    const t = textObject(b['text'], 3000);
    if (t !== '') parts.push(t);
    const fields = Array.isArray(b['fields'])
      ? b['fields'].slice(0, LIMITS.fields).map((f) => textObject(f, LIMITS.fieldValue).replace(/\s*\n\s*/g, ' ')).filter((x) => x !== '')
      : [];
    if (fields.length > 0) parts.push(fields.map((x) => `- ${x}`).join('\n'));
    const accessory = elementLink(b['accessory']);
    if (accessory !== null) parts.push(accessory);
    return parts.length === 0 ? null : compose(parts);
  }
  if (type === 'context') {
    const els = Array.isArray(b['elements']) ? b['elements'].slice(0, 10) : [];
    const words = els.map((e) => (isObj(e) && e['type'] !== 'image' ? textObject(e, 200).replace(/\s*\n\s*/g, ' ') : '')).filter((x) => x !== '');
    const links = els.map(elementLink).filter((x): x is string => x !== null);
    if (words.length > 0) parts.push(`_${words.join(' · ')}_`);
    if (links.length > 0) parts.push(links.join(' '));
    return parts.length === 0 ? null : compose(parts);
  }
  if (type === 'divider') return '---';
  if (type === 'image') {
    const title = isObj(b['title']) ? b['title']['text'] : undefined;
    return linkTo(title ?? b['alt_text'], b['image_url'], 'image');
  }
  if (type === 'actions') {
    // buttons are links only: a button that does something inside Slack has nowhere to go here, so it is not drawn
    const links = (Array.isArray(b['elements']) ? b['elements'].slice(0, 25) : []).map(elementLink).filter((x): x is string => x !== null);
    return links.length === 0 ? null : links.join(' · ');
  }
  return null;
}
