import type { DeployOutcome, DeployScope, DeployStep, PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { maxExtractBytes } from './extract/index.ts';
import { BASE_SELECT, repoFolderOf, type BaseRow } from './rows.ts';
import { resyncBase } from './sync.ts';

// The knowledge step of the bot page's Deploy action (PLAN P8-34): "activate the base" is this plugin's own re-sync, the act the Knowledge tab's Re-sync button does (read the base's
// repo folder again, import what is new, drop what is gone, retry what failed) followed by a look at the base's own state. There is no "activated" flag: a base is ready when
// `knowledge_bases.status` says `ready`, and the step is refused when it cannot get there (a base that does not exist, one with nothing to read, one with a document that fails).

const quoted = (slug: string): string => `“${slug}”`;
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

async function baseOf(tx: PluginTx, teamId: string, slug: string): Promise<BaseRow | undefined> {
  return (await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.team_id = $1 AND b.slug = $2`, [teamId, slug])).rows[0];
}

export function createKnowledgeDeployStep(ctx: PluginContext): DeployStep {
  return {
    id: 'knowledge',

    async check(tx: PluginTx, scope: DeployScope): Promise<string | null> {
      if (scope.bases.length === 0) return null;
      const manage = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'manage') AS ok", [scope.team.id])).rows[0]?.ok === true;
      if (!manage) return 'Only a team lead or a workspace admin can make a knowledge base ready.';
      if (scope.team.archived_at) return 'This team is archived, so its knowledge cannot be changed.';
      const repo = ctx.providers.get<RepoProvider>('repo');
      for (const slug of scope.bases) {
        const base = await baseOf(tx, scope.team.id, slug);
        if (!base) return `This team has no knowledge base called ${quoted(slug)}. Make it on the bot's Knowledge tab, or take it out of the definition.`;
        if (base.status !== 'empty') continue;
        // an empty base is not hopeless: files put in its repo folder are imported by the re-sync. With none, there is nothing to make ready.
        let files = 0;
        if (repo) files = (await repo.list(tx, scope.team.id, repoFolderOf(slug)).catch(() => [])).filter((e) => e.kind === 'file').length;
        if (files === 0) return `The knowledge base ${quoted(slug)} has no documents yet. Upload some on the bot's Knowledge tab.`;
      }
      return null;
    },

    async apply(tx: PluginTx, scope: DeployScope): Promise<DeployOutcome> {
      if (scope.bases.length === 0) return { state: 'not_used', message: 'This bot lists no knowledge base, so there is nothing to make ready.' };
      let changed = false;
      const lines: string[] = [];
      const refusals: string[] = [];
      for (const slug of scope.bases) {
        const before = await baseOf(tx, scope.team.id, slug);
        if (!before) {
          refusals.push(`This team has no knowledge base called ${quoted(slug)}.`);
          continue;
        }
        const result = await resyncBase(ctx, tx, { id: before.id, teamId: scope.team.id, workspaceId: scope.team.workspace_id, slug }, maxExtractBytes());
        const after = (await baseOf(tx, scope.team.id, slug)) ?? before;
        if (after.status === 'ready') {
          const moved = result.added + result.updated + result.removed > 0 || before.status !== 'ready';
          changed = changed || moved;
          lines.push(`${quoted(slug)} is ready: ${plural(after.indexed_count, 'document', 'documents')} can be searched${moved ? '' : ' (nothing needed changing)'}.`);
        } else if (after.status === 'attention') {
          refusals.push(`${quoted(slug)} has ${plural(after.failed_count, 'document', 'documents')} that could not be read. Open the Knowledge tab to see why.`);
        } else {
          refusals.push(`${quoted(slug)} has no documents yet. Upload some on the Knowledge tab.`);
        }
      }
      if (refusals.length > 0) return { state: 'refused', message: [...refusals, ...lines].join(' ') };
      return { state: changed ? 'changed' : 'unchanged', message: lines.join(' ') };
    },
  };
}
