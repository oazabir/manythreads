// Helpers every adapter uses to put text from OUTSIDE into a message safely (the Markdown rules of PLAN P14-19 and the platform's no-raw-HTML rule).
// Everything here is linear in the length of the text: single passes and bounded character classes, no nested quantifiers (hostile-input tests pin it).

/** Hard limits, so one call cannot fill a channel. */
export const LIMITS = { title: 200, line: 300, block: 1500, message: 8000, fieldName: 60, fieldValue: 300, fields: 12, items: 10 } as const;

const ZWSP = '\u200b';
/** Control characters except tab and newline (a payload cannot move the cursor, ring a bell or hide text). */
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
/** A tag-looking piece of raw HTML: `<`, a letter or `/`, then at most 300 characters that are not angle brackets, then `>`. */
const HTML_TAG = /<\/?[A-Za-z!][^<>]{0,300}>/g;

export function stripControl(s: string): string {
  return s.replace(CONTROL, '');
}

/**
 * An `@` that would name a person, a team or the channel becomes plain text: outside text must not ping anybody. A handle may start with any letter or
 * digit of any script (`@éric`, `@عمر`), as the mention parser reads it, so every one of them is broken, not only ASCII.
 */
export function defang(s: string): string {
  return s.replace(/@(?=[\p{L}\p{N}_])/gu, `@${ZWSP}`);
}

/** Raw HTML is removed (the chat never draws it); the text between the tags stays. */
export function stripHtml(s: string): string {
  return s.replace(HTML_TAG, '');
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  // do not cut a surrogate pair in half
  let end = max - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end).trimEnd()}…`;
}

/** Escapes what would turn a piece of text into Markdown structure when it sits inside a line (bold, link text, a list item). */
export function escapeInline(s: string): string {
  return s.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
}

/** One line of outside text: no control characters, no HTML, one line, no pings, no Markdown structure, at most `max` characters. */
export function inline(s: unknown, max: number = LIMITS.line): string {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  const flat = stripHtml(stripControl(String(s))).replace(/\s+/g, ' ').trim();
  return escapeInline(defang(clip(flat, max)));
}

/**
 * A block of outside text as a quote: every line starts with `> `, so it cannot open a heading, a list or a code fence of its own, and it ends
 * where the quote ends. At most `maxLines` lines and `max` characters.
 */
export function quote(s: unknown, max: number = LIMITS.block, maxLines = 12): string {
  if (typeof s !== 'string') return '';
  const clean = stripHtml(stripControl(s)).replace(/\r\n?/g, '\n').trim();
  if (clean === '') return '';
  const lines = clip(clean, max).split('\n').slice(0, maxLines);
  const out: string[] = [];
  let blank = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      if (!blank && out.length > 0) out.push('>');
      blank = true;
      continue;
    }
    blank = false;
    out.push(`> ${defang(line).replace(/`{3,}/g, (m) => m.split('').join(ZWSP))}`);
  }
  while (out.at(-1) === '>') out.pop();
  const cut = clean.length > max || clean.split('\n').length > maxLines;
  return out.join('\n') + (cut && !out.at(-1)?.endsWith('…') ? '\n> …' : '');
}

/** An http(s) address safe to put in a Markdown link, or null. No credentials in it, no spaces, brackets that would end the link are encoded. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length === 0 || u.length > 1000) return null;
  const t = u.trim();
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return null;
  let parsed: URL;
  try {
    parsed = new URL(t);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '') return null;
  return parsed.href.replace(/[()<>[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `host` of an address that passed `safeUrl`, for showing where a link goes. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A Markdown link whose label is already escaped text. */
export const link = (label: string, url: string | null): string => (url === null ? label : `[${label}](${url})`);

/** A link that also says where it goes: `[label](url) (host)`. For addresses a sender chose, where the label could say anything. */
export const linkWithHost = (label: string, url: string | null): string => (url === null ? label : `[${label}](${url}) (${escapeInline(hostOf(url))})`);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Joins non-empty parts with blank lines and cuts the whole to the message limit. */
export function compose(parts: ReadonlyArray<string | null | undefined | false>): string {
  const text = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
  return clip(text, LIMITS.message);
}

/** Wraps JSON text so it can never close its own fence. */
export function codeBlock(text: string, lang = ''): string {
  const body = text.replace(/`{3,}/g, (m) => m.split('').join(ZWSP));
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}
