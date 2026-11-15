import { createHash } from 'node:crypto';
import type { PluginContext } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import type { CredentialTeam, DeployKubeconfigProvider, ProjectCredentialsProvider } from '@manythreads/sdk';
import { KubeconfigResponse, PushCredentialQuery, PushCredentialResponse, RunSelfResponse, addressKey, kubeconfigRoute, pushCredentialRoute, runSelfRoute } from '@manythreads/shared';
import { json, route, unauthenticated } from './http.ts';

// GET /api/runs/self (PLAN Bundle E, WP-R1, docs/plugins/claude-pods.md). The publisher container of a Claude or Codex pod presents the run's own token and
// learns which team and bot the run belongs to, and whether the bot's definition grants `tasks.pull_request`. The publisher takes the folder to publish from
// this answer and never from the caller's words. The answer holds no token, no address and no person: the run, the team and the bot, by their public names.
//
// The credential is the run token (`Authorization: Bearer <token>`), as at `/mcp`. A forged token, an expired one and the token of a run that has ended all answer
// the same 401, and failures count per client address like the `/mcp` route's (60 a minute, then 429).

const sha256 = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
const MAY_PUBLISH = 'tasks.pull_request';
const FAILURES_PER_ADDRESS_PER_MINUTE = 60;
const CALLS_PER_RUN_PER_MINUTE = 120;
const GONE = 'This run is not valid any more';

/** A sliding window of timestamps per key, in this process; pruned so a flood of distinct keys cannot grow it without bound. */
function windowed(limit: number): (key: string) => boolean {
  const seen = new Map<string, number[]>();
  return (key) => {
    const at = Date.now();
    const recent = (seen.get(key) ?? []).filter((t) => at - t < 60_000);
    recent.push(at);
    seen.set(key, recent);
    if (seen.size > 5000) for (const [k, times] of seen) if (times.every((t) => at - t >= 60_000)) seen.delete(k);
    return recent.length > limit;
  };
}

