import { ANSWER_MASKED_KIND, type AnswerPayload } from '../entities/answer.ts';

// "Save as page" (SPEC §6.4, PLAN P5-17): the masked copy of an answer as a markdown file under `pages/answers/`. Pure and linear: the title, the
// file name and the text are made here, the write is the pages plugin's (through the repo writer, which owns every path rule).

/** Where saved answers live. A page of the team: every reader of the repo may open it, which is why the text it holds is the masked copy. */
export const ANSWER_PAGES_DIR = 'pages/answers';

const TITLE_MAX = 80;
const SLUG_MAX = 48;

/**
 * A title for the page: the first sentence of the first line of the answer, without markdown marks and `[n]` markers, at most 80 characters;
 * "Saved answer" when it has none.
 */
export function pageTitle(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    let out = '';
    let i = 0;
    // leading marks of a heading, quote or list item
    while (i < line.length && (line[i] === '#' || line[i] === '>' || line[i] === '-' || line[i] === '*' || line[i] === '+' || line[i] === ' ')) i += 1;
    while (i < line.length && out.length < TITLE_MAX + 20) {
      const ch = line[i]!;
      if (ch === '[') {
        // a marker `[12]`: one to three digits and a bracket
        let j = i + 1;
        while (j < line.length && j - i <= 3 && line[j]! >= '0' && line[j]! <= '9') j += 1;
        if (j > i + 1 && line[j] === ']') {
          i = j + 1;
          continue;
        }
      }
      if (ch !== '*' && ch !== '_' && ch !== '`' && ch !== '#') out += ch;
      i += 1;
    }
    // one space between words, none before a stop that a marker left behind, and the first sentence only
    let title = out.replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
    for (let k = 0; k < title.length; k += 1) {
      const c = title[k]!;
      if ((c === '.' || c === '!' || c === '?' || c === '。' || c === '؟') && (k + 1 === title.length || title[k + 1] === ' ')) {
        title = title.slice(0, k).trim();
        break;
      }
    }
    if (title !== '') return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  }
  return 'Saved answer';
}

/** A file-name part from a title: lower-case ASCII letters and digits joined by single dashes, at most 48 characters; "answer" when none is left. */
export function pageSlug(title: string): string {
  let out = '';
  let dash = false;
  for (const ch of title.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (dash && out !== '') out += '-';
      dash = false;
      out += ch;
      if (out.length >= SLUG_MAX) break;
    } else {
      dash = true;
    }
  }
  return out === '' ? 'answer' : out;
}

/**
 * `pages/answers/<date>-<slug>-<8 hex of the answer's id>.md`. The last eight characters of a time-ordered id are its random part, so two answers
 * saved on one day under one title never meet, and saving the same answer twice names the same file (the second save finds it: it is the same
 * page). Only `a-z`, `0-9` and `-` ever reach the path; nothing in it comes from the answer but the slug.
 */
export function answerPagePath(date: string, title: string, messageId: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '1970-01-01';
  const tail = messageId.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-8).padStart(8, '0');
  return `${ANSWER_PAGES_DIR}/${day}-${pageSlug(title)}-${tail}.md`;
}

/** The kind of a source in words, for the page's source list. */
const NOUN: Record<string, string> = { message: 'message', thread: 'thread', page: 'page', file: 'file', run: 'run' };

/**
 * The page's markdown: a title, the text, the sources and who it was for. A masked source reads "from <name>'s <kind> · not shared", as it does in
 * the channel. Everything in it is in the copy, which is the answer made smaller: the page never says more than the share would have.
 */
export function answerPageMarkdown(copy: AnswerPayload, savedOn: string): string {
  const title = pageTitle(copy.body);
  const who = copy.answeredFor.name ?? 'the team';
  const lines: string[] = [`# ${title}`, '', copy.body.trim(), ''];
  if (copy.citations.length > 0) {
    lines.push('## Sources', '');
    const byN = new Map(copy.lineage.map((l) => [l.n, l] as const));
    for (const c of [...copy.citations].sort((a, b) => a.n - b.n)) {
      if (c.kind === ANSWER_MASKED_KIND) {
        lines.push(`${c.n}. from ${who}'s ${NOUN[c.source] ?? 'source'} · not shared`);
        continue;
      }
      const l = byN.get(c.n);
      const age = l?.at ? ` · ${l.at.slice(0, 10)}` : '';
      const snippet = l?.snippet ? ` — “${l.snippet.replace(/\s+/g, ' ')}”` : '';
      lines.push(`${c.n}. ${c.label} (${NOUN[c.kind] ?? 'source'})${age}${snippet}`);
    }
    lines.push('');
  }
  if (copy.outsideScope.count > 0) {
    lines.push(`${copy.outsideScope.count} more source${copy.outsideScope.count === 1 ? '' : 's'} could not be shown here.`, '');
  }
  const foot = [`Answered for ${who}`, copy.answeredFor.scope];
  if (copy.answeredFor.alias) foot.push(copy.answeredFor.alias);
  lines.push('---', '', `*${foot.join(' · ')}. Saved from a conversation on ${savedOn}.*`, '');
  return lines.join('\n');
}
