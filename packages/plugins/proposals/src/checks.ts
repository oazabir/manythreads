import { BOT_MD_CHECK, BOT_SLUG_RE, botSlugProblem, parseBotMd, type ProposalCheck } from '@manythreads/shared';

// The checks run on a proposal before it can be applied (PLAN P7-01). A bot's BOT.md is read by the same strict parser the loader uses, so a
// definition the loader would refuse cannot be applied, and the words shown are the loader's own.

/** `bots/<slug>/BOT.md` exactly (one folder deep), the shape the loader reads. */
const BOT_MD = /^bots\/([^/]+)\/BOT\.md$/;

export function runChecks(path: string, op: 'put' | 'delete', content: string | null): ProposalCheck[] {
  const m = BOT_MD.exec(path);
  if (!m || op === 'delete' || content === null) return [];
  const slug = m[1] as string;
  if (!BOT_SLUG_RE.test(slug)) return [{ name: BOT_MD_CHECK, ok: false, message: botSlugProblem(slug) }];
  const parsed = parseBotMd(content);
  if (!parsed.ok) {
    // `message` already names the field of each problem (the loader stores it as it is); `fieldPath` only points the bot page at the first one.
    return [{ name: BOT_MD_CHECK, ok: false, message: parsed.failure.message.slice(0, 1200) }];
  }
  return [{ name: BOT_MD_CHECK, ok: true, message: 'The definition parses; the loader will accept it.' }];
}

/** The words that say why a failed check blocks applying, or null when every check passed. */
export function failedChecks(checks: readonly ProposalCheck[]): string | null {
  const bad = checks.filter((c) => !c.ok);
  return bad.length === 0 ? null : bad.map((c) => `${c.name}: ${c.message}`).join(' ');
}
