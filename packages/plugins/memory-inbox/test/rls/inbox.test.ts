import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import type { RunId } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  memoryInboxMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-14: who may read a team's inbox (the people of the team, not a guest; a held item only its dropper and the team's leads and admins), who may drop, who may
// move an item along (leads and admins, and only along the allowed moves), and the rules the database keeps whatever the code does: what a drop is never
// changes, the extracts are the platform's, the queue is capped, and the one definer function gives a `drop` run its own item and nothing else.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 1000;

interface Seed {
  state?: string;
  stage?: string;
  holdReason?: string | null;
  dropper?: Persona;
  blob?: string | null;
  team?: string;
}
/** An item as the system role makes one (the pipeline's door). */
async function seed(o: Seed = {}): Promise<string> {
  counter += 1;
  return sys(async (tx) => {
    const dropper = o.dropper ?? nadia;
    const res = await tx.query<{ id: string }>(
      `INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, hold_reason)
       VALUES ($1, $2, 'person', $3, $4, 'markdown', 'notes.md', 10, $5, $6, $7, 'Dropper', $8) RETURNING id`,
      [omar.workspaceId, o.team ?? ENG, o.state ?? 'queued', o.stage ?? 'hold', sha(counter), o.blob === undefined ? `blob-${counter}` : o.blob, dropper.actorId, o.holdReason ?? null],
    );
    return res.rows[0]!.id;
  });
}
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.memory_inbox_items ORDER BY id')).rows.map((r) => r.id));

const dropSql = `INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name)
                 VALUES ($1, $2, $3, $4, $5, 'markdown', 'a.md', 5, $6, 'k', $7, 'N') RETURNING id`;
