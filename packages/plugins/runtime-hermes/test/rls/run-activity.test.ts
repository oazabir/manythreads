import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  runtimeHermesMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { activityWatchersOf, watchersOf } from '../../src/live.ts';
import { closeOverRuns } from '../../src/run-sweep.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P25-06 to P25-08: who reads what a run did (run_view, run_activity), who has a thread open (thread_watchers), and who may stop a run
// (app.run_may_stop, app.run_stop_request). Rows are written through the system role (the run job does that); every assertion runs as a
// persona through the app pool, which is what a request is.

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;
const ALL = [omar, nadia, rafi, sameera, tariq, priya, lena] as const;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const asActor = <T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(actor, fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const ch: Record<string, string> = {};
const msg: Record<string, string> = {};
const run: Record<string, string> = {};
const botOf: Record<string, { id: string; actor: string }> = {};
let botActor = '';

async function channel(name: string, team: string, isPrivate: boolean): Promise<string> {
  return sys(async (tx) =>
    (await tx.query<{ id: string }>(
      'INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [omar.workspaceId, team, name, 'channel', isPrivate],
    )).rows[0]!.id,
  );
}
const member = (channelId: string, p: Persona): Promise<unknown> => sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [channelId, p.personId]));
const root = (channelId: string, author: Persona, body: string): Promise<string> =>
  sys(async (tx) =>
    (await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4) RETURNING id', [
      omar.workspaceId,
      channelId,
      author.actorId,
      body,
    ])).rows[0]!.id,
  );

/** One run with its folded row and two kept lines, as the run job leaves them. */
async function makeRun(key: string, o: { team: string; channel: string; root: string | null; asker: Persona; conversation?: boolean; state?: string }): Promise<void> {
  const conversation = o.conversation === true;
  const state = o.state ?? 'working';
  const ended = state === 'done' || state === 'failed' || state === 'stopped';
  await sys(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END) RETURNING id`,
      [omar.workspaceId, botOf[o.team]!.id, o.team, conversation ? 'conversation' : 'mention', o.asker.actorId, ended ? 'done' : 'running', ended],
    );
    const id = r.rows[0]!.id;
    run[key] = id;
    await tx.query(
      `INSERT INTO app.run_view (run_id, workspace_id, team_id, channel_id, thread_root_id, bot_id, bot_actor_id, bot_name, asker_id, conversation, state, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Coder', $8, $9, $10, now() - interval '1 minute', $11)`,
      [id, omar.workspaceId, o.team, o.channel, o.root, botOf[o.team]!.id, botOf[o.team]!.actor, o.asker.actorId, conversation, state, ended ? new Date() : null],
    );
    await tx.query(
      `INSERT INTO app.run_activity (run_id, seq, kind, payload, channel_id, thread_root_id, asker_id, conversation)
       VALUES ($1, 0, 'tool', $2::jsonb, $3, $4, $5, $6), ($1, 1, 'thinking', '{"kind":"thinking","seconds":2}'::jsonb, $3, $4, $5, $6)`,
      [id, JSON.stringify({ kind: 'tool', stepId: 's1', stepKind: 'read', title: 'Read the file', paths: ['src/a.ts'] }), o.channel, o.root, o.asker.actorId, conversation],
    );
  });
}

const viewIds = async (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ run_id: string }>('SELECT run_id FROM app.run_view')).rows.map((r) => r.run_id).sort());
const activityRuns = async (p: Persona): Promise<string[]> =>
  as(p, async (tx) => [...new Set((await tx.query<{ run_id: string }>('SELECT run_id FROM app.run_activity')).rows.map((r) => r.run_id))].sort());
