/*
 * YAML frontmatter of a page, read just far enough for the viewers: where it ends, which top-level keys it has, and the
 * `google:` block of a link-preview page. The text is never rewritten from the parse: the block is kept verbatim.
 */

export type SplitFrontmatter = { frontmatter: string; body: string };

/** `---\n...\n---\n` at the very start; the block (with its fences and trailing newline) and the rest. */
export function splitFrontmatter(text: string): SplitFrontmatter {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { frontmatter: '', body: text };
  let pos = open[0].length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
      const end = nl === -1 ? text.length : nl + 1;
      return { frontmatter: text.slice(0, end), body: text.slice(end) };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { frontmatter: '', body: text };
}

/** Top-level `key:` names of a frontmatter block. */
export function frontmatterKeys(frontmatter: string): string[] {
  const keys: string[] = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

const unquote = (v: string): string => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1);
  return t;
};

export type GoogleLink = { url: string; title: string | undefined; kind: string | undefined };

/** The `google:` block (`google:\n  url: ...\n  title: ...\n  kind: doc|sheet|slides`), or `google: <url>`. Null when it holds no https URL. */
export function parseGoogleLink(frontmatter: string): GoogleLink | null {
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((l) => /^google:(\s|$)/.test(l));
  if (at === -1) return null;
  const inline = unquote((lines[at] ?? '').slice('google:'.length));
  const fields: Record<string, string> = {};
  if (inline !== '') fields['url'] = inline;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^\S/.test(l)) break;
    const m = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(l);
    if (m?.[1]) fields[m[1]] = unquote(m[2] ?? '');
  }
  const url = fields['url'] ?? '';
  if (!/^https:\/\/[^\s]+$/.test(url)) return null;
  return { url, title: fields['title'] || undefined, kind: fields['kind'] || undefined };
}

/** Is the link on a Google host? Only those get the "Open in Google" card. */
export function isGoogleHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'google.com' || host.endsWith('.google.com');
  } catch {
    return false;
  }
}