const drop = (p: Persona, over: { team?: string; origin?: string; state?: string; stage?: string; dropper?: string } = {}): Promise<unknown> =>
  as(p, (tx) =>
    tx.query(dropSql, [omar.workspaceId, over.team ?? ENG, over.origin ?? 'person', over.state ?? 'queued', over.stage ?? 'hold', sha((counter += 1)), over.dropper ?? p.actorId]),
  );

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, memoryInboxMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('reading', () => {
  it('shows the people of the team their inbox, and nobody else: not a guest, not another team', async () => {
    const queued = await seed();
    expect(await visible(nadia)).toContain(queued);
    expect(await visible(rafi)).toContain(queued);
    expect(await visible(omar)).toContain(queued);
    expect(await visible(sameera)).not.toContain(queued);
    expect(await visible(tariq)).not.toContain(queued);
    expect(await visible(lena)).not.toContain(queued);
  });

  it('shows a held item only to the person who dropped it, the team’s leads and workspace admins', async () => {
    const held = await seed({ state: 'held', holdReason: 'review_all', dropper: nadia });
    expect(await visible(nadia)).toContain(held);
    expect(await visible(omar)).toContain(held);
    expect(await visible(rafi)).not.toContain(held);
    expect(await visible(sameera)).not.toContain(held);
    expect(await visible(lena)).not.toContain(held);
  });

  it('a held item needs its reason', async () => {
    const bad = await seed();
    expect(await code(sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'held' WHERE id = $1`, [bad])))).toBe('23514');
  });
});

describe('dropping', () => {
  it('lets a person with post rights drop into their own team, as themselves', async () => {
    await expect(drop(nadia)).resolves.toBeDefined();
    await expect(drop(omar)).resolves.toBeDefined();
    await expect(drop(nadia, { state: 'duplicate', stage: 'done' })).resolves.toBeDefined();
  });

  it('refuses a guest, a person from another team, and a drop made in somebody else’s name', async () => {
    expect(await code(drop(lena))).toBe('42501');
    expect(await code(drop(sameera))).toBe('42501');
    expect(await code(drop(tariq))).toBe('42501');
    expect(await code(drop(nadia, { dropper: rafi.actorId }))).toBe('42501');
  });

  it('refuses a drop that starts anywhere but the beginning: no filed item, no email origin, no later stage', async () => {
    expect(await code(drop(nadia, { state: 'filed' }))).toBe('42501');
    expect(await code(drop(nadia, { state: 'held' }))).toBe('42501');
    expect(await code(drop(nadia, { origin: 'email' }))).toBe('42501');
    expect(await code(drop(nadia, { origin: 'share' }))).toBe('42501');
    expect(await code(drop(nadia, { stage: 'commit' }))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, dropper_id, filed_paths) VALUES ($1, $2, 'person', 'queued', 'hold', 'markdown', 'x', 1, $3, $4, ARRAY['memory/x.md'])`, [omar.workspaceId, ENG, sha((counter += 1)), nadia.actorId])))).toBe('42501');
  });

  it('keeps the shape: a kind, a name and a hash that mean something', async () => {
    const bad = (cols: string, vals: unknown[]): Promise<string | undefined> => code(sys((tx) => tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, kind, name, size, sha256, ${cols}) VALUES ($1, $2, 'person', 'markdown', 'x', 1, $3, ${vals.map((_, i) => `$${i + 4}`).join(', ')})`, [omar.workspaceId, ENG, sha((counter += 1)), ...vals])));
    expect(await bad('state', ['mystery'])).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, kind, name, size, sha256) VALUES ($1, $2, 'person', 'markdown', '', 1, $3)`, [omar.workspaceId, ENG, sha((counter += 1))])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, kind, name, size, sha256) VALUES ($1, $2, 'person', 'markdown', 'x', 1, 'not-a-hash')`, [omar.workspaceId, ENG])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, kind, name, size, sha256) VALUES ($1, $2, 'person', 'markdown', 'x', -1, $3)`, [omar.workspaceId, ENG, sha((counter += 1))])))).toBe('23514');
  });

  it('caps the queue of a team at 500 waiting items, whoever drops', async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, dropper_id)
         SELECT $1, $2, 'person', 'queued', 'hold', 'markdown', 'bulk', 1, encode(sha256(g::text::bytea), 'hex'), $3 FROM generate_series(1, 500) g`,
        [omar.workspaceId, TEAM_IDS.Marketing, tariq.actorId],
      ),
    );
    expect(await code(drop(tariq, { team: TEAM_IDS.Marketing }))).toBe('23514');
    // the cap is per team
    await expect(drop(nadia)).resolves.toBeDefined();
    // an item that is not waiting does not count
    await expect(drop(tariq, { team: TEAM_IDS.Marketing, state: 'duplicate', stage: 'done' })).resolves.toBeDefined();
  });
});

describe('moving an item along', () => {
  it('lets a lead release a held item and a member not', async () => {
    const held = await seed({ state: 'held', holdReason: 'unknown_sender', dropper: nadia });
    const rows = (p: Persona): Promise<number> =>
      as(p, async (tx) => (await tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', released_by = $2, released_at = now() WHERE id = $1`, [held, p.actorId])).rowCount ?? 0);
    expect(await rows(rafi)).toBe(0);
    expect(await rows(nadia)).toBe(0);
    expect(await rows(sameera)).toBe(0);
    expect(await rows(omar)).toBe(1);
  });

  it('allows only the moves of the pipeline’s own rules: a lead cannot mark an item filed, queued again, or rewrite what it is', async () => {
    const waiting = await seed();
    const update = (sql: string, id = waiting): Promise<string | undefined> => code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET ${sql} WHERE id = $1`, [id])));
    expect(await update(`state = 'filed'`)).toBe('42501');
    expect(await update(`state = 'extracting'`)).toBe('42501');
    expect(await update(`name = 'other.md'`)).toBe('42501');
    expect(await update(`sha256 = '${sha(7)}'`)).toBe('42501');
    expect(await update(`dropper_id = '${omar.actorId}'`)).toBe('42501');
    expect(await update(`team_id = '${TEAM_IDS.Marketing}'`)).toBe('42501');
    expect(await update(`origin = 'email'`)).toBe('42501');
    expect(await update(`team_only = true`)).toBe('42501');
    expect(await update(`commit_sha = repeat('a', 40)`)).toBe('42501');
    expect(await update(`blob_key = NULL`)).toBe('42501');
    const filed = await seed({ state: 'filed', stage: 'done' }).catch((e: unknown) => e);
    expect(String(filed)).toMatch(/filed_has_commit|memory_inbox_filed_has_commit/);
  });

  it('a lead retries a failed item and discards a waiting one, but a discard must clear the original', async () => {
    const failed = await seed({ state: 'failed' });
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', stage = 'extract' WHERE id = $1`, [failed])))).toBeUndefined();
    const held = await seed({ state: 'held', holdReason: 'dlp' });
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'discarded' WHERE id = $1`, [held])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'discarded', blob_key = NULL, original_removed_at = now() WHERE id = $1`, [held])))).toBeUndefined();
    // a discarded item stays discarded
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'queued' WHERE id = $1`, [held])))).toBe('42501');
    // an item the pipeline is working on cannot be discarded under it
    const running = await seed({ state: 'extracting', stage: 'extract' });
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'discarded', blob_key = NULL WHERE id = $1`, [running])))).toBe('42501');
  });

  it('deletes nothing for a person: only the system role removes a row', async () => {
    const id = await seed();
    expect((await as(omar, (tx) => tx.query('DELETE FROM app.memory_inbox_items WHERE id = $1', [id]))).rowCount).toBe(0);
    expect((await sys((tx) => tx.query('DELETE FROM app.memory_inbox_items WHERE id = $1', [id]))).rowCount).toBe(1);
  });
});

