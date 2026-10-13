import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';

// The stale-run reaper: a run whose worker died stays `running` for ever and everything that waits for runs to end waits with it. Past its bot's
// limit plus a grace period (six hours when the definition names none) it is closed `failed` through the run service, which emits `bots.run.closed`.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: World;
let teamId = '';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

async function bot(slug: string, timeoutSeconds: number | null): Promise<string> {
  return w.system(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, run_timeout_seconds)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', $4) RETURNING id`,
        [omar.workspaceId, teamId, slug, timeoutSeconds],
      )
    ).rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, id]);
    return id;
  });
}

const run = (botId: string, startedAgo: string): Promise<string> =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at)
           VALUES ($1, $2, $3, 'mention', $4, 'running', now() - $5::interval) RETURNING id`,
          [omar.workspaceId, botId, teamId, nadia.actorId, startedAgo],
        )
      ).rows[0]!.id,
  );

const state = (id: string) => w.system(async (tx) => (await tx.query<{ status: string; ended: boolean }>('SELECT status, ended_at IS NOT NULL AS ended FROM app.bot_runs WHERE id = $1', [id])).rows[0]!);

async function reap(): Promise<void> {
  const job = await w.system(async (tx) => {
    const id = (await tx.query<{ id: string }>("SELECT (app.enqueue_job('bots.reap-runs', '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id")).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [id]);
    await tx.query("SELECT pg_notify('manythreads_jobs', 'bots.reap-runs')");
    return id;
  });
  await until(async () => w.system(async (tx) => (['done', 'dead'].includes((await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job])).rows[0]?.state ?? '') ? true : null)), 'the reaper job');
}

beforeAll(async () => {
  w = await createWorld();
  teamId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('bots.reap-runs', () => {
  it('closes a run past its bot’s limit plus the grace, as failed, with the run-closed event; leaves the rest', async () => {
    const limited = await bot('limited', 600); // 10 minutes + 10 minutes' grace
    const unlimited = await bot('unlimited', null); // six hours + grace
    const stale = await run(limited, '25 minutes');
    const withinGrace = await run(limited, '15 minutes');
    const fresh = await run(limited, '1 minute');
    const staleNoLimit = await run(unlimited, '7 hours');
    const withinDefault = await run(unlimited, '5 hours');
    await reap();

    expect(await state(stale)).toEqual({ status: 'failed', ended: true });
    expect(await state(staleNoLimit)).toEqual({ status: 'failed', ended: true });
    for (const id of [withinGrace, fresh, withinDefault]) expect(await state(id)).toEqual({ status: 'running', ended: false });

    const closed = await w.system(async (tx) => (await tx.query<{ run: string; status: string }>("SELECT payload ->> 'runId' AS run, payload ->> 'status' AS status FROM app.events WHERE type = 'bots.run.closed'")).rows);
    expect(closed.filter((e) => [stale, staleNoLimit].includes(e.run))).toEqual(expect.arrayContaining([{ run: stale, status: 'failed' }, { run: staleNoLimit, status: 'failed' }]));
    expect(closed.some((e) => [withinGrace, fresh, withinDefault].includes(e.run))).toBe(false);
  });

  it('a run that is already closed is left as it is', async () => {
    const b = await bot('already-done', 60);
    const id = await run(b, '3 hours');
    await w.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [id]));
    await reap();
    expect(await state(id)).toEqual({ status: 'done', ended: true });
  });
});
