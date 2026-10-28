// What counts as a file name or path inside prose, in one place: the chat draws such a token as inline code, and the server wraps one in backticks
// when a bot forgot to. Pure and linear: one sticky match of bounded length at a position, no backtracking across the text (see test/text-paths.test.ts).

/** Folders a repository path may start with; a path under one of them is a path even when its last part has no extension. */
const ROOTS = new Set([
  'bots', 'packages', 'clients', 'docs', 'e2e', 'deploy', 'tools', 'templates', 'src', 'test', 'tests', 'memory', 'pages', 'channels', 'people', 'node_modules',
  'api', 'apps', 'scripts', 'public', 'dist', 'build', '.github',
]);
/** Extensions that make a bare name (no slash) a file: `TEAM.md`, `package.json`. A short list on purpose, so `e.g.` and `kahf.to` stay prose. */
const FILE_EXT = new Set([
  'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh', 'css', 'html', 'txt', 'csv', 'lock', 'py', 'go', 'rs', 'xml', 'env',
  'conf', 'cfg', 'ini', 'svg', 'png', 'jpg', 'pdf', 'log', 'diff', 'patch',
]);

const TOKEN = /(?:\.{1,2}\/|~\/|\/)?\.?[A-Za-z0-9_@][A-Za-z0-9_.@+-]{0,100}(?:\/[A-Za-z0-9_.@+:-]{1,100}){0,12}/y;
const BEFORE = /[\w/.:@#~<-]/;

/**
 * The length of the file name or path that starts at `at` in `text`, or 0 when there is none there. A token needs a clear start (not in the middle of a word,
 * an address or a handle) and one of: a slash with an extension on its last part, a slash under a known folder, a leading `./` `../` `~/` or `/` with a second
 * part, or a bare name with a known extension. Trailing `.` `,` `;` `:` `!` `?` `)` belong to the sentence and are left out.
 */
export function pathTokenLength(text: string, at: number): number {
  if (at > 0 && BEFORE.test(text[at - 1] ?? '')) return 0;
  TOKEN.lastIndex = at;
  const m = TOKEN.exec(text);
  if (!m) return 0;
  let token = m[0];
  while (token.length > 0 && '.,;:!?)'.includes(token[token.length - 1] ?? '')) token = token.slice(0, -1);
  if (token === '') return 0;
  // a web address is not a path: the part after `://` is read by the link rules
  if (text.startsWith('://', at + token.length)) return 0;
  const parts = token.split('/');
  const last = parts[parts.length - 1] ?? '';
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,7})$/.exec(last)?.[1]?.toLowerCase() ?? '';
  const hasSlash = parts.length > 1;
  if (!hasSlash) return FILE_EXT.has(ext) && last.length > ext.length + 1 ? token.length : 0;
  const numeric = parts.every((p) => /^\d+$/.test(p) || p === '');
  if (numeric) return 0;
  const leading = token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || token.startsWith('/');
  const first = (leading ? parts.find((p) => p !== '' && p !== '.' && p !== '..' && p !== '~') : parts[0]) ?? '';
  if (leading) {
    const named = parts.filter((p) => p !== '' && p !== '.' && p !== '..' && p !== '~');
    // `./run.sh` and `~/notes` are paths at one part; a bare `/word` (a closing tag, a slash command) needs a second part, an extension or a known folder
    const relative = !token.startsWith('/');
    return named.length >= 1 && (relative || named.length >= 2 || ext !== '' || ROOTS.has(first)) ? token.length : 0;
  }
  return ext !== '' || ROOTS.has(first) ? token.length : 0;
}

/**
 * Wraps each bare file name or path of `text` in backticks. Text that is already code (an inline span or a fenced block), a link target and a web
 * address are left as written. Also closes a fence the text opened and never closed. `counts` says what was changed, so a bot that keeps slipping shows.
 */
export function repairBotMarkdown(text: string): { text: string; paths: number; fences: number } {
  let paths = 0;
  let open: string | null = null; // the marker of the fence we are inside
  const lines = text.split('\n').map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence?.[1]) {
      if (open === null) open = fence[1];
      else if (fence[1][0] === open[0] && fence[1].length >= open.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) open = null;
      return line;
    }
    if (open !== null) return line;
    // inline code and link targets stay as they are; only the prose between them is read
    const keep = /`[^`\n]*`|\]\([^)\n]*\)|<[^>\n]*>|https?:\/\/[^\s<>`)]+/g;
    let out = '';
    let from = 0;
    const prose = (s: string): string => {
      let r = '';
      let i = 0;
      while (i < s.length) {
        const len = pathTokenLength(s, i);
        if (len > 0) {
          r += `\`${s.slice(i, i + len)}\``;
          paths += 1;
          i += len;
          continue;
        }
        // skip to the next place a token could start, so a long word is scanned once
        const next = /[\s([{"'=,;]/.exec(s.slice(i));
        const step = next ? next.index + 1 : s.length - i;
        r += s.slice(i, i + Math.max(1, step));
        i += Math.max(1, step);
      }
      return r;
    };
    for (const m of line.matchAll(keep)) {
      out += prose(line.slice(from, m.index)) + m[0];
      from = (m.index ?? 0) + m[0].length;
    }
    return out + prose(line.slice(from));
  });
  let fences = 0;
  if (open !== null) {
    lines.push(open);
    fences = 1;
  }
  return { text: lines.join('\n'), paths, fences };
}
