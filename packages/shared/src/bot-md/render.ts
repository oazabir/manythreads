import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { BotFrontmatter, type BotFrontmatter as BotFrontmatterData } from './frontmatter.ts';

// BOT.md as both the loader and the editor read and write it (SPEC §7.1, PLAN P5-04/P5-05): the `---` frontmatter fence parsed
// strictly, the body after it being SOUL.md prose that is never parsed. One module owns the round trip, so a file the editor wrote
// is exactly a file the loader accepts — the red banner then only ever appears for a definition that arrived some other way.

/** Why a BOT.md would not load. `fieldPath` is what the schema named (`capabilities.native[3]`), null when the document as a whole failed. */
export interface BotMdFailure {
  fieldPath: string | null;
  message: string;
}

/**
 * A parsed BOT.md: the frontmatter and the body after it. The body is carried through because it *is* the definition's
 * behaviour — SPEC §7.1 makes it the runtime's `SOUL.md` — and the runtime (P5-10) reads it from here rather than
 * re-splitting the file it already parsed.
 */
export type BotMd = { ok: true; frontmatter: BotFrontmatterData; body: string } | { ok: false; failure: BotMdFailure };

/** The frontmatter as written, the prose after it, or why there is none of either. */
export type BotMdSplit =
  | { ok: true; frontmatter: string; body: string }
  | { ok: false; failure: BotMdFailure; body: string };

/** `['capabilities', 'native', 3]` → `capabilities.native[3]`; an empty path is no path. */
const formatPath = (path: readonly PropertyKey[]): string => {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
};

/** The path an issue names: an unknown key lives in `keys`, not in the issue's own path (zod v4). */
const issuePath = (issue: { path: readonly PropertyKey[]; code: string }): string => {
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as unknown as { keys: readonly PropertyKey[] }).keys;
    if (keys.length > 0) return formatPath([...issue.path, keys[0]!]);
  }
  return formatPath(issue.path);
};

/**
 * Split a BOT.md into its frontmatter and its body. Line-scanned, so a hostile file cannot trap the matcher; a byte-order mark is
 * stripped because it is invisible in an editor and would otherwise fail the fence check, and nothing else is lenient.
 */
export function splitBotMd(content: string): BotMdSplit {
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const fail = (message: string): BotMdSplit => ({ ok: false, failure: { fieldPath: null, message }, body: '' });
  if (lines[0] !== '---') return fail('BOT.md must open with a --- frontmatter block');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return fail('BOT.md frontmatter never closes with ---');
  return { ok: true, frontmatter: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/** The largest BOT.md the loader reads (UTF-16 code units, checked before anything is split or parsed): a soul file is prose, not a data dump. */
export const BOT_MD_MAX_CHARS = 256 * 1024;

/** Parse one BOT.md strictly; the returned failure is what the loader puts in `bots.bot.invalid` and the bot page shows. */
export function parseBotMd(content: string): BotMd {
  if (content.length > BOT_MD_MAX_CHARS) {
    return { ok: false, failure: { fieldPath: null, message: `BOT.md is larger than ${BOT_MD_MAX_CHARS / 1024} KB` } };
  }
  const split = splitBotMd(content);
  if (!split.ok) return { ok: false, failure: split.failure };
  let doc: unknown;
  try {
    doc = parseYaml(split.frontmatter, { maxAliasCount: 20 });
  } catch (err) {
    return { ok: false, failure: { fieldPath: null, message: `frontmatter: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const parsed = BotFrontmatter.safeParse(doc);
  if (parsed.success) return { ok: true, frontmatter: parsed.data, body: split.body };
  // Eight issues at most, one line each, capped: the banner is a line, not a transcript.
  const shown = parsed.error.issues.slice(0, 8);
  const lines = shown.map((issue) => {
    const path = issuePath(issue);
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const rest = parsed.error.issues.length - shown.length;
  const fieldPath = issuePath(shown[0]!);
  const message = `${lines.join('; ')}${rest > 0 ? ` (+${rest} more)` : ''}`.slice(0, 1000);
  return { ok: false, failure: { fieldPath: fieldPath === '' ? null : fieldPath, message } };
}

/** A key whose value is absent is left out of the file entirely (the schema's own optionality is the shape of the document). */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = withoutUndefined(v);
    }
    return out;
  }
  return value;
}

/**
 * The whole file: the fence, the frontmatter in the schema's own key order, and the body. Deterministic, so saving a definition the
 * editor did not change writes the same bytes and the commit is a no-op.
 */
export function renderBotMd(frontmatter: BotFrontmatterData, body: string): string {
  const yaml = stringifyYaml(withoutUndefined(frontmatter), { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
  return `---\n${yaml}---\n\n${body.replace(/^\s*\n+/, '').replace(/\s+$/, '')}\n`;
}