export function registerRunsSelfRoute(ctx: PluginContext): void {
  const tooManyFailures = windowed(FAILURES_PER_ADDRESS_PER_MINUTE);
  const tooManyCalls = windowed(CALLS_PER_RUN_PER_MINUTE);
  const rateLimited = (): Error => new HttpError(429, 'rate_limited', 'Too many requests; slow down', { 'retry-after': '30' });
  const refuse = (ip: string): Error => (tooManyFailures(addressKey(ip)) ? rateLimited() : unauthenticated(GONE));

  /** The run behind the request's bearer token, or the refusal to throw. Every failure is the same 401 (counted per address); a run may ask 120 times a minute over all three routes. */
  const runOf = async (req: { headers: Record<string, string | undefined>; ip: string }): Promise<NonNullable<Awaited<ReturnType<PluginContext['runs']['resolve']>>>> => {
    const match = /^Bearer[ \t]+([A-Za-z0-9_-]{1,200})[ \t]*$/.exec(req.headers['authorization'] ?? '');
    if (match === null) throw refuse(req.ip);
    const run = await ctx.runs.resolve(sha256(match[1]!));
    if (run === null) throw refuse(req.ip);
    if (tooManyCalls(run.runId)) throw rateLimited();
    return run;
  };

  ctx.http.route({
    ...runSelfRoute,
    public: true,
    schema: { response: RunSelfResponse },
    handler: route(async (req) => {
      const run = await runOf(req);
      // names, read from the database on every call: the run row says which bot and team, never the caller
      const found = await ctx.db.system(async (tx) => {
        const row = (
          await tx.query<{ team_slug: string; bot_slug: string; may_publish: boolean }>(
            `SELECT t.slug AS team_slug, b.slug AS bot_slug,
                    EXISTS (SELECT 1 FROM app.capability_grants g WHERE g.actor_id = $3::uuid AND g.team_id = $1::uuid AND g.capability = $4) AS may_publish
               FROM app.teams t, app.bots b
              WHERE t.id = $1::uuid AND b.id = $2::uuid AND b.status = 'active'`,
            [run.teamId, run.botId, run.botActorId, MAY_PUBLISH],
          )
        ).rows[0];
        return row ?? null;
      });
      if (found === null) throw refuse(req.ip);
      return json(RunSelfResponse.parse({ teamSlug: found.team_slug, botSlug: found.bot_slug, runId: run.runId, mayPublish: found.may_publish }));
    }),
  });

  // The push credential of one project of the run's team, for the publisher of an enrolled server (it has no Kubernetes Secret to read, as a pod's publisher has). The same checks as the pod
  // publisher's: the run is live, its bot is active and holds `tasks.pull_request`, and the project is one of the run's own team. The token comes from the `project.credentials` provider; it is
  // never logged, and the answer is never cached.
  ctx.http.route({
    ...pushCredentialRoute,
    public: true,
    schema: { query: PushCredentialQuery, response: PushCredentialResponse },
    handler: route(async (req) => {
      const run = await runOf(req);
      const { project } = PushCredentialQuery.parse(req.query);
      const found = await ctx.db.system(async (tx) => {
        const row = (
          await tx.query<{ team_slug: string; may_publish: boolean; project: string | null }>(
            `SELECT t.slug AS team_slug,
                    EXISTS (SELECT 1 FROM app.capability_grants g WHERE g.actor_id = $3::uuid AND g.team_id = $1::uuid AND g.capability = $4) AS may_publish,
                    (SELECT p.name FROM app.projects p WHERE p.team_id = $1::uuid AND p.name = $5) AS project
               FROM app.teams t, app.bots b
              WHERE t.id = $1::uuid AND b.id = $2::uuid AND b.status = 'active'`,
            [run.teamId, run.botId, run.botActorId, MAY_PUBLISH, project],
          )
        ).rows[0];
        return row ?? null;
      });
      if (found === null) throw refuse(req.ip);
      if (!found.may_publish) throw new HttpError(403, 'forbidden', 'This bot may not publish: its definition does not grant tasks.pull_request');
      if (found.project === null) throw new HttpError(404, 'not_found', 'This team has no such project');
      const provider = ctx.providers.get<ProjectCredentialsProvider>('project.credentials');
      if (!provider) throw new HttpError(404, 'not_found', 'No push credential is kept on this site');
      const team: CredentialTeam = { id: run.teamId, slug: found.team_slug };
      const credential = await provider.read(team, project).catch(() => null);
      if (credential === null) throw new HttpError(404, 'not_found', 'This project has no push credential');
      return {
        status: 200,
        headers: { 'cache-control': 'no-store' },
        body: PushCredentialResponse.parse({
          project,
          origin: credential.origin,
          branch: credential.branch,
          token: credential.token,
          ...(credential.identity ? { provider: credential.identity.provider, login: credential.identity.login, userId: credential.identity.userId, commitAs: credential.identity.commitAs } : {}),
          ...(credential.refused === true ? { refused: true } : {}),
        }),
      };
    }),
  });

  // The deployer's kubeconfig for a machine outside the cluster (the host variant: its API address is the host's), only for the team's deployer bot (the same slug rule as the pods).
  // Any other bot, and a team with no deploy target, gets the same 404.
  ctx.http.route({
    ...kubeconfigRoute,
    public: true,
    schema: { response: KubeconfigResponse },
    handler: route(async (req) => {
      const run = await runOf(req);
      const found = await ctx.db.system(async (tx) => {
        const row = (
          await tx.query<{ team_slug: string; bot_slug: string }>(
            `SELECT t.slug AS team_slug, b.slug AS bot_slug FROM app.teams t, app.bots b WHERE t.id = $1::uuid AND b.id = $2::uuid AND b.status = 'active'`,
            [run.teamId, run.botId],
          )
        ).rows[0];
        return row ?? null;
      });
      if (found === null) throw refuse(req.ip);
      const deployer = (process.env['MANYTHREADS_CLAUDE_PODS_DEPLOYER_BOT'] ?? process.env['MANYTHREADS_HERMES_PODS_DEPLOYER_BOT'] ?? 'deployer').trim();
      const none = new HttpError(404, 'not_found', 'There is no deploy login for this bot');
      if (deployer === '' || found.bot_slug !== deployer) throw none;
      const provider = ctx.providers.get<DeployKubeconfigProvider>('deploy.kubeconfig');
      if (!provider) throw none;
      const texts = await provider.texts({ team: { id: run.teamId, slug: found.team_slug } }).catch(() => null);
      if (texts === null || texts.host === null || texts.host === '') throw none;
      return { status: 200, headers: { 'cache-control': 'no-store' }, body: KubeconfigResponse.parse({ kubeconfig: texts.host }) };
    }),
  });
}
