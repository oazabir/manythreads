import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';

// P10-01: the setup checklist's own state through the real server. What it proves: only admins read or change it, a mark takes only the kind its
// step allows and can be taken back, the first goal is recorded once, the checklist cannot be put away before that goal, and each change writes
// one event with ids and short codes only.

const { omar, nadia, priya } = personas;
vi.setConfig({ testTimeout: 60_000 });

interface StateBody {
  state: {
    marks: Array<{ step: string; kind: string }>;
    launch: { teamId: string; channelId: string; at: string } | null;
    dismissedAt: string | null;
  };
}

let world: World;
let teamId = '';
const channelId = '11111111-1111-4111-8111-111111111111';

const get = (who = omar) => world.call<StateBody>(who, 'GET', '/api/workspace/onboarding');
let since = new Date(0);
/** The events of this type written during the current test (the event log is append-only, so tests count from a mark instead of clearing it). */
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND occurred_at >= $2 ORDER BY id`, [type, since]))).rows.map((r) => r.payload);

beforeAll(async () => {
  world = await createWorld();
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`)).rows[0]!.id);
}, 120_000);

afterAll(async () => {
  await world?.close();
});

// Every test starts from a fresh install.
beforeEach(async () => {
  await world.system(async (tx) => {
    await tx.query('DELETE FROM app.onboarding_marks');
    await tx.query('DELETE FROM app.onboarding_state');
  });
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
});

describe('seedFinishedSetup', () => {
  it('puts the seeded workspace away for the e2e servers, and createPersonas alone leaves a fresh install (the live demo seed uses it)', async () => {
    const { createPersonas, seedFinishedSetup } = await import('@manythreads/test-utils');
    await createPersonas(world.server.db);
    expect((await get()).body.state).toEqual({ marks: [], launch: null, dismissedAt: null, dismissedBy: null });
    await seedFinishedSetup(world.server.db);
    await seedFinishedSetup(world.server.db);
    const res = await get();
    expect(res.body.state.dismissedAt).not.toBeNull();
    expect(res.body.state.launch).not.toBeNull();
  });
});

describe('GET /api/workspace/onboarding', () => {
  it('reads as empty on a fresh install', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.state).toEqual({ marks: [], launch: null, dismissedAt: null, dismissedBy: null });
  });

  it('is for owners and admins only', async () => {
    expect((await get(nadia)).status).toBe(403);
    expect((await get(priya)).status).toBe(403);
    expect((await world.call(null, 'GET', '/api/workspace/onboarding')).status).toBe(401);
  });
});

describe('marks', () => {
  it('sets aside an optional step, confirms password-only sign-in, and takes either back', async () => {
    const skipped = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped' });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    const acked = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/signin', { kind: 'acknowledged' });
    expect(acked.body.state.marks.map((m) => `${m.step}:${m.kind}`).sort()).toEqual(['code:skipped', 'signin:acknowledged']);

    const cleared = await world.call<StateBody>(omar, 'DELETE', '/api/workspace/onboarding/marks/code');
    expect(cleared.body.state.marks.map((m) => m.step)).toEqual(['signin']);
    expect((await events('onboarding.step.marked')).map((e) => [e['step'], e['kind']])).toEqual([
      ['code', 'skipped'],
      ['signin', 'acknowledged'],
      ['code', null],
    ]);
  });

  it('writes one event per real change: repeating a mark or clearing nothing is silent', async () => {
    for (let i = 0; i < 3; i++) await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/servers', { kind: 'skipped' });
    await world.call(omar, 'DELETE', '/api/workspace/onboarding/marks/infrastructure');
    expect(await events('onboarding.step.marked')).toHaveLength(1);
  });

  it('takes only the kind a step allows, and only steps that are decisions', async () => {
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/signin', { kind: 'skipped' })).status).toBe(409);
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'acknowledged' })).status).toBe(409);
    // models, teams and bots are facts: they cannot be marked, so they cannot be skipped around
    for (const step of ['models', 'teams', 'bots', 'launch', 'bootstrap']) {
      expect((await world.call(omar, 'PUT', `/api/workspace/onboarding/marks/${step}`, { kind: 'skipped' })).status, step).toBe(400);
    }
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped', extra: 1 })).status).toBe(400);
    expect((await get()).body.state.marks).toEqual([]);
  });

  it('is for admins only', async () => {
    expect((await world.call(nadia, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped' })).status).toBe(403);
    expect((await world.call(nadia, 'DELETE', '/api/workspace/onboarding/marks/code')).status).toBe(403);
  });
});

describe('launch and dismiss', () => {
  it('refuses to put the checklist away before the first goal was sent', async () => {
    const res = await world.call<{ code?: string; error?: { code?: string } }>(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(res.status).toBe(409);
    expect((await get()).body.state.dismissedAt).toBeNull();
    expect(await events('onboarding.checklist.dismissed')).toEqual([]);
  });

  it('records the first goal once, and only as ids', async () => {
    const first = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.state.launch).toMatchObject({ teamId, channelId });
    const again = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId: '22222222-2222-4222-8222-222222222222' });
    expect(again.body.state.launch?.channelId).toBe(channelId);
    const logged = await events('onboarding.goal.launched');
    expect(logged).toHaveLength(1);
    const keys = Object.keys(logged[0] ?? {});
    expect(keys).toEqual(expect.arrayContaining(['teamId', 'channelId']));
    for (const key of keys) expect(['at', 'channelId', 'launchedBy', 'schemaVersion', 'teamId', 'type', 'workspaceId']).toContain(key);
  });

  it('puts the checklist away after the launch, once', async () => {
    await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId });
    const done = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.state.dismissedAt).not.toBeNull();
    await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(await events('onboarding.checklist.dismissed')).toHaveLength(1);
  });

  it('is for admins only, and a malformed body is refused', async () => {
    expect((await world.call(nadia, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId })).status).toBe(403);
    expect((await world.call(nadia, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(403);
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId: 'nope', channelId })).status).toBe(400);
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId, text: 'hello' })).status).toBe(400);
  });
});
