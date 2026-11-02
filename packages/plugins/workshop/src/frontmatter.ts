import { parseBotMd, splitBotMd } from '@manythreads/shared';
import { Document, Scalar, parse as parseYaml } from 'yaml';

// Front-matter text a helper wrote must say what the helper meant (found live on P7-04: `role: Reads new posts in #dev and replies` is YAML for "Reads new posts in" followed by a comment, and
// the file still "loaded"). Two defences, both in code and neither asking the model:
//  1. the name and the role of a new bot are RENDERED from the structured fields of the tool call, as quoted strings, so no character in them can mean anything to YAML;
//  2. every free-text line of the block (name, role, description, title, summary) is read back, and a line that parses to something other than what is written on it is refused with the reason.

/** The lines of the block whose value is a sentence somebody wrote, not a word from a fixed list. */
const FREE_TEXT_KEYS = new Set(['name', 'role', 'description', 'title', 'summary']);
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

// a line break the eye cannot see, or a control character (a tab is fine inside a sentence)
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const HIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/;

export const ROLE_MAX_CHARS = 200;

/** What is wrong with a name or a role as a single line of text, or null. */
export function oneLineProblem(label: 'name' | 'role', value: string, max: number): string | null {
  const text = value.trim();
  if (text === '') return `The ${label} is empty.`;
  if (CONTROL.test(text)) return `The ${label} must be one line of plain text (no line breaks or control characters).`;
  if (text.length > max) return `The ${label} is longer than ${String(max)} characters.`;
  return null;
}

/** Lines of the block that read differently than they are written. One plain sentence each, naming the line; empty when all is well. */
export function frontmatterScalarProblems(botMd: string): string[] {
  const split = splitBotMd(botMd);
  if (!split.ok) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatter, { maxAliasCount: 20 });
  } catch {
    return []; // the loader's own check reports a block that does not parse
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const doc = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const lines = split.frontmatter.split('\n');
  for (const [at, line] of lines.entries()) {
    // `role:` with the text on the lines below it is one sentence spread over several lines
    const bare = /^([A-Za-z_][\w-]*):[ \t]*$/.exec(line);
    if (bare && FREE_TEXT_KEYS.has(bare[1] as string) && /^[ \t]+\S/.test(lines[at + 1] ?? '')) {
      problems.push(`The line "${bare[1] as string}:" has its text on the lines below it. Write it as one line, in double quotes.`);
      continue;
    }
    // [^\n] and not `.`: a dot does not match U+2028 or U+2029, and a line that held one would be skipped unread
    const m = /^([A-Za-z_][\w-]*):[ \t]+(\S[^\n]*?)[ \t]*$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const written = m[2] as string;
    if (!FREE_TEXT_KEYS.has(key)) continue;
    const value = doc[key];
    const quoted = /^["']/.test(written);
    if (/^[>|][+-]?\d?[ \t]*(#.*)?$/.test(written)) {
      // a block scalar (`role: >` or `role: |`) puts the text on the lines below and folds or keeps their line breaks: the stored text is not what a reader sees on this line
      problems.push(`The line "${key}:" is a block of text (${written.slice(0, 3)}) with its text on the lines below, which YAML folds or keeps in ways that are easy to get wrong. Write it as one line, in double quotes.`);
    } else if (HIDDEN.test(written) || (typeof value === 'string' && HIDDEN.test(value))) {
      problems.push(`The line "${key}:" holds a hidden line break or control character (such as U+2028 or U+2029). Retype it as plain text on one line, in double quotes.`);
    } else if (typeof value !== 'string') {
      problems.push(`The line "${key}:" does not read as text (YAML reads it as ${value === null ? 'empty' : typeof value}). Put it in double quotes.`);
    } else if (!quoted && value !== written) {
      const why = / #/.test(written) ? 'a # starts a comment in YAML, so everything after it is dropped' : 'YAML reads it differently from how it is written';
      problems.push(`The line "${key}:" would be stored as "${value.slice(0, 80)}", not as written: ${why}. Put the whole text in double quotes.`);
    } else if (quoted && value.trim() === '') {
      problems.push(`The line "${key}:" is empty.`);
    }
  }
  return problems;
}

export type Rendered = { ok: true; botMd: string } | { ok: false; message: string };

/**
 * Sets `name` (and `role`, when given) of the block to the given text, written as quoted strings by the YAML library, and gives the rest of the file back as it was. Then reads the result back
 * through the same parser the bot loader uses and refuses when the stored name or role is not exactly the text given.
 */
export function renderBotMd(botMd: string, fields: { name: string; role?: string | undefined }): Rendered {
  const nameProblem = oneLineProblem('name', fields.name, 80);
  if (nameProblem !== null) return { ok: false, message: nameProblem };
  if (fields.role !== undefined) {
    const roleProblem = oneLineProblem('role', fields.role, ROLE_MAX_CHARS);
    if (roleProblem !== null) return { ok: false, message: roleProblem };
  }
  const split = splitBotMd(botMd);
  if (!split.ok) return { ok: false, message: `BOT.md does not load: ${split.failure.message}` };
  // The name and role lines of the model's text are dropped (with the indented lines that continue them) and written fresh from the given fields; the rest of the block stays as written.
  const drop = new Set(['name', ...(fields.role !== undefined ? ['role'] : [])]);
  const kept: string[] = [];
  let skipping = false;
  for (const line of split.frontmatter.split('\n')) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    if (key !== undefined) skipping = drop.has(key);
    else if (skipping && !/^[ \t]/.test(line) && line.trim() !== '') skipping = false;
    if (!skipping) kept.push(line);
  }
  const quoted = (value: string): Scalar => {
    const s = new Scalar(value);
    s.type = 'QUOTE_DOUBLE';
    return s;
  };
  const head = new Document({});
  head.set('name', quoted(fields.name.trim()));
  if (fields.role !== undefined) head.set('role', quoted(fields.role.trim()));
  const rest = kept.join('\n').replace(/^\n+|\n+$/g, '');
  const out = `---\n${head.toString({ lineWidth: 0 }).replace(/\n+$/, '')}\n${rest === '' ? '' : `${rest}\n`}---\n${split.body}`;
  const back = parseBotMd(out);
  if (!back.ok) return { ok: false, message: `BOT.md does not load: ${back.failure.message.slice(0, 600)}` };
  if (back.frontmatter.name !== fields.name.trim() || (fields.role !== undefined && back.frontmatter.role !== fields.role.trim())) {
    return { ok: false, message: 'The name or the role would not be stored exactly as given. Use plain words without special marks and send it again.' };
  }
  return { ok: true, botMd: out };
}
