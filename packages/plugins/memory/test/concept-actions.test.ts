import {
  CapabilityBroker,
  CapabilityRegistry,
  createAppPool,
  createDbGrantSource,
  createRunService,
  createSystemPool,
} from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { GetRepoHistoryResponse, parseConcept, trustTier } from '@manythreads/shared';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { rebuildConcepts } from '../src/concepts.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// Confirm and Deprecate on the Concepts tab (P21-15), over HTTP as a person. A bot files an unverified concept; a person's Confirm then adds a
// `human:` verification (the writer's own stamp), a Deprecate sets `status: deprecated`, both are idempotent, a person outside the team gets 403 and the
// file is unchanged, and a path that is not a concept is refused. The concept index follows the commit.

const { omar, nadia, sameera } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
let systemPool: ReturnType<typeof createSystemPool>;
let appPool: ReturnType<typeof createAppPool>;
let runs: ReturnType<typeof createRunService>;
let handler: (input: Record<string, unknown>, tx: PluginTx) => unknown | Promise<unknown>;
let bot: { botId: string; actorId: string };

const openRun = (): Promise<{ run: BotRunHandle; token: string }> =>
  runs.open({ botId: bot.botId, teamId: ENG, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });

const write = async (run: BotRunHandle, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await runs.asBot(run, async (tx) => await handler(input, tx))) as Record<string, unknown>;

const blob = async (path: string): Promise<{ status: number; content: string | null }> => {
  const res = await w.call(nadia, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=main`);
  return { status: res.status, content: res.status === 200 ? (res.body as { content: string }).content : null };
};

const history = async (path: string) =>
  GetRepoHistoryResponse.parse(
    (await w.call(nadia, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}&limit=10`)).body,
  ).commits;

beforeAll(async () => {
  w = await createRepoWorld();
  handler = w.server.host.registries.capabilityHandlers.get('memory.write')!.handler;
  // A bot of the team that may write memory: an `app.bots` row (a run needs one), its actor, the membership and the grant.
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'mem-writer', 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [
      omar.workspaceId,
      botId,
    ]);
    const actorId = actor.rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actorId, omar.workspaceId]);
    await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'memory.write', false, '{}')", [
      ENG,
      actorId,
    ]);
    return { botId, actorId };
  });
  appPool = createAppPool(w.server.db.appUrl);
  systemPool = createSystemPool(w.server.db.systemUrl, 2);
  const registry = new CapabilityRegistry();
  runs = createRunService({
    pool: appPool,
    systemPool,
    registry,
    broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }),
    handlers: w.server.host.registries.capabilityHandlers,
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
});


const confirmPath = (path: string): string => `/api/teams/engineering/memory/concepts/${encodeURIComponent(path)}/confirm`;
const deprecatePath = (path: string): string => `/api/teams/engineering/memory/concepts/${encodeURIComponent(path)}/deprecate`;

const botConcept = async (path: string): Promise<void> => {
  const { run } = await openRun();
  const answer = await write(run, { path, type: 'fact', title: 'Cache TTL', body: 'Thirty seconds.\n' });
  expect(answer).toMatchObject({ ok: true, trustTier: 'unverified', committed: true });
};

const concept = async (path: string) => {
  const text = (await blob(path)).content ?? '';
  const parsed = parseConcept(text);
  if (!parsed.ok) throw new Error(`not a concept: ${parsed.reason}`);
  return parsed.frontmatter;
};

// The index follows a commit through the outbox, which this world does not run; the catch-up rebuild reads the same tree the commit event would.
const indexRow = async (path: string) =>
  w.system(async (tx) => {
    await rebuildConcepts(tx as unknown as PluginTx, ENG);
    return (await tx.query<{ trust_tier: string; status: string }>('SELECT trust_tier, status FROM app.memory_concepts WHERE team_id = $1 AND path = $2', [ENG, path])).rows[0];
  });

it('Confirm adds the person as a verifier: the concept goes from unverified to human-reviewed, in one commit by that person', async () => {
  const path = 'memory/facts/confirm-me.md';
  await botConcept(path);
  expect(trustTier(await concept(path))).toBe('unverified');

  const res = await w.call(nadia, 'POST', confirmPath(path));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const fm = await concept(path);
  expect(trustTier(fm)).toBe('human-reviewed');
  expect(fm.verified?.map((v) => v.by)).toEqual([`human:${nadia.actorId}`]);
  const commits = await history(path);
  expect(commits[0]).toMatchObject({ authorId: nadia.actorId, subject: `memory: confirm ${path}` });
  expect((await indexRow(path))?.trust_tier).toBe('human-reviewed');

  // again: nothing to do, no second verification and no second commit
  expect((await w.call(omar, 'POST', confirmPath(path))).status).toBe(200);
  expect((await concept(path)).verified).toHaveLength(1);
  expect((await history(path)).length).toBe(commits.length);
});

it('Deprecate sets the status and keeps the body; doing it twice changes nothing more', async () => {
  const path = 'memory/facts/deprecate-me.md';
  await botConcept(path);
  const res = await w.call(omar, 'POST', deprecatePath(path));
  expect(res.status, JSON.stringify(res.body)).toBe(200);

  const fm = await concept(path);
  expect(fm.status).toBe('deprecated');
  expect(fm.title).toBe('Cache TTL');
  expect((await blob(path)).content).toContain('Thirty seconds.');
  expect((await history(path))[0]).toMatchObject({ authorId: omar.actorId, subject: `memory: deprecate ${path}` });
  expect((await indexRow(path))?.status).toBe('deprecated');

  const commits = (await history(path)).length;
  expect((await w.call(omar, 'POST', deprecatePath(path))).status).toBe(200);
  expect((await history(path)).length).toBe(commits);
});

it('refuses a person outside the team (403), a path that is not a concept (400) and a concept that is not there (404), and writes nothing', async () => {
  const path = 'memory/facts/guarded.md';
  await botConcept(path);
  const before = (await blob(path)).content;
  const commits = (await history(path)).length;

  expect((await w.call(sameera, 'POST', confirmPath(path))).status).toBe(403);
  expect((await w.call(sameera, 'POST', deprecatePath(path))).status).toBe(403);
  expect((await blob(path)).content).toBe(before);
  expect((await history(path)).length).toBe(commits);

  expect((await w.call(omar, 'POST', confirmPath('memory/index.md'))).status).toBe(400);
  expect((await w.call(omar, 'POST', deprecatePath('pages/x.md'))).status).toBe(400);
  expect((await w.call(omar, 'POST', confirmPath('memory/facts/nowhere.md'))).status).toBe(404);
});
