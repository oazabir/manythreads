import { botPlacementProblem, type BotRunnersProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { BOT_MD_CHECK, BOT_SLUG_RE, botSlugProblem, parseBotMd, type ProposalCheck } from '@manythreads/shared';

// The checks run on a proposal before it can be applied (PLAN P7-01). A bot's BOT.md is read by the same strict parser the loader uses, so a
// definition the loader would refuse cannot be applied, and the words shown are the loader's own. The runner the file names (`placement.runs_on`) is asked the loader's own question
// (`botPlacementProblem`), so a proposal that would load as invalid says so before it is applied.

/** `bots/<slug>/BOT.md` exactly (one folder deep), the shape the loader reads. */
const BOT_MD = /^bots\/([^/]+)\/BOT\.md$/;

export async function runChecks(ctx: PluginContext, tx: PluginTx, teamId: string, path: string, op: 'put' | 'delete', content: string | null): Promise<ProposalCheck[]> {
  const m = BOT_MD.exec(path);
  if (!m || op === 'delete' || content === null) return [];
  const slug = m[1] as string;
  if (!BOT_SLUG_RE.test(slug)) return [{ name: BOT_MD_CHECK, ok: false, message: botSlugProblem(slug) }];
  const parsed = parseBotMd(content);
  if (!parsed.ok) {
    // `message` already names the field of each problem (the loader stores it as it is); `fieldPath` only points the bot page at the first one.
    return [{ name: BOT_MD_CHECK, ok: false, message: parsed.failure.message.slice(0, 1200) }];
  }
  // The runner catalog is readable only by an admin's transaction, and the person applying may be a team lead, so the question is asked on a system transaction (read only, and only
  // when the file names a runner). It reads rows that were committed long ago, so it cannot wait on this transaction.
  const fm = parsed.frontmatter;
  const problem =
    fm.placement?.runs_on === undefined
      ? null
      : await ctx.db.system((sys) => botPlacementProblem(ctx.providers.get<BotRunnersProvider>('bot.runners'), sys, { teamId, frontmatter: fm }));
  if (problem !== null) return [{ name: BOT_MD_CHECK, ok: false, message: `placement.runs_on: ${problem}`.slice(0, 1200) }];
  return [{ name: BOT_MD_CHECK, ok: true, message: 'The definition parses; the loader will accept it.' }];
}

/** The words that say why a failed check blocks applying, or null when every check passed. */
export function failedChecks(checks: readonly ProposalCheck[]): string | null {
  const bad = checks.filter((c) => !c.ok);
  return bad.length === 0 ? null : bad.map((c) => `${c.name}: ${c.message}`).join(' ');
}
