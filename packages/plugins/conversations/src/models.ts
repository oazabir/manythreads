import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { botMdPath, modelAliasesOfDefinition, parseBotMd, type ChatModelOption } from '@manythreads/shared';

// The model menu of the Chat screen (PLAN P20-16): exactly the aliases the bot's own definition lists (`model.aliases` of BOT.md, the first one is the
// default), each marked with whether the workspace has a model behind it. A person never sees a model or a provider name, only Smart / Fast and a hint.
// The same list is the rule the send route checks a picked alias against (an alias outside it is refused with one plain sentence), so the menu and the
// check cannot drift apart.

const LABELS: Readonly<Record<string, { label: string; hint: string }>> = {
  smart: { label: 'Smart', hint: 'Slower and more careful' },
  fast: { label: 'Fast', hint: 'Quicker answers' },
  code: { label: 'Code', hint: 'Tuned for programming' },
  local: { label: 'Private', hint: 'Runs on this server' },
  vision: { label: 'Pictures', hint: 'Can look at images' },
};

const labelOf = (alias: string): { label: string; hint: string } => LABELS[alias] ?? { label: alias.slice(0, 1).toUpperCase() + alias.slice(1), hint: '' };

/** The aliases of the definition the roster row was loaded from, in order; null when that file cannot be read as the loaded one (the caller asks again later). */
export async function definitionAliases(ctx: PluginContext, tx: PluginTx, bot: { teamId: string; slug: string; definitionSha: string; scope?: string }): Promise<string[] | null> {
  // the workspace Brain has no repo: its BOT.md is kept in app.workspace_bot_definitions, read at the sha the roster row was loaded from (as prompts.ts does)
  if (bot.scope === 'workspace') {
    const row = (
      await tx.query<{ content: string }>(
        'SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = app.workspace_id() AND slug = $1 AND sha = $2 ORDER BY version DESC LIMIT 1',
        [bot.slug, bot.definitionSha],
      )
    ).rows[0];
    const parsed = row ? parseBotMd(row.content) : null;
    return parsed?.ok ? modelAliasesOfDefinition(parsed.frontmatter) : null;
  }
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return null;
  // a savepoint: a repo read that fails must not take the caller's transaction with it
  await tx.query('SAVEPOINT conversation_models');
  try {
    const file = await repo.blob(tx, bot.teamId, botMdPath(bot.slug), 'main');
    await tx.query('RELEASE SAVEPOINT conversation_models');
    if (createHash('sha256').update(file.content).digest('hex') !== bot.definitionSha) return null;
    const parsed = parseBotMd(Buffer.from(file.content).toString('utf8'));
    return parsed.ok ? modelAliasesOfDefinition(parsed.frontmatter) : null;
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT conversation_models');
    await tx.query('RELEASE SAVEPOINT conversation_models');
    return null;
  }
}

/** The aliases the workspace has bound to a model. The LLM page is the admin's, so a member's request reads it as the system role, scoped to their workspace. */
export async function boundAliases(ctx: PluginContext, workspaceId: string, aliases: readonly string[]): Promise<Set<string>> {
  if (aliases.length === 0) return new Set();
  return ctx.db.system(
    async (tx) => {
      const there = (await tx.query<{ t: string | null }>("SELECT to_regclass('app.llm_aliases')::text AS t")).rows[0]?.t;
      if (!there) return new Set<string>();
      const rows = await tx.query<{ alias: string }>('SELECT alias FROM app.llm_aliases WHERE workspace_id = $1::uuid AND alias = ANY ($2::text[])', [workspaceId, [...aliases]]);
      return new Set(rows.rows.map((r) => r.alias));
    },
    { workspaceId },
  );
}

/** The menu: every alias of the definition, the first as the default. */
export function menuOf(aliases: readonly string[], bound: ReadonlySet<string>): ChatModelOption[] {
  return aliases.map((alias, index) => {
    const known = bound.has(alias);
    return {
      alias,
      ...labelOf(alias),
      available: known,
      reason: known ? null : `${labelOf(alias).label} has no model yet. Ask an admin to set it up on the LLM page.`,
      isDefault: index === 0,
    };
  });
}
