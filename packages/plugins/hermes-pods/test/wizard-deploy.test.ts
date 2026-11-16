/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import type { HermesProfilesProvider } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { configFrom } from '../src/config.ts';
import { Reconciler, type ProfileSource } from '../src/reconcile.ts';
import { FakeK8s } from './fake-k8s.ts';

// Review of Phases 27 and 28: the setup wizard's "Deploy a Hermes pod" action, end to end below the screen. The screen makes the runner (POST /api/admin/bot-runners), then
// makes it the place bots run (PUT .../default), and the controller then makes the pod's objects; the checklist accepts the runner only after a bot has answered a real
// question. The cluster is the in-memory Kubernetes stand-in of the controller tests; the list of teams that need a pod comes from the real `hermes.profiles` provider.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let world: World;
let teamId = '';
const SHA = 'a'.repeat(64);

const provider = (): HermesProfilesProvider => world.server.host.registries.providers['hermes.profiles'].list()[0]!.value as HermesProfilesProvider;
const mark = (refId: string) => world.call<any>(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId });

/** What the Test action leaves when a bot answered the admin's real question (as in the onboarding route tests). */
async function leaveTestAnswer(): Promise<void> {
  await ensureChannels(world);
  const dev = await world.channelId('engineering', 'dev');
  const q = await world.call<{ id: string }>(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'Say hello', threadRootId: null });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  expect((await world.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'Hello', threadRootId: q.body.id })).status).toBe(201);
  await world.system(async (tx) => {
    const bot = (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'wizard-pod-bot'`)).rows[0]!.id;
    await tx.query('INSERT INTO app.rehearsal_questions (message_id, workspace_id, team_id, bot_id, asked_by) VALUES ($1, $2, $3, $4, $5)', [q.body.id, omar.workspaceId, teamId, bot, omar.actorId]);
    await tx.query(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, rehearsal, reply_root_id, ended_at) VALUES ($1, $2, $3, 'conversation', $4, 'done', true, $5, now())`,
      [omar.workspaceId, bot, teamId, omar.actorId, q.body.id],
    );
  });
}

beforeAll(async () => {
  world = await createWorld();
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`)).rows[0]!.id);
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe('the wizard\'s Deploy a Hermes pod action', () => {
  it('makes the runner and the pod objects, and the checklist takes the runner only after a bot has answered', async () => {
    // the screen's calls, in its order (deployPod, then proveRunner): make the runner (for every team: a runner with no team is used by none, and no pod would be made), then make it the place bots run
    const made = await world.call<any>(omar, 'POST', '/api/admin/bot-runners', { name: 'hermes', label: 'Hermes pod', kind: 'hermes_pod', teams: { all: true } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.runner).toMatchObject({ name: 'hermes', kind: 'hermes_pod', enabled: true });
    const runnerId: string = made.body.runner.id;
    const asDefault = await world.call<any>(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId });
    expect(asDefault.status, JSON.stringify(asDefault.body)).toBe(200);

    // before any pod or bot: the controller has no team to serve and the cluster holds nothing
    const k8s = new FakeK8s();
    // the team list is the real provider's answer; the bot's profile files need a bot repository, and runtime-hermes' own tests cover them, so the pod is made with none
    const source: ProfileSource = { profilesForTeam: async () => [] };
    const warnings: string[] = [];
    const reconciler = new Reconciler(k8s, configFrom({}), source, { info: () => undefined, warn: (m) => warnings.push(m) });
    expect(await provider().teamsWithPodBots()).toEqual([]);

    // a bot with no place of its own follows the default runner: the team now has a bot for the pod, and the controller makes the pod's objects
    await world.system((tx) =>
      tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'wizard-pod-bot', 'agent', 'hermes', 'team', $3, 'active')`,
        [omar.workspaceId, teamId, SHA],
      ),
    );
    const teams = await provider().teamsWithPodBots();
    expect(teams.map((t) => t.slug)).toEqual(['engineering']);
    const results = await reconciler.reconcileAll(teams);
    expect(results, warnings.join('; ')).toHaveLength(1);
    const kinds = new Set([...k8s.store.values()].map((o) => o.kind));
    for (const kind of ['Deployment', 'PersistentVolumeClaim', 'Secret', 'ConfigMap']) expect(kinds.has(kind), kind).toBe(true);
    const deployment = [...k8s.store.values()].find((o) => o.kind === 'Deployment')!;
    expect(deployment.metadata.labels).toMatchObject({ 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods' });

    // the pod exists, but nobody has asked a bot anything: the checklist refuses the runner
    const refused = await mark(runnerId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/No bot has answered/);
    expect((await world.call<any>(omar, 'GET', '/api/workspace/onboarding')).body.state.marks).toEqual([]);

    // a real answer (the question, the finished run, a reply from somebody else): now it is accepted
    await leaveTestAnswer();
    const accepted = await mark(runnerId);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.state.marks).toMatchObject([{ step: 'runners', kind: 'checked', refId: runnerId }]);
  });

  it('a pod runner made for no team gets no pod: why the screen makes it for every team', async () => {
    await world.system(async (tx) => {
      await tx.query(`UPDATE app.bot_runners SET is_default = false WHERE workspace_id = $1`, [omar.workspaceId]);
      await tx.query(`UPDATE app.bot_runners SET all_teams = false WHERE name = 'hermes'`);
    });
    const alone = await world.call<any>(omar, 'POST', '/api/admin/bot-runners', { name: 'nobody', label: 'Pod for nobody', kind: 'hermes_pod' });
    expect(alone.status).toBe(201);
    expect((await world.call(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: alone.body.runner.id })).status).toBe(200);
    expect(await provider().teamsWithPodBots()).toEqual([]);
  });
});
