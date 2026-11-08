// Pages of Notion and Confluence as markdown (PLAN Bundle D, P16-08, decision D13). Both are plain functions over strings and plain JSON; neither builds a tree of the
// page, and both read their input once from the front, so a hostile page costs time in proportion to its length (no pattern here can backtrack over the whole text).
// What comes out is outside text, which the knowledge reader treats as data.

const MAX_OUT = 10 * 1024 * 1024;

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---- Notion --------------------------------------------------------------------------------------------------------------------------------------------------

/** A Notion block as the API returns it, with the children read for it (`children`) when it has any. */
export interface NotionBlock {
  type?: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

/** The text of a Notion rich-text list, with bold, italic, code, strike-through and links as markdown. */
export function notionRichText(list: unknown): string {
  let out = '';
  for (const item of arr(list)) {
    const r = rec(item);
    let t = text(r['plain_text']);
    if (t === '') continue;
    const a = rec(r['annotations']);
    // markers go round the words, not round the spaces at the ends of a run
    const lead = /^\s*/.exec(t)![0];
    const trail = t.length > lead.length ? /\s*$/.exec(t)![0] : '';
    let core = t.slice(lead.length, t.length - trail.length);
    if (core === '') {
      out += t;
      continue;
    }
    if (a['code'] === true) core = `\`${core.replaceAll('`', "'")}\``;
    if (a['bold'] === true) core = `**${core}**`;
    if (a['italic'] === true) core = `*${core}*`;
    if (a['strikethrough'] === true) core = `~~${core}~~`;
    const href = text(r['href']);
    if (href !== '' && /^https?:\/\//i.test(href)) core = `[${core}](${href})`;
    t = `${lead}${core}${trail}`;
    out += t;
  }
  return out;
}

const plainOf = (block: NotionBlock): string => notionRichText(rec(block[block.type ?? ''])['rich_text']);

/** The blocks of a Notion page as markdown. `title` becomes the first heading. Nesting is shown by indentation of list items; depth is bounded by the caller. */
export function notionToMarkdown(title: string, blocks: readonly NotionBlock[]): string {
  const lines: string[] = [];
  if (title.trim() !== '') lines.push(`# ${title.trim()}`, '');
  let size = 0;
  const push = (line: string): void => {
    if (size > MAX_OUT) return;
    size += line.length + 1;
    lines.push(line);
  };
  const walk = (list: readonly NotionBlock[], depth: number): void => {
    let number = 0;
    for (const block of list) {
      const type = block.type ?? '';
      const pad = '  '.repeat(depth);
      const t = plainOf(block);
      number = type === 'numbered_list_item' ? number + 1 : 0;
      switch (type) {
        case 'heading_1':
          push(`# ${t}`);
          push('');
          break;
        case 'heading_2':
          push(`## ${t}`);
          push('');
          break;
        case 'heading_3':
          push(`### ${t}`);
          push('');
          break;
        case 'paragraph':
          if (t !== '') {
            push(`${pad}${t}`);
            push('');
          }
          break;
        case 'bulleted_list_item':
          push(`${pad}- ${t}`);
          break;
        case 'numbered_list_item':
          push(`${pad}${String(number)}. ${t}`);
          break;
        case 'to_do':
          push(`${pad}- [${rec(block['to_do'])['checked'] === true ? 'x' : ' '}] ${t}`);
          break;
        case 'toggle':
          push(`${pad}- ${t}`);
          break;
        case 'quote':
        case 'callout':
          push(`> ${t}`);
          push('');
          break;
        case 'code': {
          const language = text(rec(block['code'])['language']).replace(/[^a-z0-9+#-]/gi, '');
          push(`\`\`\`${language === 'plain text' ? '' : language}`);
          push(arr(rec(block['code'])['rich_text']).map((x) => text(rec(x)['plain_text'])).join(''));
          push('```');
          push('');
          break;
        }
        case 'divider':
          push('---');
          push('');
          break;
        case 'bookmark':
        case 'link_preview':
        case 'embed': {
          const url = text(rec(block[type])['url']);
          if (/^https?:\/\//i.test(url)) {
            push(url);
            push('');
          }
          break;
        }
        case 'image':
        case 'file':
        case 'pdf':
        case 'video': {
          const caption = notionRichText(rec(block[type])['caption']);
          if (caption !== '') {
            push(`(${type}: ${caption})`);
            push('');
          }
          break;
        }
        case 'equation':
          push(`$$${text(rec(block['equation'])['expression'])}$$`);
          push('');
          break;
        case 'child_page':
          push(`## ${text(rec(block['child_page'])['title'])}`);
          push('');
          break;
        case 'table': {
          const rows = (block.children ?? []).filter((c) => c.type === 'table_row');
          rows.forEach((row, i) => {
            const cells = arr(rec(row['table_row'])['cells']).map((c) => notionRichText(c).replaceAll('|', '\\|').replace(/\s+/g, ' '));
            push(`| ${cells.join(' | ')} |`);
            if (i === 0) push(`| ${cells.map(() => '---').join(' | ')} |`);
          });
          push('');
          continue;
        }
        default:
          if (t !== '') {
            push(`${pad}${t}`);
            push('');
          }
      }
      if (block.children && block.children.length > 0) walk(block.children, depth + (type.endsWith('_list_item') || type === 'toggle' || type === 'to_do' ? 1 : 0));
    }
  };
  walk(blocks, 0);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---- Confluence storage format ------------------------------------------------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/** `&amp;`, `&#39;` and `&#x27;` decoded, in one pass over the text. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    // the end of an entity is within a few characters; looking further would make a run of `&` quadratic
    let semi = -1;
    for (let j = amp + 1; j < s.length && j <= amp + 10; j++) {
      if (s[j] === ';') {
        semi = j;
        break;
      }
    }
    if (semi === -1) {
      out += '&';
      i = amp + 1;
      continue;
    }
    const name = s.slice(amp + 1, semi);
    let decoded: string | undefined;
    if (name.startsWith('#x') || name.startsWith('#X')) decoded = codePoint(Number.parseInt(name.slice(2), 16));
    else if (name.startsWith('#')) decoded = codePoint(Number.parseInt(name.slice(1), 10));
    else decoded = ENTITIES[name];
    if (decoded === undefined) {
      out += '&';
      i = amp + 1;
    } else {
      out += decoded;
      i = semi + 1;
    }
  }
  return out;
}
function codePoint(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
  return String.fromCodePoint(n);
}

interface Tag {
  name: string;
  close: boolean;
  selfClose: boolean;
  attrs: Record<string, string>;
}

const MAX_TAG = 4096;

/**
 * Reads the tag between `s[from] === '<'` and the `>` at `gt` (the first `>` after it, found by the caller once per scan so a run of `<` without a `>` stays linear).
 * Null when the `<` is only text: the name is missing or the tag is longer than any real one.
 */
function readTag(s: string, from: number, gt: number): Tag | null {
  if (gt - from > MAX_TAG) return null;
  const inner = s.slice(from + 1, gt);
  let i = 0;
  const close = inner[0] === '/';
  if (close) i++;
  const nameStart = i;
  while (i < inner.length && /[A-Za-z0-9:_-]/.test(inner[i]!)) i++;
  if (i === nameStart) return null;
  const name = inner.slice(nameStart, i).toLowerCase();
  const attrs: Record<string, string> = {};
  let count = 0;
  const selfClose = inner.endsWith('/');
  while (i < inner.length) {
    while (i < inner.length && /[\s/]/.test(inner[i]!)) i++;
    if (i >= inner.length) break;
    const keyStart = i;
    while (i < inner.length && !/[\s=/]/.test(inner[i]!)) i++;
    const key = inner.slice(keyStart, i).toLowerCase();
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    let value = '';
    if (inner[i] === '=') {
      i++;
      while (i < inner.length && /\s/.test(inner[i]!)) i++;
      const quote = inner[i];
      if (quote === '"' || quote === "'") {
        const endQuote = inner.indexOf(quote, i + 1);
        value = inner.slice(i + 1, endQuote === -1 ? inner.length : endQuote);
        i = endQuote === -1 ? inner.length : endQuote + 1;
      } else {
        const valueStart = i;
        while (i < inner.length && !/\s/.test(inner[i]!)) i++;
        value = inner.slice(valueStart, i);
      }
    }
    if (key !== '' && count < 20) {
      attrs[key] = decodeEntities(value);
      count++;
    }
  }
  return { name, close, selfClose, attrs };
}

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tr', 'hr', 'ac:task', 'ac:task-list']);

/**
 * A Confluence page in storage format (XHTML with `ac:` macros) as markdown: headings, paragraphs, lists (nested), bold, italic, code and code macros, links,
 * block quotes and tables. Macros it does not know contribute their text body; an image or a status lozenge contributes nothing or its title. One pass, an explicit stack.
 */
export function confluenceStorageToMarkdown(title: string, storage: string): string {
  let out = title.trim() !== '' ? `# ${title.trim()}\n\n` : '';
  const lists: Array<{ ordered: boolean; n: number }> = [];
  const links: string[] = [];
  let heading = 0;
  let inPre = false;
  let codeMacro = false;
  let quote = 0;
  let table: { rows: string[][]; row: string[] | null; cell: string | null } | null = null;
  let skip = 0;
  const skipTags = new Set(['style', 'script', 'ac:parameter', 'ac:placeholder', 'ac:task-id', 'ac:task-status']);

  const write = (t: string): void => {
    if (out.length > MAX_OUT) return;
    if (table?.cell !== null && table !== null) table.cell += t;
    else out += t;
  };
  const newline = (): void => {
    if (table?.cell !== null && table !== null) {
      if (!table.cell.endsWith(' ')) table.cell += ' ';
      return;
    }
    if (!out.endsWith('\n')) out += '\n';
  };
  const blank = (): void => {
    if (table?.cell !== null && table !== null) return newline();
    newline();
    if (!out.endsWith('\n\n')) out += '\n';
  };
  const prefix = (): string => (quote > 0 ? '> '.repeat(quote) : '');

  let i = 0;
  let gt = -1;
  const s = storage;
  while (i < s.length && out.length <= MAX_OUT) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      if (skip === 0) write(textRun(s.slice(i), inPre || codeMacro));
      break;
    }
    if (lt > i && skip === 0) write(textRun(s.slice(i, lt), inPre || codeMacro));
    if (s.startsWith('<!--', lt)) {
      const endComment = s.indexOf('-->', lt + 4);
      i = endComment === -1 ? s.length : endComment + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const endCdata = s.indexOf(']]>', lt + 9);
      const body = s.slice(lt + 9, endCdata === -1 ? s.length : endCdata);
      if (skip === 0) write(body);
      i = endCdata === -1 ? s.length : endCdata + 3;
      continue;
    }
    if (gt < lt) {
      gt = s.indexOf('>', lt);
      if (gt === -1) gt = s.length + 1;
    }
    const tag = gt > s.length ? null : readTag(s, lt, gt);
    if (!tag) {
      if (skip === 0) write('<');
      i = lt + 1;
      continue;
    }
    i = gt + 1;
    const name = tag.name;
    if (skipTags.has(name)) {
      if (!tag.selfClose) skip += tag.close ? -1 : 1;
      if (skip < 0) skip = 0;
      continue;
    }
    if (skip > 0) continue;

    if (!tag.close) {
      if (/^h[1-6]$/.test(name)) {
        blank();
        heading = Number(name[1]);
        write(`${'#'.repeat(heading)} `);
      } else if (name === 'p' || name === 'div') {
        if (lists.length === 0 && table === null) blank();
      } else if (name === 'br') newline();
      else if (name === 'hr') {
        blank();
        write('---');
        blank();
      } else if (name === 'ul' || name === 'ol') {
        if (lists.length === 0) blank();
        lists.push({ ordered: name === 'ol', n: 0 });
      } else if (name === 'li') {
        newline();
        const list = lists[lists.length - 1];
        if (list) {
          list.n++;
          write(`${prefix()}${'  '.repeat(Math.max(0, lists.length - 1))}${list.ordered ? `${String(list.n)}. ` : '- '}`);
        }
      } else if (name === 'strong' || name === 'b') write('**');
      else if (name === 'em' || name === 'i') write('*');
      else if (name === 'code') write(inPre ? '' : '`');
      else if (name === 'pre') {
        blank();
        write('```\n');
        inPre = true;
      } else if (name === 'blockquote') {
        blank();
        quote++;
        write(prefix());
      } else if (name === 'a') {
        const href = tag.attrs['href'] ?? '';
        links.push(/^https?:\/\//i.test(href) ? href : '');
        write(links[links.length - 1] ? '[' : '');
      } else if (name === 'table') {
        blank();
        table = { rows: [], row: null, cell: null };
      } else if (name === 'tr' && table) table.row = [];
      else if ((name === 'td' || name === 'th') && table) table.cell = '';
      else if (name === 'ac:structured-macro') {
        const macro = tag.attrs['ac:name'] ?? '';
        if (macro === 'code' || macro === 'noformat') {
          blank();
          write('```\n');
          codeMacro = true;
        } else if (macro === 'info' || macro === 'note' || macro === 'warning' || macro === 'tip') {
          blank();
          quote++;
          write(prefix());
        }
      } else if (name === 'ac:task') write(`\n${prefix()}- [ ] `);
      else if (name === 'ac:task-status') {
        /* the status word itself is read as text and dropped below */
      } else if (name === 'ri:page' && tag.attrs['ri:content-title']) write(`[${tag.attrs['ri:content-title']}]`);
      else if (name === 'ri:user') write('@someone');
      else if (name === 'time' && tag.attrs['datetime']) write(tag.attrs['datetime']);
      else if (name === 'ac:emoticon' && tag.attrs['ac:emoji-fallback']) write(tag.attrs['ac:emoji-fallback']);
      if (tag.selfClose && name === 'hr') continue;
    } else {
      if (/^h[1-6]$/.test(name)) {
        heading = 0;
        blank();
      } else if (name === 'p' || name === 'div') {
        if (lists.length === 0 && table === null) blank();
      } else if (name === 'ul' || name === 'ol') {
        lists.pop();
        if (lists.length === 0) blank();
      } else if (name === 'li') newline();
      else if (name === 'strong' || name === 'b') write('**');
      else if (name === 'em' || name === 'i') write('*');
      else if (name === 'code') write(inPre ? '' : '`');
      else if (name === 'pre') {
        inPre = false;
        newline();
        write('```');
        blank();
      } else if (name === 'blockquote') {
        quote = Math.max(0, quote - 1);
        blank();
      } else if (name === 'a') {
        const href = links.pop() ?? '';
        if (href !== '') write(`](${href})`);
      } else if ((name === 'td' || name === 'th') && table?.cell !== null && table !== null) {
        table.row?.push(table.cell.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|'));
        table.cell = null;
      } else if (name === 'tr' && table?.row) {
        table.rows.push(table.row);
        table.row = null;
      } else if (name === 'table' && table) {
        const rows = table.rows;
        table = null;
        rows.forEach((cells, n) => {
          out += `| ${cells.join(' | ')} |\n`;
          if (n === 0) out += `| ${cells.map(() => '---').join(' | ')} |\n`;
        });
        out += '\n';
      } else if (name === 'ac:structured-macro') {
        if (codeMacro) {
          codeMacro = false;
          newline();
          write('```');
          blank();
        } else if (quote > 0) {
          quote = Math.max(0, quote - 1);
          blank();
        }
      } else if (name === 'ac:task') newline();
    }
    if (BLOCKS.has(name) && tag.selfClose) newline();
  }
  return `${out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()}\n`;
}

/** A run of text between tags: entities decoded, runs of white space folded (but not inside code). */
function textRun(raw: string, keepSpace: boolean): string {
  const decoded = decodeEntities(raw);
  return keepSpace ? decoded : decoded.replace(/\s+/g, ' ');
}
