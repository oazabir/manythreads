import { HttpError, type DeployOutcome, type DeployScope, type DeployStep, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import { failedChecks, runChecks } from './checks.ts';
import { createProposal } from './service.ts';

// The definition step of the bot page's Deploy action (PLAN P8-34): the bot's BOT.md is committed through the one way a change reaches `bots/`, a proposal applied by the person
// asking ("Propose and apply"), so the commit is theirs, the history keeps the proposal and the same checks run. Nothing new decides who may: the database's own rule for applying
// a proposal does, and a file someone else changed meanwhile is refused, never overwritten. A definition that is already what the repo holds is `unchanged`, not committed again.

const SAVEPOINT = 'deploy_definition';

async function currentFile(ctx: PluginContext, tx: PluginTx, teamId: string, path: string): Promise<{ text: string | null; blobSha: string | null }> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new HttpError(503, 'internal', 'The team repository is not available');
  try {
    const blob = await repo.blob(tx, teamId, path, 'HEAD');
    return { text: new TextDecoder().decode(blob.content), blobSha: blob.sha };
  } catch (err) {
    if ((err as { name?: string; status?: number }).name === 'RepoError' && (err as { status?: number }).status === 404) return { text: null, blobSha: null };
    throw err;
  }
}

export function createDefinitionStep(ctx: PluginContext): DeployStep {
  return {
    id: 'definition',

    async check(tx: PluginTx, scope: DeployScope): Promise<string | null> {
      if (scope.team.archived_at) return 'This team is archived, so its bots cannot be deployed.';
      const manage = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'manage') AS ok", [scope.team.id])).rows[0]?.ok === true;
      if (!manage) return 'Only a team lead or a workspace admin can deploy a bot.';
      const cur = await currentFile(ctx, tx, scope.team.id, scope.path);
      if (cur.blobSha === null) return `${scope.path} is not in the team repo, so there is nothing to deploy.`;
      if (scope.content === null || scope.content === cur.text) return null;
      if (scope.baseBlobSha !== undefined && scope.baseBlobSha !== cur.blobSha) return `${scope.path} changed while you were working. Reload it to see the new version; nothing was deployed.`;
      const failed = failedChecks(await runChecks(ctx, tx, scope.team.id, scope.path, 'put', scope.content));
      return failed === null ? null : `The definition does not pass its checks. ${failed}`;
    },

    async apply(tx: PluginTx, scope: DeployScope): Promise<DeployOutcome> {
      const cur = await currentFile(ctx, tx, scope.team.id, scope.path);
      if (cur.blobSha === null) return { state: 'refused', message: `${scope.path} is not in the team repo, so there is nothing to deploy.` };
      if (scope.content === null || scope.content === cur.text) return { state: 'unchanged', message: 'The definition in the team repo is already the one deployed.' };
      // a refusal inside the proposal (a check, a moved file, a right the database withholds) must leave no half-made proposal behind: the savepoint takes it back
      await tx.query(`SAVEPOINT ${SAVEPOINT}`);
      try {
        await createProposal(ctx, tx, scope.team, {
          path: scope.path,
          op: 'put',
          content: scope.content,
          baseBlobSha: scope.baseBlobSha === undefined ? cur.blobSha : scope.baseBlobSha,
          title: `Deploy ${scope.botSlug}`,
          applyNow: true,
        });
        await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return { state: 'changed', message: 'The definition is committed to the team repo, and the loader picks it up.' };
      } catch (err) {
        await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        if (err instanceof HttpError && err.status < 500) return { state: 'refused', message: err.message };
        throw err;
      }
    },
  };
}
