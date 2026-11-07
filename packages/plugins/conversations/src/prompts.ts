import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { DEFAULT_CONVERSATION_PROMPTS, botMdPath, parseBotMd, type ConversationPromptSource } from '@manythreads/shared';

// The chips of the empty state come from the bot's own definition (`conversation.prompts` of BOT.md, SPEC §6.2). The definition is a file of
// the team repo, so it is read from there, and only when it is the very file the roster row was loaded from (the same sha): a commit in flight
// is the loader's to settle, never a reason to show the person a question the bot's current definition does not carry. Anything that goes
// wrong (no repo plugin, an unreadable or invalid file, a newer commit) is the defaults, never an error: the chips are a courtesy.

export interface PromptSet {
  prompts: string[];
  source: ConversationPromptSource;
}

const defaults = (): PromptSet => ({ prompts: [...DEFAULT_CONVERSATION_PROMPTS], source: 'default' });

export async function promptsOf(
  ctx: PluginContext,
  tx: PluginTx,
  bot: { teamId: string; slug: string; definitionSha: string; scope?: string },
): Promise<PromptSet> {
  // the workspace Brain has no repo: its BOT.md is kept in app.workspace_bot_definitions (bots 0027), read at the sha the roster row was loaded from
  if (bot.scope === 'workspace') {
    const row = (
      await tx.query<{ content: string }>(
        'SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = app.workspace_id() AND slug = $1 AND sha = $2 ORDER BY version DESC LIMIT 1',
        [bot.slug, bot.definitionSha],
      )
    ).rows[0];
    const parsed = row ? parseBotMd(row.content) : null;
    const named = parsed?.ok ? (parsed.frontmatter.conversation?.prompts ?? []) : [];
    return named.length > 0 ? { prompts: [...named], source: 'definition' } : defaults();
  }
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return defaults();
  // a savepoint: a statement the repo provider runs that fails must not take the caller's transaction (the conversation it just opened) with it
  await tx.query('SAVEPOINT conversation_prompts');
  try {
    const file = await repo.blob(tx, bot.teamId, botMdPath(bot.slug), 'main');
    await tx.query('RELEASE SAVEPOINT conversation_prompts');
    if (createHash('sha256').update(file.content).digest('hex') !== bot.definitionSha) return defaults();
    const parsed = parseBotMd(Buffer.from(file.content).toString('utf8'));
    if (!parsed.ok) return defaults();
    const named = parsed.frontmatter.conversation?.prompts ?? [];
    return named.length > 0 ? { prompts: [...named], source: 'definition' } : defaults();
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT conversation_prompts');
    await tx.query('RELEASE SAVEPOINT conversation_prompts');
    return defaults();
  }
}
