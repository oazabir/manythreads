import { BotFrontmatter, type BotFrontmatter as BotFrontmatterData } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';

// BOT.md as the loader reads it (SPEC §7.1, PLAN P5-04): the `---` frontmatter fence, parsed strictly — unknown or missing keys fail with
// the field path, exactly what the red banner on the bot page shows. The body after the fence is SOUL.md prose: never parsed here.

/** Why a BOT.md would not load. `fieldPath` is what the schema named (`capabilities.native[3]`), null when the document as a whole failed. */
export interface BotMdFailure {
  fieldPath: string | null;
  message: string;
}

export type BotMd = { ok: true; frontmatter: BotFrontmatterData } | { ok: false; failure: BotMdFailure };

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

/** The frontmatter between the fences, or why there is none. Line-scanned, so a hostile file cannot trap the matcher. */
const splitFrontmatter = (content: string): { yaml: string } | { failure: BotMdFailure } => {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[0] !== '---') return { failure: { fieldPath: null, message: 'BOT.md must open with a --- frontmatter block' } };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { failure: { fieldPath: null, message: 'BOT.md frontmatter never closes with ---' } };
  return { yaml: lines.slice(1, end).join('\n') };
};

/** Parse one BOT.md's frontmatter strictly; the returned failure is what the loader puts in `bots.bot.invalid`. */
export function parseBotMd(content: string): BotMd {
  // A byte-order mark is invisible in an editor and would fail the fence check; strip it, then nothing else is lenient.
  const split = splitFrontmatter(content.replace(/^\uFEFF/, ''));
  if ('failure' in split) return { ok: false, failure: split.failure };
  let doc: unknown;
  try {
    doc = parseYaml(split.yaml);
  } catch (err) {
    return { ok: false, failure: { fieldPath: null, message: `frontmatter: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const parsed = BotFrontmatter.safeParse(doc);
  if (parsed.success) return { ok: true, frontmatter: parsed.data };
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