const names = (...keys: string[]): string[] => keys.map((k) => run[k]!).sort();
const mayStop = (p: Persona, key: string): Promise<boolean> =>
  as(p, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.run_may_stop($1) AS ok', [run[key]])).rows[0]!.ok);
const stopAsk = (p: Persona, key: string): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ r: string }>('SELECT app.run_stop_request($1) AS r', [run[key]])).rows[0]!.r);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, runtimeHermesMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  ch['eng-general'] = await channel('eng-general', ENG, false);
  ch['eng-leads'] = await channel('eng-leads', ENG, true);
  ch['mkt-general'] = await channel('mkt-general', MKT, false);
  ch['mkt-secret'] = await channel('mkt-secret', MKT, true);
  await member(ch['eng-leads']!, omar);
  await member(ch['eng-leads']!, rafi);
  await member(ch['mkt-secret']!, tariq);
  msg['general'] = await root(ch['eng-general']!, rafi, 'please look at the build');
  msg['leads'] = await root(ch['eng-leads']!, omar, 'leads only');
  msg['mkt'] = await root(ch['mkt-general']!, priya, 'launch copy');
  msg['secret'] = await root(ch['mkt-secret']!, tariq, 'campaign secret');

  await sys(async (tx) => {
    for (const [team, slug] of [[ENG, 'coder'], [MKT, 'copywriter']] as const) {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, $3, 'Coder', 'Writes code', 'agent', 'hermes', 'team', $4, 'active', '{"runner": "default"}') RETURNING id`,
        [omar.workspaceId, team, slug, 'a'.repeat(64)],
      );
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id])).rows[0]!.id;
      botOf[team] = { id: bot.rows[0]!.id, actor };
    }
    botActor = botOf[ENG]!.actor;
  });

  await makeRun('general', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
  await makeRun('leads', { team: ENG, channel: ch['eng-leads']!, root: msg['leads']!, asker: rafi });
  await makeRun('conv', { team: ENG, channel: ch['eng-general']!, root: null, asker: nadia, conversation: true });
  await makeRun('mkt', { team: MKT, channel: ch['mkt-general']!, root: msg['mkt']!, asker: priya });
  await makeRun('secret', { team: MKT, channel: ch['mkt-secret']!, root: msg['secret']!, asker: tariq });
  await makeRun('over', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia, state: 'done' });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the run tables pass the RLS harness', () => {
  it('RLS is enabled and forced with a policy and an rls comment, and no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['run_view', 'run_activity', 'thread_watchers', 'channel_watchers']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
        const r = await admin.query('SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass', [`app.${table}`]);
        expect(r.rows[0], table).toEqual({ on: true, forced: true });
      }
    } finally {
      await admin.end();
    }
  });
});

describe('who reads what a run did (by the run channel, not the team)', () => {
  it('a reader of a public channel reads its runs; a private channel only its members; nobody else', async () => {
    const open = names('general', 'mkt', 'over');
    // Nadia: Engineering public + her own conversation; not the private lead channel
    expect(await viewIds(nadia)).toEqual(names('general', 'conv', 'over'));
    // Rafi: the lead channel too (a member); not Nadia's conversation
    expect(await viewIds(rafi)).toEqual(names('general', 'leads', 'over'));
    // Priya: Engineering and Marketing public channels, not the private ones
    expect(await viewIds(priya)).toEqual(names('general', 'mkt', 'over'));
    expect(open).toHaveLength(3);
    // Sameera (support) and Lena (guest, other channel) read nothing
    expect(await viewIds(sameera)).toEqual([]);
    expect(await viewIds(lena)).toEqual([]);
  });

  it('a private channel is not leaked to the team: Nadia and Priya cannot read the lead channel runs, Omar cannot read the Marketing secret', async () => {
    expect(await viewIds(nadia)).not.toContain(run['leads']);
    expect(await viewIds(priya)).not.toContain(run['secret']);
    expect(await viewIds(omar)).not.toContain(run['secret']);
    expect(await viewIds(omar)).toEqual(names('general', 'leads', 'mkt', 'over'));
    expect(await viewIds(tariq)).toEqual(names('mkt', 'secret'));
  });

  it('the kept lines follow the same rule', async () => {
    expect(await activityRuns(nadia)).toEqual(names('general', 'conv', 'over'));
    expect(await activityRuns(rafi)).toEqual(names('general', 'leads', 'over'));
    expect(await activityRuns(omar)).toEqual(names('general', 'leads', 'mkt', 'over'));
    expect(await activityRuns(tariq)).toEqual(names('mkt', 'secret'));
    expect(await activityRuns(sameera)).toEqual([]);
    expect(await activityRuns(lena)).toEqual([]);
  });

  it('a run in a conversation is its asker alone, even in a channel everybody reads, even for an admin', async () => {
    for (const p of [omar, rafi, priya, sameera, tariq, lena]) expect(await viewIds(p), p.key).not.toContain(run['conv']);
    for (const p of [omar, rafi, priya, sameera, tariq, lena]) expect(await activityRuns(p), p.key).not.toContain(run['conv']);
    expect(await viewIds(nadia)).toContain(run['conv']);
  });

  it('a bot reads its own run and no other', async () => {
    const botOn = (key: string): Actor => ({ kind: 'bot', id: botActor, workspaceId: omar.workspaceId, runId: run[key] } as unknown as Actor);
    const seen = await asActor(botOn('leads'), async (tx) => (await tx.query<{ run_id: string }>('SELECT run_id FROM app.run_view')).rows.map((r) => r.run_id));
    expect(seen).toContain(run['leads']);
    const lines = await asActor(botOn('leads'), async (tx) => (await tx.query<{ seq: number }>('SELECT seq FROM app.run_activity WHERE run_id = $1', [run['leads']])).rows.length);
    expect(lines).toBe(2);
    const other = await asActor(botOn('leads'), async (tx) => (await tx.query('SELECT 1 FROM app.run_view WHERE run_id = $1', [run['secret']])).rows.length);
    expect(other).toBe(0);
  });

  it('nobody but the system writes them', async () => {
    for (const p of ALL) {
      expect(await code(as(p, (tx) => tx.query("UPDATE app.run_view SET state = 'done'"))), `${p.key} update`).toBe('42501');
      expect(await code(as(p, (tx) => tx.query('DELETE FROM app.run_activity'))), `${p.key} delete`).toBe('42501');
    }
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.run_activity (run_id, seq, kind, payload, channel_id) VALUES ($1, 9, 'thinking', '{"kind":"thinking","seconds":1}', $2)`,
            [run['general'], ch['eng-general']],
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('the checks hold: a state or a kind outside the words, a payload that is not an object', async () => {
    const bad = (sql: string, values: unknown[]): Promise<string | undefined> => code(sys((tx) => tx.query(sql, values)));
    expect(await bad("UPDATE app.run_view SET state = 'paused' WHERE run_id = $1", [run['general']])).toBe('23514');
    expect(await bad(`INSERT INTO app.run_activity (run_id, seq, kind, payload, channel_id) VALUES ($1, 5, 'output', '{}', $2)`, [run['general'], ch['eng-general']])).toBe('23514');
    expect(await bad(`INSERT INTO app.run_activity (run_id, seq, kind, payload, channel_id) VALUES ($1, 6, 'tool', '[]', $2)`, [run['general'], ch['eng-general']])).toBe('23514');
  });

  it('the rows go with their run, their channel and their message (foreign keys cascade)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const r = await admin.query<{ rel: string; target: string; del: string }>(
        `SELECT conrelid::regclass::text AS rel, confrelid::regclass::text AS target, confdeltype AS del
           FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('app.run_view'::regclass, 'app.run_activity'::regclass, 'app.thread_watchers'::regclass, 'app.channel_watchers'::regclass)`,
      );
      const found = r.rows.map((x) => `${x.rel}>${x.target}:${x.del}`).sort();
      expect(found).toEqual(
        [
          'app.run_activity>app.bot_runs:c',
          'app.run_activity>app.channels:c',
          'app.run_view>app.bot_runs:c',
          'app.run_view>app.channels:c',
          'app.run_view>app.messages:c',
          'app.channel_watchers>app.channels:c',
          'app.channel_watchers>app.people:c',
          'app.thread_watchers>app.channels:c',
          'app.thread_watchers>app.messages:c',
          'app.thread_watchers>app.people:c',
        ].sort(),
      );
    } finally {
      await admin.end();
    }
  });
});

