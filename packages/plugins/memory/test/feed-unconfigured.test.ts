import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// No memory engine in the deployment (MANYTHREADS_HINDSIGHT_URL unset, the state of every install until Hindsight is deployed): the feed does
// nothing, says so once a day per team, and never fails or holds up the outbox consumer that every other plugin's events travel through.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let devChannel = '';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

beforeAll(async () => {
  delete process.env['MANYTHREADS_HINDSIGHT_URL'];
  delete process.env['MANYTHREADS_HINDSIGHT_API_KEY'];
  process.env['MANYTHREADS_MEMORY_DEBOUNCE_MS'] = '0';
  w = await createRepoWorld();
  await w.call(omar, 'GET', '/api/teams/engineering/channels');
  devChannel = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.channels WHERE team_id = $1 AND name = 'dev'", [ENG])).rows[0]!.id);
}, 240_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_MEMORY_DEBOUNCE_MS'];
  await w?.close();
});

describe('with no memory engine configured', () => {
  it('feeding is a no-op that logs not_configured once for the team, queues nothing, and the outbox is never held up', async () => {
    for (const body of ['First note while no engine is configured.', 'Second note.', 'Third note.']) {
      const res = await w.call(nadia, 'POST', `/api/channels/${devChannel}/messages`, { channelId: devChannel, body, threadRootId: null });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    await until(async () => w.system(async (tx) => ((await tx.query("SELECT 1 FROM app.memory_retain_log WHERE outcome = 'not_configured'")).rows.length > 0 ? true : null)), 'the not_configured line');
    // every event has been consumed: the consumer's queue is empty and nothing was dead-lettered
    await until(
      async () =>
        w.system(async (tx) => ((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.outbox WHERE done_at IS NULL AND dead_at IS NULL")).rows[0]!.n === 0 ? true : null)),
      'the outbox to drain',
    );
    const rows = await w.system(async (tx) => (await tx.query<{ outcome: string; team_id: string; bank: string; reason: string }>('SELECT outcome, team_id, bank, reason FROM app.memory_retain_log')).rows);
    expect(rows).toEqual([{ outcome: 'not_configured', team_id: ENG, bank: '(no engine)', reason: 'no memory engine is configured in this deployment' }]);
    const pending = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_feed_pending')).rows[0]!.n);
    expect(pending).toBe(0);
    const dead = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.outbox WHERE dead_at IS NOT NULL')).rows[0]!.n);
    expect(dead).toBe(0);
  });

  it('the log is still readable by the lead, and says why nothing of the team is in the bank', async () => {
    const res = await w.call(omar, 'GET', '/api/teams/engineering/memory/retain-log?outcome=not_configured');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { items: Array<{ outcome: string; documentId: string | null }> }).items).toMatchObject([{ outcome: 'not_configured', documentId: null }]);
  });
});
