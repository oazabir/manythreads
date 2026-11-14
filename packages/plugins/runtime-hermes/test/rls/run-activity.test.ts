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
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [omar.workspaceId, botOf[o.team]!.id, o.team, conversation ? 'conversation' : 'mention', o.asker.actorId, ended ? 'done' : 'running', ended ? new Date() : null],
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
      for (const table of ['run_view', 'run_activity', 'thread_watchers']) {
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
           FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('app.run_view'::regclass, 'app.run_activity'::regclass, 'app.thread_watchers'::regclass)`,
      );
      const found = r.rows.map((x) => `${x.rel}>${x.target}:${x.del}`).sort();
      expect(found).toEqual(
        [
          'app.run_activity>app.bot_runs:c',
          'app.run_activity>app.channels:c',
          'app.run_view>app.bot_runs:c',
          'app.run_view>app.channels:c',
          'app.run_view>app.messages:c',
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
  const watch = (p: Persona, rootKey: string, channelKey: string, seconds = 60): Promise<unknown> =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.thread_watchers (root_id, person_id, channel_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT (root_id, person_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [msg[rootKey], p.personId, ch[channelKey], seconds],
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

  it('not for somebody else, and not in a channel the person cannot read', async () => {
    expect(
      await code(as(nadia, (tx) => tx.query('INSERT INTO app.thread_watchers (root_id, person_id, channel_id, expires_at) VALUES ($1, $2, $3, now() + interval \'1 minute\')', [msg['general'], priya.personId, ch['eng-general']]))),
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
      tx.query("INSERT INTO app.thread_watchers (root_id, person_id, channel_id, expires_at) VALUES ($1, $2, $3, now() - interval '1 minute')", [msg['general'], priya.personId, ch['eng-general']]),
    );
    const swept = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE person_id = $1 AND expires_at < now()', [priya.personId])).rowCount ?? 0);
    expect(await swept(sameera)).toBe(0);
    expect(await swept(nadia)).toBe(0);
    const n = await sys(async (tx) => (await tx.query('DELETE FROM app.thread_watchers WHERE expires_at < now()')).rowCount ?? 0);
    expect(n).toBe(1);
  });
});