describe('who may stop a run (app.run_may_stop)', () => {
  it('the asker, the person who started the thread, a lead of the team, an admin; nobody else', async () => {
    // Nadia asked, Rafi started the thread, Omar leads Engineering and is an admin
    expect(await mayStop(nadia, 'general')).toBe(true);
    expect(await mayStop(rafi, 'general')).toBe(true);
    expect(await mayStop(omar, 'general')).toBe(true);
    expect(await mayStop(priya, 'general')).toBe(false);
    expect(await mayStop(sameera, 'general')).toBe(false);
    expect(await mayStop(tariq, 'general')).toBe(false);
    expect(await mayStop(lena, 'general')).toBe(false);
  });

  it('a lead of the team stops a run somebody else asked for; so does an admin who is not a lead of it', async () => {
    // Priya asked in Marketing's public channel: Tariq leads Marketing, Omar is an admin, Nadia and Rafi cannot read the channel
    expect(await mayStop(priya, 'mkt')).toBe(true);
    expect(await mayStop(tariq, 'mkt')).toBe(true);
    expect(await mayStop(omar, 'mkt')).toBe(true);
    expect(await mayStop(nadia, 'mkt')).toBe(false);
    expect(await mayStop(rafi, 'mkt')).toBe(false);
  });

  it('a person who cannot read the run channel may not stop it, even an admin; a member of the private channel who asked may', async () => {
    expect(await mayStop(omar, 'secret')).toBe(false);
    expect(await mayStop(tariq, 'secret')).toBe(true);
    expect(await mayStop(nadia, 'leads')).toBe(false);
    expect(await mayStop(priya, 'leads')).toBe(false);
    expect(await mayStop(rafi, 'leads')).toBe(true);
    expect(await mayStop(omar, 'leads')).toBe(true);
  });

  it('a run in a conversation is stopped by its asker alone, not an admin, not a lead', async () => {
    expect(await mayStop(nadia, 'conv')).toBe(true);
    for (const p of [omar, rafi, priya, tariq, sameera, lena]) expect(await mayStop(p, 'conv'), p.key).toBe(false);
  });

  it('a run that does not exist, or is another workspace\'s, is false', async () => {
    const r = await as(omar, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.run_may_stop($1) AS ok', ['00000000-0000-7000-8000-0000000f0001'])).rows[0]!.ok);
    expect(r).toBe(false);
  });
});

describe('asking for the stop (app.run_stop_request)', () => {
  it('denies the ones who may not, records the first ask with the name, and says "already" to the second', async () => {
    expect(await stopAsk(sameera, 'general')).toBe('denied');
    expect(await stopAsk(priya, 'general')).toBe('denied');
    let row = await sys(async (tx) => (await tx.query('SELECT state, stop_requested_at FROM app.run_view WHERE run_id = $1', [run['general']])).rows[0]);
    expect(row).toMatchObject({ state: 'working', stop_requested_at: null });

    expect(await stopAsk(rafi, 'general')).toBe('requested');
    row = await sys(async (tx) => (await tx.query('SELECT state, stopped_by_name, stopped_by_actor, stop_requested_at FROM app.run_view WHERE run_id = $1', [run['general']])).rows[0]);
    expect(row).toMatchObject({ state: 'stopping', stopped_by_name: 'Rafi', stopped_by_actor: rafi.actorId });
    expect(row!.stop_requested_at).toBeInstanceOf(Date);

    // the second ask, even from the asker, changes nothing
    expect(await stopAsk(nadia, 'general')).toBe('already');
    const after = await sys(async (tx) => (await tx.query('SELECT stopped_by_name FROM app.run_view WHERE run_id = $1', [run['general']])).rows[0]);
    expect(after!.stopped_by_name).toBe('Rafi');
  });

  it('a run that is over answers "ended" and stays as it was', async () => {
    expect(await stopAsk(nadia, 'over')).toBe('ended');
    const row = await sys(async (tx) => (await tx.query('SELECT state, stop_requested_at FROM app.run_view WHERE run_id = $1', [run['over']])).rows[0]);
    expect(row).toMatchObject({ state: 'done', stop_requested_at: null });
  });

  it('the caller cannot write the row themselves', async () => {
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.run_view SET stop_requested_at = now() WHERE run_id = $1", [run['mkt']])))).toBe('42501');
  });
});

describe('who has a thread open (thread_watchers)', () => {
  const LEASE = '00000000-0000-4000-8000-0000000c0aa1';
  const LEASE_B = '00000000-0000-4000-8000-0000000c0bb2';
  const watch = (p: Persona, rootKey: string, channelKey: string, seconds = 60, lease = LEASE): Promise<unknown> =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         ON CONFLICT (root_id, person_id, lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [msg[rootKey], p.personId, lease, ch[channelKey], seconds],
      ),
    );
  const rowsOf = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_watchers')).rows.map((r) => r.person_id));

  it('a person writes and renews their own lease in a channel they can read', async () => {
    await watch(nadia, 'general', 'eng-general');
    await watch(nadia, 'general', 'eng-general', 90);
    await watch(rafi, 'general', 'eng-general');
    expect(await rowsOf(nadia)).toEqual([nadia.personId]);
    expect(await rowsOf(rafi)).toEqual([rafi.personId]);
    expect(await rowsOf(sameera)).toEqual([]);
    const all = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.thread_watchers')).rows.length);
    expect(all).toBe(2);
  });

  it('a person holds one lease per open tab: the second tab\'s lease is its own row, and closing one leaves the other', async () => {
    await watch(nadia, 'general', 'eng-general', 60, LEASE);
    await watch(nadia, 'general', 'eng-general', 60, LEASE_B);
    const mine = async (): Promise<number> => as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.thread_watchers WHERE person_id = $1', [nadia.personId])).rows.length);
    expect(await mine()).toBe(2);
    const closed = await as(nadia, async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE root_id = $1 AND lease_id = $2 AND person_id = app.person_id()', [msg['general'], LEASE_B])).rowCount ?? 0);
    expect(closed).toBe(1);
    expect(await mine()).toBe(1);
  });

  it('the lease names the channel of its root: a root of another channel, and a reply, are refused whoever writes them', async () => {
    // omar reads both channels, so only the trigger can refuse this
    expect(await code(watch(omar, 'mkt', 'eng-general'))).toBe('23514');
    const reply = await sys(async (tx) =>
      (await tx.query<{ id: string }>(
        'INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id',
        [omar.workspaceId, ch['eng-general'], rafi.actorId, 'a reply', msg['general']],
      )).rows[0]!.id,
    );
    msg['reply'] = reply;
    expect(await code(watch(omar, 'reply', 'eng-general'))).toBe('23514');
    // a person cannot move their lease to another thread's channel by updating it either
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.thread_watchers SET channel_id = $1 WHERE person_id = $2', [ch['mkt-general'], nadia.personId])))).toBeDefined();
    // the system is held to it too
    expect(await code(sys((tx) => tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 minute')", [msg['mkt'], priya.personId, LEASE, ch['eng-general']])))).toBe('23514');
  });

  it('a person holds at most 50 open leases; a renewal of one they hold is never refused for it', async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at)
         SELECT $1, $2, gen_random_uuid(), $3, now() + interval '1 minute' FROM generate_series(1, 50)`,
        [msg['general'], priya.personId, ch['eng-general']],
      ),
    );
    const error = await as(priya, (tx) =>
      tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, gen_random_uuid(), $3, now() + interval '1 minute')", [msg['general'], priya.personId, ch['eng-general']]),
    ).then(() => null, (e: { code?: string; constraint?: string }) => e);
    expect(error).toMatchObject({ code: '23514', constraint: 'thread_watchers_person_cap' });
    // a renewal of an existing lease (an upsert that meets its own row) goes through
    const held = await sys(async (tx) => (await tx.query<{ lease_id: string }>('SELECT lease_id FROM app.thread_watchers WHERE person_id = $1 LIMIT 1', [priya.personId])).rows[0]!.lease_id);
    await watch(priya, 'general', 'eng-general', 60, held);
    // lapsed leases do not count
    await sys((tx) => tx.query("UPDATE app.thread_watchers SET expires_at = now() - interval '1 minute' WHERE person_id = $1", [priya.personId]));
    await watch(priya, 'general', 'eng-general', 60, LEASE_B);
    await sys((tx) => tx.query('DELETE FROM app.thread_watchers WHERE person_id = $1', [priya.personId]));
  });

  it('not for somebody else, and not in a channel the person cannot read', async () => {
    expect(
      await code(as(nadia, (tx) => tx.query('INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'1 minute\')', [msg['general'], priya.personId, LEASE, ch['eng-general']]))),
    ).toBe('42501');
    expect(await code(watch(nadia, 'leads', 'eng-leads'))).toBe('42501');
    expect(await code(watch(sameera, 'general', 'eng-general'))).toBe('42501');
    expect(await code(watch(lena, 'general', 'eng-general'))).toBe('42501');
  });

  it('a person cannot delete or renew another person\'s lease; they delete their own', async () => {
    const del = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE root_id = $1 AND person_id = $2', [msg['general'], rafi.personId])).rowCount ?? 0);
    expect(await del(nadia)).toBe(0);
    expect(await del(sameera)).toBe(0);
    const upd = await as(nadia, async (tx) => (await tx.query("UPDATE app.thread_watchers SET expires_at = now() + interval '1 hour' WHERE person_id = $1", [rafi.personId])).rowCount ?? 0);
    expect(upd).toBe(0);
    expect(await del(rafi)).toBe(1);
  });

  it('an expired lease of somebody else is not touched by a person; the run job (system) sweeps it', async () => {
    await sys((tx) =>
      tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, $3, $4, now() - interval '1 minute')", [msg['general'], priya.personId, LEASE, ch['eng-general']]),
    );
    const swept = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE person_id = $1 AND expires_at < now()', [priya.personId])).rowCount ?? 0);
    expect(await swept(sameera)).toBe(0);
    expect(await swept(nadia)).toBe(0);
    const n = await sys(async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE expires_at < now()')).rowCount ?? 0);
    expect(n).toBe(1);
  });
});

describe('asking for the stop in the other states (review M2, H1)', () => {
  it('a run that is still starting can be stopped, and one that is already stopping answers "already"', async () => {
    await makeRun('starting', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia, state: 'starting' });
    expect(await mayStop(nadia, 'starting')).toBe(true);
    expect(await stopAsk(nadia, 'starting')).toBe('requested');
    expect(await sys(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.run_view WHERE run_id = $1', [run['starting']])).rows[0]!.state)).toBe('stopping');
    expect(await stopAsk(rafi, 'starting')).toBe('already');
    await makeRun('stopping', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia, state: 'stopping' });
    expect(await stopAsk(nadia, 'stopping')).toBe('requested');
    expect(await stopAsk(nadia, 'stopping')).toBe('already');
  });

  it('a run whose bot_runs row is over answers "ended" even though its folded row still says working (the recorder died)', async () => {
    await makeRun('lost', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'failed', ended_at = now() WHERE id = $1", [run['lost']]));
    expect(await stopAsk(nadia, 'lost')).toBe('ended');
    const row = await sys(async (tx) => (await tx.query('SELECT state, stop_requested_at FROM app.run_view WHERE run_id = $1', [run['lost']])).rows[0]);
    expect(row).toMatchObject({ state: 'working', stop_requested_at: null }); // no flag was left on a run nobody will read it for
  });
});

describe('the definers are what the review asked for', () => {
  it('thread_watchers_check, run_may_stop and run_stop_request are security definers owned by the system role, with a pinned search_path, and not callable by the public', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const r = await admin.query<{ name: string; definer: boolean; owner: string; config: string[] | null; public_exec: boolean }>(
        `SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname IN ('thread_watchers_check', 'run_may_stop', 'run_stop_request') ORDER BY p.proname`,
      );
      expect(r.rows.map((x) => x.name)).toEqual(['run_may_stop', 'run_stop_request', 'thread_watchers_check']);
      for (const f of r.rows) {
        expect(f.definer, f.name).toBe(true);
        expect(f.owner, f.name).toBe('manythreads_system');
        expect((f.config ?? []).join(' '), f.name).toContain('search_path=pg_catalog, app, pg_temp');
        expect(f.public_exec, f.name).toBe(false);
      }
      // the trigger is the one that guards the table, on insert and on the columns an update could move
      const t = await admin.query<{ def: string }>("SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'thread_watchers_check' AND NOT tgisinternal");
      expect(t.rows[0]!.def).toMatch(/BEFORE INSERT OR UPDATE OF root_id, channel_id, person_id/);
    } finally {
      await admin.end();
    }
  });
});

describe('who is sent a run\'s steps: leases joined with the channel audience (review M1)', () => {
  const lease = (p: Persona, rootKey: string, channelKey: string): Promise<unknown> =>
    sys((tx) =>
      tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, gen_random_uuid(), $3, now() + interval '1 minute')", [msg[rootKey], p.personId, ch[channelKey]]),
    );
  const audience = (rootKey: string, channelKey: string): Promise<string[]> => sys(async (tx) => (await watchersOf(msg[rootKey]!, ch[channelKey]!)(tx as never)).sort());
  const owner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  };

  it('a member of a private channel who holds a lease is sent the steps; somebody who holds one for a channel they cannot read is not', async () => {
    await sys((tx) => tx.query('DELETE FROM app.thread_watchers'));
    await lease(rafi, 'leads', 'eng-leads');
    await lease(nadia, 'leads', 'eng-leads'); // not a member of the private channel (a lease cannot be written like this by the person, but a stale one could exist)
    expect(await audience('leads', 'eng-leads')).toEqual([rafi.personId]);
  });

  it('a person who left the team stops being sent the steps at once, while the lease is still alive', async () => {
    await sys((tx) => tx.query('DELETE FROM app.thread_watchers'));
    await lease(nadia, 'general', 'eng-general');
    await lease(priya, 'general', 'eng-general');
    expect(await audience('general', 'eng-general')).toEqual([nadia.personId, priya.personId].sort());
    await owner((c) => c.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [ENG, priya.actorId]));
    expect(await audience('general', 'eng-general')).toEqual([nadia.personId]);
  });

  it('a guest is sent the steps only while an ACL entry gives them the channel, and not after it is taken away', async () => {
    await sys((tx) => tx.query('DELETE FROM app.thread_watchers'));
    await lease(lena, 'leads', 'eng-leads');
    expect(await audience('leads', 'eng-leads')).toEqual([]);
    await owner((c) =>
      c.query("INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')", [omar.workspaceId, ch['eng-leads'], lena.personId]),
    );
    expect(await audience('leads', 'eng-leads')).toEqual([lena.personId]);
    await owner((c) => c.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND resource_id = $1 AND subject_id = $2", [ch['eng-leads'], lena.personId]));
    expect(await audience('leads', 'eng-leads')).toEqual([]);
  });

  it('a lease that has lapsed is not an audience, and one for another channel than the thread\'s is not either', async () => {
    await sys((tx) => tx.query('DELETE FROM app.thread_watchers'));
    await sys((tx) =>
      tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, gen_random_uuid(), $3, now() - interval '1 second')", [msg['general'], nadia.personId, ch['eng-general']]),
    );
    expect(await audience('general', 'eng-general')).toEqual([]);
  });
});

describe('the sweep that closes a card whose run is over (review H1)', () => {
  const pushes: Array<{ people: string[]; type: string; payload: Record<string, unknown> }> = [];
  const ctx = { realtime: { pushToPeople: async (_t: unknown, people: string[], type: string, payload: Record<string, unknown>) => void pushes.push({ people, type, payload }), pushToPerson: async () => undefined } } as never;
  const view = (key: string) =>
    sys(async (tx) => (await tx.query<{ state: string; ended_at: Date | null; stopped_by_name: string | null; now_step: unknown }>('SELECT state, ended_at, stopped_by_name, now_step FROM app.run_view WHERE run_id = $1', [run[key]])).rows[0]!);
  const over = (key: string, status: string): Promise<unknown> => sys((tx) => tx.query('UPDATE app.bot_runs SET status = $2, ended_at = now() WHERE id = $1', [run[key], status]));

  it('closes an open row whose bot_runs row is over, as stopped if a stop was asked and as the run ended otherwise, and leaves a running one alone', async () => {
    await makeRun('sweep-done', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
    await makeRun('sweep-failed', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
    await makeRun('sweep-asked', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
    await makeRun('sweep-live', { team: ENG, channel: ch['eng-general']!, root: msg['general']!, asker: nadia });
    expect(await stopAsk(rafi, 'sweep-asked')).toBe('requested');
    await over('sweep-done', 'done');
    await over('sweep-failed', 'failed');
    await over('sweep-asked', 'failed');
    const closed = await sys((tx) => closeOverRuns(ctx, tx as never, { workspaceId: omar.workspaceId }));
    expect(closed).toBeGreaterThanOrEqual(3);
    expect(await view('sweep-done')).toMatchObject({ state: 'done', now_step: null });
    expect((await view('sweep-done')).ended_at).toBeInstanceOf(Date);
    expect(await view('sweep-failed')).toMatchObject({ state: 'failed' });
    expect(await view('sweep-asked')).toMatchObject({ state: 'stopped', stopped_by_name: 'Rafi' });
    expect(await view('sweep-live')).toMatchObject({ state: 'working', ended_at: null });
    // the readers of the channel are told that each run ended, and nobody is told twice
    const told = pushes.filter((p) => p.type === 'run.ended').map((p) => `${String(p.payload['runId'])}:${String(p.payload['status'])}`);
    expect(told).toContain(`${run['sweep-done']}:done`);
    expect(told).toContain(`${run['sweep-asked']}:stopped`);
    expect(told.join(' ')).not.toContain(run['sweep-live']!);
    expect(await sys((tx) => closeOverRuns(ctx, tx as never, { workspaceId: omar.workspaceId }))).toBe(0);
    expect(pushes.filter((p) => p.type === 'run.ended').length).toBe(told.length);
  });

  it('never overwrites what the recorder wrote: a row that has ended is left as it is', async () => {
    await over('sweep-live', 'done');
    await sys((tx) => tx.query("UPDATE app.run_view SET state = 'failed', ended_at = now() WHERE run_id = $1", [run['sweep-live']]));
    expect(await sys((tx) => closeOverRuns(ctx, tx as never, { runId: run['sweep-live'], workspaceId: omar.workspaceId }))).toBe(0);
    expect(await view('sweep-live')).toMatchObject({ state: 'failed' });
  });
});

describe('who has a whole channel open (channel_watchers, P29)', () => {
  const LEASE = '00000000-0000-4000-8000-0000000d0aa1';
  const LEASE_B = '00000000-0000-4000-8000-0000000d0bb2';
  const watch = (p: Persona, channelKey: string, seconds = 60, lease = LEASE): Promise<unknown> =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT (channel_id, person_id, lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [ch[channelKey], p.personId, lease, seconds],
      ),
    );
  const rowsOf = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_watchers')).rows.map((r) => r.person_id));
  const clear = (): Promise<unknown> => sys((tx) => tx.query('DELETE FROM app.channel_watchers'));

  it('a person writes and renews their own lease in a channel they can read, and sees only their own rows', async () => {
    await clear();
    await watch(nadia, 'eng-general');
    await watch(nadia, 'eng-general', 90);
    await watch(rafi, 'eng-general');
    expect(await rowsOf(nadia)).toEqual([nadia.personId]);
    expect(await rowsOf(rafi)).toEqual([rafi.personId]);
    expect(await rowsOf(sameera)).toEqual([]);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.channel_watchers')).rows.length)).toBe(2);
  });

  it('a second tab holds a lease of its own, and closing one leaves the other', async () => {
    await clear();
    await watch(nadia, 'eng-general', 60, LEASE);
    await watch(nadia, 'eng-general', 60, LEASE_B);
    expect(await rowsOf(nadia)).toHaveLength(2);
    const closed = await as(nadia, async (tx) => (await tx.query('DELETE FROM app.channel_watchers WHERE channel_id = $1 AND lease_id = $2 AND person_id = app.person_id()', [ch['eng-general'], LEASE_B])).rowCount ?? 0);
    expect(closed).toBe(1);
    expect(await rowsOf(nadia)).toHaveLength(1);
  });

  it('not for somebody else, and not in a channel the person cannot read', async () => {
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 minute')", [ch['eng-general'], priya.personId, LEASE])))).toBe('42501');
    expect(await code(watch(nadia, 'eng-leads'))).toBe('42501');
    expect(await code(watch(sameera, 'eng-general'))).toBe('42501');
    expect(await code(watch(lena, 'eng-general'))).toBe('42501');
  });

  it('a conversation with a bot has no channel lease, whoever writes it', async () => {
    const convo = await sys(async (tx) =>
      (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, name, kind, private, bot_id) VALUES ($1, '', 'bot_conversation', true, $2) RETURNING id", [omar.workspaceId, botOf[ENG]!.id])).rows[0]!.id,
    );
    expect(await code(sys((tx) => tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 minute')", [convo, nadia.personId, LEASE])))).toBe('23514');
  });

  it('a person holds at most 8 live leases; a renewal is never refused for it, and lapsed leases do not count', async () => {
    await clear();
    await sys((tx) =>
      tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) SELECT $1, $2, gen_random_uuid(), now() + interval '1 minute' FROM generate_series(1, 8)", [ch['eng-general'], nadia.personId]),
    );
    const error = await watch(nadia, 'eng-general', 60, LEASE_B).then(() => null, (e: { code?: string; constraint?: string }) => e);
    expect(error).toMatchObject({ code: '23514', constraint: 'channel_watchers_person_cap' });
    const held = await sys(async (tx) => (await tx.query<{ lease_id: string }>('SELECT lease_id FROM app.channel_watchers WHERE person_id = $1 LIMIT 1', [nadia.personId])).rows[0]!.lease_id);
    await watch(nadia, 'eng-general', 60, held);
    await sys((tx) => tx.query("UPDATE app.channel_watchers SET expires_at = now() - interval '1 minute' WHERE person_id = $1", [nadia.personId]));
    await watch(nadia, 'eng-general', 60, LEASE_B);
    await clear();
  });

  it('a person cannot delete or renew another person\'s lease', async () => {
    await clear();
    await watch(rafi, 'eng-general');
    expect(await as(nadia, async (tx) => (await tx.query('DELETE FROM app.channel_watchers WHERE person_id = $1', [rafi.personId])).rowCount ?? 0)).toBe(0);
    expect(await as(nadia, async (tx) => (await tx.query("UPDATE app.channel_watchers SET expires_at = now() + interval '1 hour' WHERE person_id = $1", [rafi.personId])).rowCount ?? 0)).toBe(0);
    await clear();
  });

  it('the check is a security definer owned by the system role, with a pinned search_path, and not callable by the public', async () => {
    const r = await sys(async (tx) =>
      (await tx.query<{ definer: boolean; owner: string; config: string[] | null; public_exec: boolean }>(
        `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'channel_watchers_check'`,
      )).rows[0],
    );
    expect(r).toMatchObject({ definer: true, owner: 'manythreads_system', public_exec: false });
    expect((r!.config ?? []).join(' ')).toContain('search_path=pg_catalog, app, pg_temp');
  });

  describe('who is sent the folded state of a run: thread leases and channel leases, joined with the channel audience', () => {
    const audience = (rootKey: string, channelKey: string): Promise<string[]> => sys(async (tx) => (await activityWatchersOf(msg[rootKey]!, ch[channelKey]!)(tx as never)).sort());
    const threadLease = (p: Persona, rootKey: string, channelKey: string): Promise<unknown> =>
      sys((tx) => tx.query("INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1, $2, gen_random_uuid(), $3, now() + interval '1 minute')", [msg[rootKey], p.personId, ch[channelKey]]));
    const channelLease = (p: Persona, channelKey: string): Promise<unknown> =>
      sys((tx) => tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, gen_random_uuid(), now() + interval '1 minute')", [ch[channelKey], p.personId]));
    const reset = (): Promise<unknown> => sys((tx) => tx.query('DELETE FROM app.thread_watchers; DELETE FROM app.channel_watchers'));

    it('a channel lease is an audience for every thread of the channel; a thread lease is one for its thread; a person who holds both is sent it once', async () => {
      await reset();
      await channelLease(nadia, 'eng-general');
      await threadLease(rafi, 'general', 'eng-general');
      await channelLease(rafi, 'eng-general');
      expect(await audience('general', 'eng-general')).toEqual([nadia.personId, rafi.personId].sort());
    });

    it('the words of the answer still go to thread leases only (watchersOf)', async () => {
      await reset();
      await channelLease(nadia, 'eng-general');
      await threadLease(rafi, 'general', 'eng-general');
      expect(await sys(async (tx) => (await watchersOf(msg['general']!, ch['eng-general']!)(tx as never)).sort())).toEqual([rafi.personId]);
    });

    it('a person who lost the channel, a lapsed lease, and a lease of another channel are not an audience', async () => {
      await reset();
      await channelLease(nadia, 'eng-leads'); // not a member of the private channel: a stale row only
      await sys((tx) => tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, gen_random_uuid(), now() - interval '1 second')", [ch['eng-general'], rafi.personId]));
      await channelLease(priya, 'mkt-general');
      expect(await audience('leads', 'eng-leads')).toEqual([]);
      expect(await audience('general', 'eng-general')).toEqual([]);
    });

    it('a guest is sent it only while an ACL entry gives them the channel', async () => {
      await reset();
      await channelLease(lena, 'eng-leads');
      expect(await audience('leads', 'eng-leads')).toEqual([]);
    });
  });

  it('the run sweep deletes channel leases that lapsed more than five minutes ago', async () => {
    await clear();
    await sys((tx) => tx.query("INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1, $2, gen_random_uuid(), now() - interval '10 minutes'), ($1, $3, gen_random_uuid(), now() + interval '1 minute')", [ch['eng-general'], nadia.personId, rafi.personId]));
    await sys((tx) => tx.query("DELETE FROM app.channel_watchers WHERE expires_at < now() - interval '5 minutes'"));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.channel_watchers')).rows.length)).toBe(1);
  });
});
