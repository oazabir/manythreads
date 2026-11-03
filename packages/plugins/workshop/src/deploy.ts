import { HttpError, DEPLOY_STEPS, invalid, json, notFound, requireManage, requireTeam, route, type DeployOutcome, type DeployScope, type DeployStep, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import { BotDeployPathParams, BotDeployRequest, BotDeployResponse, deployBotRoute, parseBotMd, type BotDeployOutcome } from '@manythreads/shared';
import { botOf } from './wroutes.ts';

// The bot page's Deploy action (PLAN P8-34, docs/plans/support-email-journey.md D2). One request that does what three plugins own and reports each of the three: the definition is
// committed through the proposals plugin (the one way a change reaches `bots/`), the knowledge bases it lists are made ready by the knowledge plugin, and the connections it uses are
// switched on by the connections plugin. The workshop plugin only composes them: each owner registers its step as a `deploy.step` provider and this file looks them up when it runs.
//
// Nothing here is a lifecycle state. The bot's liveness stays the loader's `bots.status`, a base's `knowledge_bases.status`, a connection's `connections.status`; a deploy that changed
// nothing says so (`deployed: false`) and is not counted as one.
//
// Order: every step's `check` runs first, and none of them writes. If one refuses, nothing is changed and the others are reported `not_run`. If all pass, the steps run in the order
// definition, knowledge, connection, and the first refusal that was not foreseen stops the rest (`not_run`); what already ran was done as its owner does it and the report says so.

const DEPLOY_LIMIT = { limit: 10, windowMs: 60_000 } as const;

const STEP_LABEL = { definition: 'The definition', knowledge: 'The knowledge', connection: 'The connection' } as const;

/** The short names a definition uses: its knowledge bases and the connections it names (a `person:*` entry is the asking person's own and is not a team connection). */
export function usesOf(content: string): { bases: string[]; connections: string[] } | { problem: string } {
  const parsed = parseBotMd(content);
  if (!parsed.ok) return { problem: `The definition does not load: ${parsed.failure.message}` };
  const fm = parsed.frontmatter;
  const bases = [...new Set((fm.knowledge ?? []).map((k) => k.base))];
  const names = new Set<string>();
  for (const c of fm.capabilities?.connections ?? []) if (c.name !== 'person:*') names.add(c.name);
  for (const t of fm.triggers ?? []) if (t.type === 'inbox' && t.connection !== undefined) names.add(t.connection);
  return { bases, connections: [...names] };
}

async function repoText(ctx: PluginContext, tx: PluginTx, teamId: string, path: string): Promise<string | null> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new HttpError(503, 'internal', 'The team repository is not available');
  try {
    return new TextDecoder().decode((await repo.blob(tx, teamId, path, 'HEAD')).content);
  } catch (err) {
    if ((err as { name?: string; status?: number }).name === 'RepoError' && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}

const refusedSummary = (what: string): string => `Not deployed. ${what}`;

export function registerDeployRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: deployBotRoute.method,
    path: deployBotRoute.path,
    rateLimit: DEPLOY_LIMIT,
    schema: { body: BotDeployRequest, response: BotDeployResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotDeployPathParams.parse(req.params);
      const body = BotDeployRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      await botOf(tx, team, botSlug);

      const path = `bots/${botSlug}/BOT.md`;
      const text = body.content ?? (await repoText(ctx, tx, team.id, path));
      if (text === null) throw notFound(`${path} is not in the team repo, so there is nothing to deploy`);
      const uses = usesOf(text);
      if ('problem' in uses) throw invalid(uses.problem);

      const scope: DeployScope = {
        team,
        botSlug,
        path,
        content: body.content ?? null,
        baseBlobSha: body.baseBlobSha,
        bases: uses.bases,
        connections: uses.connections,
      };

      const steps = DEPLOY_STEPS.map((name) => ({ name, step: ctx.providers.get<DeployStep>('deploy.step', name) }));
      const missing = steps.find((s) => !s.step);
      if (missing) throw new HttpError(503, 'internal', `${STEP_LABEL[missing.name]} step is not available on this server`);

      const outcomes: BotDeployOutcome[] = [];
      const respond = (deployed: boolean, summary: string): ReturnType<typeof json> => json(BotDeployResponse.parse({ deployed, summary, outcomes }));

      // 1. foresee: every check, no write
      const reasons = new Map<string, string>();
      for (const { name, step } of steps) {
        const reason = await (step as DeployStep).check(tx, scope);
        if (reason !== null) reasons.set(name, reason);
      }
      if (reasons.size > 0) {
        for (const name of DEPLOY_STEPS) {
          const reason = reasons.get(name);
          outcomes.push(reason === undefined ? { step: name, state: 'not_run', message: 'Not attempted, because a part that has to come first could not be done. Nothing was changed.' } : { step: name, state: 'refused', message: reason });
        }
        const first = DEPLOY_STEPS.find((n) => reasons.has(n)) as (typeof DEPLOY_STEPS)[number];
        return respond(false, refusedSummary(`${STEP_LABEL[first]} cannot be done yet, so nothing was changed.`));
      }

      // 2. do, in order; a refusal that could not be foreseen stops the rest
      let anyChanged = false;
      let stopped: (typeof DEPLOY_STEPS)[number] | null = null;
      for (const { name, step } of steps) {
        if (stopped !== null) {
          outcomes.push({ step: name, state: 'not_run', message: 'Not attempted, because an earlier part was refused.' });
          continue;
        }
        const outcome: DeployOutcome = await (step as DeployStep).apply(tx, scope);
        outcomes.push({ step: name, state: outcome.state, message: outcome.message });
        if (outcome.state === 'refused') stopped = name;
        if (outcome.state === 'changed') anyChanged = true;
      }
      if (stopped !== null) {
        const done = outcomes.filter((o) => o.state === 'changed').length;
        return respond(false, refusedSummary(`${STEP_LABEL[stopped]} was refused.${done > 0 ? ' What was done before it stays done.' : ' Nothing was changed.'}`));
      }
      return respond(anyChanged, anyChanged ? 'Deployed.' : 'Nothing to deploy: the definition, the knowledge and the connection are already as this bot needs them.');
    }),
  });
}
