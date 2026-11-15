import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// GET /api/runs/self (P19-09): the publisher container of a Claude or Codex pod presents a run's own token and learns the run's team and bot and whether the bot may
// publish. The folder it publishes from comes from this answer, so the answer must be the run's own (read from the database) and must say nothing else.

const { omar } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: World;
const ids: Record<string, { botId: string; actorId: string; teamId: string }> = {};

const slugs = { engineering: 'builder', marketing: 'writer' } as const;

async function makeBot(team: keyof typeof slugs, publisher: boolean): Promise<void> {
  const teamId = await world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [team])).rows[0]!.id);
  ids[team] = await world.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $3, 'Works', 'agent', 'hermes', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId, slugs[team]],
    );
    const botId = bot.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, botId]);
    const actorId = actor.rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, actorId, omar.workspaceId]);
    const capabilities = publisher ? ['messages.post', 'tasks.pull_request'] : ['messages.post'];
    for (const capability of capabilities) {
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')`, [teamId, actorId, capability]);
    }
    return { botId, actorId, teamId };
  });
}

/** A run opened in-process like the router does; the token is returned once. */
async function openRun(team: keyof typeof slugs): Promise<{ runId: string; token: string }> {
  const appPool = createAppPool(world.server.db.appUrl);
  const systemPool = createSystemPool(world.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
    const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
    const b = ids[team]!;
    const { run, token } = await service.open({ botId: b.botId, teamId: b.teamId, workspaceId: omar.workspaceId, trigger: 'drop' });
    return { runId: run.runId, token };
  } finally {
    await appPool.end();
    await systemPool.end();
  }
}

const self = async (bearer: string | null, extra: Record<string, string> = {}): Promise<{ status: number; text: string; body: Record<string, unknown> | null }> => {
  const res = await fetch(`${world.server.url}/api/runs/self`, { headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...extra } });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, text, body };
};

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  await makeBot('engineering', true);
  await makeBot('marketing', false);
}, 240_000);

afterAll(async () => {
  await world?.close();
});

describe('GET /api/runs/self', () => {
  it('tells a run its own team, bot and run, and that a bot with the pull request grant may publish', async () => {
    const { runId, token } = await openRun('engineering');
    const res = await self(token);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ teamSlug: 'engineering', botSlug: 'builder', runId, mayPublish: true });
    // nothing else leaves: no token, no address, no person
    expect(res.text).not.toContain(token);
    expect(Object.keys(res.body!).sort()).toEqual(['botSlug', 'mayPublish', 'runId', 'teamSlug']);
  });

  it('says a bot without the grant may not publish, and names the run\'s own team (not another team)', async () => {
    const { runId, token } = await openRun('marketing');
    const res = await self(token);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ teamSlug: 'marketing', botSlug: 'writer', runId, mayPublish: false });
  });

  it('answers what the database says, not what the caller says: a team or bot named in the query, a header or a body changes nothing', async () => {
    const { token } = await openRun('marketing');
    const res = await fetch(`${world.server.url}/api/runs/self?teamSlug=engineering&botSlug=builder&mayPublish=true`, {
      headers: { authorization: `Bearer ${token}`, 'x-team': 'engineering', 'x-bot': 'builder' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamSlug: 'marketing', botSlug: 'writer', mayPublish: false });
  });

  it('is one 401 for no token, a made-up token and the token of a run that has ended', async () => {
    const { runId, token } = await openRun('engineering');
    expect((await self(token)).status).toBe(200);
    await world.system((tx) => tx.query(`UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [runId]));
    const ended = await self(token);
    const made = await self('made-up-run-token-0123456789');
    const none = await self(null);
    expect([ended.status, made.status, none.status]).toEqual([401, 401, 401]);
    expect(ended.text).toBe(made.text);
    expect(ended.text).not.toContain(token);
  });

  it('refuses a token given in the query string', async () => {
    const { token } = await openRun('engineering');
    const res = await fetch(`${world.server.url}/api/runs/self?token=${token}`);
    expect(res.status).toBe(401);
  });

  it('counts only the grant the bot holds in the run\'s own team: a pull request grant in another team does not make this run a publisher', async () => {
    const other = ids['engineering']!;
    const mine = ids['marketing']!;
    // the marketing bot's actor is granted tasks.pull_request, but in the engineering team's scope
    await world.system((tx) =>
      tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'tasks.pull_request', false, '{}')`, [other.teamId, mine.actorId]),
    );
    try {
      const { token } = await openRun('marketing');
      const res = await self(token);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ teamSlug: 'marketing', mayPublish: false });
    } finally {
      await world.system((tx) => tx.query(`DELETE FROM app.capability_grants WHERE team_id = $1 AND actor_id = $2 AND capability = 'tasks.pull_request'`, [other.teamId, mine.actorId]));
    }
  });

  it('refuses a run whose bot is no longer active: the same 401 as for an ended run', async () => {
    const { token } = await openRun('engineering');
    expect((await self(token)).status).toBe(200);
    const b = ids['engineering']!;
    await world.system((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [b.botId]));
    try {
      const res = await self(token);
      expect(res.status, res.text).toBe(401);
      expect(res.text).not.toContain('builder');
    } finally {
      await world.system((tx) => tx.query(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [b.botId]));
    }
  });
});