describe('the working copy of the text', () => {
  it('is the system role’s to write, a lead’s to read and remove, and nobody else’s', async () => {
    const id = await seed();
    const insert = `INSERT INTO app.memory_inbox_extracts (item_id, team_id, text) VALUES ($1, $2, 'The text.')`;
    expect(await code(as(omar, (tx) => tx.query(insert, [id, ENG])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(insert, [id, ENG])))).toBe('42501');
    await sys((tx) => tx.query(insert, [id, ENG]));
    const read = (p: Persona): Promise<number> => as(p, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.memory_inbox_extracts')).rows[0]?.n));
    expect(await read(omar)).toBe(1);
    expect(await read(nadia)).toBe(0);
    expect(await read(lena)).toBe(0);
    expect(await read(sameera)).toBe(0);
    expect((await as(nadia, (tx) => tx.query(`UPDATE app.memory_inbox_extracts SET text = 'x' WHERE item_id = $1`, [id]))).rowCount).toBe(0);
    expect((await as(omar, (tx) => tx.query(`UPDATE app.memory_inbox_extracts SET text = 'x' WHERE item_id = $1`, [id]))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.memory_inbox_extracts WHERE item_id = $1', [id]))).rowCount).toBe(0);
    expect((await as(omar, (tx) => tx.query('DELETE FROM app.memory_inbox_extracts WHERE item_id = $1', [id]))).rowCount).toBe(1);
  });

  it('goes with its item, and the text is bounded by the table', async () => {
    const id = await seed();
    await sys((tx) => tx.query(`INSERT INTO app.memory_inbox_extracts (item_id, team_id, text) VALUES ($1, $2, 'x')`, [id, ENG]));
    await sys((tx) => tx.query('DELETE FROM app.memory_inbox_items WHERE id = $1', [id]));
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.memory_inbox_extracts WHERE item_id = $1', [id]))).rowCount).toBe(0);
    const other = await seed();
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.memory_inbox_extracts (item_id, team_id, text) VALUES ($1, $2, repeat('x', 1000001))`, [other, ENG])))).toBe('23514');
  });
});

describe('app.inbox_run_item: the one door a drop run reads through', () => {
  let botActor = '';
  let otherBotActor = '';
  let runId = '';
  let otherRunId = '';
  let item = '';

  beforeAll(async () => {
    await sys(async (tx) => {
      const mkBot = async (slug: string): Promise<{ bot: string; actor: string }> => {
        const bot = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
             VALUES ($1, $2, $3, $3, 'Files', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
            [omar.workspaceId, ENG, slug],
          )
        ).rows[0]!.id;
        const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot])).rows[0]!.id;
        return { bot, actor };
      };
      const archivist = await mkBot('archivist');
      const other = await mkBot('other-bot');
      botActor = archivist.actor;
      otherBotActor = other.actor;
      runId = (await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'drop', 'running') RETURNING id`, [omar.workspaceId, archivist.bot, ENG])).rows[0]!.id;
      otherRunId = (await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'mention', 'running') RETURNING id`, [omar.workspaceId, other.bot, ENG])).rows[0]!.id;
    });
    item = await seed({ state: 'filing', stage: 'distil' });
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.memory_inbox_extracts (item_id, team_id, text, title) VALUES ($1, $2, 'Q3 plan: ship the thing.', 'Q3 plan')`, [item, ENG]);
      await tx.query('UPDATE app.memory_inbox_items SET drop_run_id = $2 WHERE id = $1', [item, runId]);
    });
  });

  const asBot = <T>(actorId: string, run: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withActor({ kind: 'bot', id: actorId as never, workspaceId: omar.workspaceId, ...(run ? { runId: run as RunId } : {}) }, fn, { pool: appPool });
  const read = (actorId: string, run: string | null): Promise<Record<string, unknown> | null> =>
    asBot(actorId, run, async (tx) => (await tx.query<{ item: Record<string, unknown> | null }>('SELECT app.inbox_run_item() AS item')).rows[0]?.item ?? null);

  it('gives the run’s own bot its item, with the text, and nothing about anything else', async () => {
    expect(await read(botActor, runId)).toMatchObject({ itemId: item, teamId: ENG, origin: 'person', kind: 'markdown', name: 'notes.md', teamOnly: false, title: 'Q3 plan', text: 'Q3 plan: ship the thing.' });
  });

  it('answers nothing to a person, to a bot outside the run, to a run of another kind, or when the run is not live', async () => {
    expect(await as(omar, async (tx) => (await tx.query<{ item: unknown }>('SELECT app.inbox_run_item() AS item')).rows[0]?.item)).toBeNull();
    expect(await read(botActor, null)).toBeNull();
    expect(await read(otherBotActor, runId)).toBeNull();
    expect(await read(otherBotActor, otherRunId)).toBeNull();
    expect(await read(botActor, otherRunId)).toBeNull();
    await sys((tx) => tx.query(`UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [runId]));
    expect(await read(botActor, runId)).toBeNull();
    await sys((tx) => tx.query(`UPDATE app.bot_runs SET status = 'running', ended_at = NULL WHERE id = $1`, [runId]));
    expect(await read(botActor, runId)).not.toBeNull();
  });

  it('gives nothing once the item is not being filed: held, discarded or finished', async () => {
    for (const state of ['held', 'discarded', 'filed', 'queued']) {
      await sys((tx) =>
        tx.query(
          `UPDATE app.memory_inbox_items SET state = $2, hold_reason = CASE WHEN $2 = 'held' THEN 'dlp' END,
                  commit_sha = CASE WHEN $2 = 'filed' THEN repeat('a', 40) END, filed_at = CASE WHEN $2 = 'filed' THEN now() END WHERE id = $1`,
          [item, state],
        ),
      );
      expect(await read(botActor, runId), state).toBeNull();
    }
    await sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'filing', stage = 'distil', hold_reason = NULL, commit_sha = NULL, filed_at = NULL WHERE id = $1`, [item]));
    expect(await read(botActor, runId)).not.toBeNull();
    await sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET stage = 'commit' WHERE id = $1`, [item]));
    expect(await read(botActor, runId)).toBeNull();
    await sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET stage = 'distil' WHERE id = $1`, [item]));
  });

  it('is a definer function owned by the system role with its search path pinned, and not callable by PUBLIC', async () => {
    const c = testClient({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const row = (
        await c.query<{ owner: string; secdef: boolean; config: string[] | null; acl: string[] | null }>(
          `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text[] AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'inbox_run_item'`,
        )
      ).rows[0]!;
      expect(row.owner).toBe('manythreads_system');
      expect(row.secdef).toBe(true);
      expect(row.config?.join(',')).toContain('search_path=pg_catalog, app, pg_temp');
      expect((row.acl ?? []).some((a) => a.startsWith('=') )).toBe(false);
    } finally {
      await c.end();
    }
  });
});

describe('the policies themselves', () => {
  it('call the helper functions once per statement, not once per row, and every violation is explained', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['memory_inbox_items', 'memory_inbox_extracts']) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
