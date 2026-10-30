import { definePlugin } from '@manythreads/sdk';
import { HttpError, requireTeam } from '@manythreads/sdk';
import { CreateProposalRequest } from '@manythreads/shared';
import { registerProposalRoutes } from './routes.ts';
import { createProposal } from './service.ts';

export { runChecks, failedChecks } from './checks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * proposals: the one way a change reaches `bots/`, `TEAM.md`, `skills/` and `routines/` (PLAN P7-01, SPEC 7.2 and principle 5). Someone proposes one file's new
 * text; checks run on it (a bot's BOT.md through the loader's own parser); a team lead or workspace admin applies it and the commit is theirs. A bot can
 * only propose, through `proposals.propose`. docs/plugins/proposals.md.
 */
export default definePlugin({
  manifest: {
    name: 'proposals',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    // `proposals.propose` is what a bot is granted to propose a change; it never commits (the repo writer refuses a bot these four places outright).
    capabilities: [{ name: 'proposals.propose', destructive: false }],
    events: { emits: ['proposals.proposal.created', 'proposals.proposal.applied', 'proposals.proposal.rejected'], consumes: [] },
    // teams: app.teams and team membership; bots: the bot's name and actor; repo-git provides the writer this plugin commits through.
    dependsOn: ['teams', 'bots', 'repo-git'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerProposalRoutes(ctx);
    // What the MCP gateway calls for a bot's `proposals.propose` tool: `{ team, path, op?, content?, title?, note? }` as the bot's transaction. The proposal is
    // based on the file as it is now. Answers `{ ok: true, proposal }` or `{ ok: false, status, code, message }`.
    ctx.capabilities.register('proposals.propose', async (input, tx) => {
      const { team, ...rest } = input as { team?: unknown } & Record<string, unknown>;
      if (typeof team !== 'string' || team === '') return { ok: false, status: 400, code: 'validation_failed', message: 'team: the team slug or id is needed' };
      const parsed = CreateProposalRequest.safeParse(rest);
      if (!parsed.success) return { ok: false, status: 400, code: 'validation_failed', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      if (parsed.data.applyNow === true) return { ok: false, status: 403, code: 'forbidden', message: 'A bot can only propose. A lead or admin applies it.' };
      try {
        let slug = team;
        if (UUID.test(team)) {
          const row = (await tx.query<{ slug: string }>('SELECT slug FROM app.teams WHERE id = $1::uuid', [team])).rows[0];
          if (!row) return { ok: false, status: 404, code: 'not_found', message: 'No such team' };
          slug = row.slug;
        }
        const t = await requireTeam(tx, slug);
        const detail = await createProposal(ctx, tx, t, parsed.data);
        return { ok: true, proposal: { id: detail.proposal.id, path: detail.proposal.path, status: detail.proposal.status, checks: detail.proposal.checks } };
      } catch (err) {
        if (err instanceof HttpError) return { ok: false, status: err.status, code: err.code, message: err.message };
        throw err;
      }
    });
  },
});