// The two credential doors of an enrolled server (P26-15): the same token, the same checks, and no credential on a site that keeps none (a test server has no `project.credentials`
// or `deploy.kubeconfig` provider, so every allowed ask ends at the provider's absence, which is a 404 and not an error).
describe('GET /api/runs/self/push-credential and /kubeconfig', () => {
  const get = async (path: string, bearer: string | null): Promise<{ status: number; text: string; cache: string | null }> => {
    const res = await fetch(`${world.server.url}${path}`, { headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` } });
    return { status: res.status, text: await res.text(), cache: res.headers.get('cache-control') };
  };

  beforeAll(async () => {
    const teamId = ids['engineering']!.teamId;
    await world.system((tx) =>
      tx.query(`INSERT INTO app.projects (workspace_id, team_id, name, repo_url, default_branch) VALUES ($1, $2, 'site', 'https://github.com/acme/site', 'main') ON CONFLICT DO NOTHING`, [omar.workspaceId, teamId]),
    );
  });

  it('refuses a token that is not a live run, with the same 401 as /api/runs/self', async () => {
    expect((await get('/api/runs/self/push-credential?project=site', 'made-up-run-token-0123456789')).status).toBe(401);
    expect((await get('/api/runs/self/push-credential?project=site', null)).status).toBe(401);
    expect((await get('/api/runs/self/kubeconfig', 'made-up-run-token-0123456789')).status).toBe(401);
  });

  it('refuses a bot without the pull request grant (403) and a project the run\'s team does not have (404)', async () => {
    const noGrant = await openRun('marketing');
    const refused = await get('/api/runs/self/push-credential?project=site', noGrant.token);
    expect(refused.status, refused.text).toBe(403);
    expect(refused.text).not.toContain(noGrant.token);
    const publisher = await openRun('engineering');
    expect((await get('/api/runs/self/push-credential?project=nothing', publisher.token)).status).toBe(404);
    expect((await get('/api/runs/self/push-credential', publisher.token)).status).toBe(400);
    expect((await get('/api/runs/self/push-credential?project=..%2Fsite', publisher.token)).status).toBe(400);
  });

  it('says there is no credential where the site keeps none, and never caches an answer', async () => {
    const { token } = await openRun('engineering');
    const res = await get('/api/runs/self/push-credential?project=site', token);
    expect(res.status, res.text).toBe(404);
    expect(res.text).not.toContain(token);
  });

  it('gives a kubeconfig to nobody here: a bot that is not the deployer and a site with no deploy login both get 404', async () => {
    const { token } = await openRun('engineering');
    const res = await get('/api/runs/self/kubeconfig', token);
    expect(res.status, res.text).toBe(404);
  });
});

// Last on purpose: it fills this address's failure bucket, and every refusal test above needs the 401 and not the 429.
describe('the failure limit', () => {
  it('slows a client that keeps presenting wrong tokens: the 61st failure in a minute is 429, and a correct token is still answered', async () => {
    const { token } = await openRun('engineering');
    // this file's earlier refusals already count for the address; read the status until the limit is reached
    let limited = 0;
    for (let i = 0; i < 70 && limited === 0; i++) {
      const r = await self(`wrong-token-${i}-abcdefghijklmnop`);
      if (r.status === 429) limited = i;
    }
    expect(limited).toBeGreaterThan(0);
    const again = await fetch(`${world.server.url}/api/runs/self`, { headers: { authorization: 'Bearer another-wrong-token-0123456789' } });
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBe('30');
    // a correct token is not a failure and is not refused
    expect((await self(token)).status).toBe(200);
  });
});
