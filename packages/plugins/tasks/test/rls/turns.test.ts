import { randomUUID } from 'node:crypto';
import { withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCapabilities } from '../../src/capabilities.ts';
import { registerTurnCapabilities } from '../../src/capabilities-turns.ts';

// `tasks.release` and `tasks.describe` against the real database: who may use them, and the refusals that keep a finished card, a card that
// waits on a person and a card with a handover in flight out of a bot's hands.

const { nadia } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
type Handler = (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>;
const handlers = new Map<string, Handler>();
const events: Array<Record<string, unknown>> = [];
const tool = (name: string, actor: string, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  withActor({ kind: 'bot', id: actor, workspaceId: WS } as Actor, (tx) => handlers.get(name)!(input, tx as unknown as PluginTx), { pool: server.pools.app });

async function makeBot(team: string): Promise<string> {
  return sys(async (tx) => {
    const slug = `tb-${randomUUID().slice(0, 6)}`;
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [WS, team, slug],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [team, actor, WS]);
    return actor;
  });
}
const card = (): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.tasks (workspace_id, team_id, title, kind, branch, created_by) VALUES ($1, $2, 'Counter', 'other', 'bench/x', $3) RETURNING id`,
          [WS, ENG, nadia.actorId],
        )
      ).rows[0]!.id,
  );
const row = (id: string) => sys(async (tx) => (await tx.query<{ state: string; owner_id: string | null; description: string }>('SELECT state, owner_id, description FROM app.tasks WHERE id = $1', [id])).rows[0]!);
const history = (id: string) => sys(async (tx) => (await tx.query<{ type: string; actor_id: string; data: Record<string, unknown> }>('SELECT type, actor_id, data FROM app.task_events WHERE task_id = $1 ORDER BY created_at, id', [id])).rows);

let a = '';
let b = '';
let outsider = '';
beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const ctx = {
    capabilities: { register: (n: string, fn: Handler) => handlers.set(n, fn) },
    audit: { emit: (_tx: PluginTx, e: Record<string, unknown>) => Promise.resolve(void events.push(e)) },
  } as unknown as PluginContext;
  registerCapabilities(ctx);
  registerTurnCapabilities(ctx);
  a = await makeBot(ENG);
  b = await makeBot(ENG);
  outsider = await makeBot(SUPPORT);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('tasks.describe and tasks.release', () => {
  it('the owner rewrites the description with a history line and an updated event, then releases', async () => {
    const id = await card();
    expect(await tool('tasks.claim', a, { taskId: id })).toMatchObject({ ok: true });
    events.length = 0;
    expect(await tool('tasks.describe', a, { taskId: id, description: '1 a' })).toMatchObject({ ok: true, description: '1 a' });
    expect((await row(id)).description).toBe('1 a');
    expect(events.map((e) => e['type'])).toEqual(['tasks.task.updated']);
    const described = (await history(id)).filter((e) => e.type === 'described');
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ actor_id: a, data: { beforeLength: 0, afterLength: 3 } });
    expect(String(described[0]!.data['sha256'])).toMatch(/^[0-9a-f]{64}$/);
    events.length = 0;
    expect(await tool('tasks.release', a, { taskId: id })).toMatchObject({ ok: true });
    expect(events.map((e) => e['type'])).toEqual(['tasks.task.updated']);
    expect(await row(id)).toMatchObject({ state: 'open', owner_id: null });
  });

  it('refuses a bot that does not own the card, and a bot of another team', async () => {
    const id = await card();
    await tool('tasks.claim', a, { taskId: id });
    expect(await tool('tasks.describe', b, { taskId: id, description: 'x' })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await tool('tasks.release', b, { taskId: id })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await tool('tasks.describe', outsider, { taskId: id, description: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await tool('tasks.release', outsider, { taskId: id })).toMatchObject({ ok: false, code: 'not_found' });
    expect((await row(id)).owner_id).toBe(a);
  });

  it('refuses a finished card and a card that waits on a person', async () => {
    for (const [state, code] of [['done', 'already_done'], ['waiting_on_person', 'waiting_on_person']] as const) {
      const id = await card();
      await tool('tasks.claim', a, { taskId: id });
      await sys((tx) => tx.query('UPDATE app.tasks SET state = $2 WHERE id = $1', [id, state]));
      expect(await tool('tasks.describe', a, { taskId: id, description: 'x' })).toMatchObject({ ok: false, code });
      expect(await tool('tasks.release', a, { taskId: id })).toMatchObject({ ok: false, code });
      expect(await row(id)).toMatchObject({ state, owner_id: a, description: '' });
    }
  });

  it('refuses both while a handover waits for approval', async () => {
    const id = await card();
    await tool('tasks.claim', a, { taskId: id });
    await sys((tx) => tx.query(`INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode) VALUES ($1, $2, $3, $4, 'bot')`, [id, ENG, a, b]));
    expect(await tool('tasks.describe', a, { taskId: id, description: 'x' })).toMatchObject({ ok: false, code: 'handoff_pending' });
    expect(await tool('tasks.release', a, { taskId: id })).toMatchObject({ ok: false, code: 'handoff_pending' });
    expect((await row(id)).owner_id).toBe(a);
  });

  it('refuses a describe after the claim expired (the sweep has not run yet)', async () => {
    const id = await card();
    await tool('tasks.claim', a, { taskId: id });
    await sys((tx) => tx.query(`UPDATE app.task_claims SET claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE task_id = $1 AND released_at IS NULL`, [id]));
    expect(await tool('tasks.describe', a, { taskId: id, description: 'x' })).toMatchObject({ ok: false, code: 'claim_expired' });
    expect((await row(id)).description).toBe('');
  });

  it('refuses a NUL character and an over-long text before the database', async () => {
    const id = await card();
    await tool('tasks.claim', a, { taskId: id });
    expect(await tool('tasks.describe', a, { taskId: id, description: 'a\u0000b' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await tool('tasks.describe', a, { taskId: id, description: 'x'.repeat(8001) })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
