import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-13, the database half: the narrowest-source rule (`app.run_retain_verdict`) as a matrix, its one reader for a live run
// (`app.memory_run_scope`), the same rule for what a bot wrote (`app.memory_authored_verdict`), and who may read and write `memory_retain_log`.
// Rows exist through the system role; every request-side assertion runs as a persona or as a bot through the app pool.

const { omar, nadia, rafi, tariq, priya, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let botId = '';
let botActorId = '';
let pubEngChannel = '';
let privEngChannel = '';
let pubMktChannel = '';
let dmChannel = '';
let pubEngMessage = '';
let privEngMessage = '';
let pubMktMessage = '';
let dmMessage = '';
let pubEngFile = '';
let privEngFile = '';
let pubThreadRoot = '';
let privThreadRoot = '';

const channel = (team: string | null, name: string, kind: 'channel' | 'dm', priv: boolean): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [omar.workspaceId, team, name, kind, priv, kind === 'dm' ? `${nadia.actorId}:${rafi.actorId}` : null],
        )
      ).rows[0]!.id,
  );

const message = (channelId: string, body: string, author: string = nadia.actorId): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          'INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4) RETURNING id',
          [omar.workspaceId, channelId, author, body],
        )
      ).rows[0]!.id,
  );

const file = (channelId: string, name: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
           VALUES ($1, $2, '/files/', $3, $4, 1, 'text/plain', repeat('a', 64), $5) RETURNING id`,
          [omar.workspaceId, channelId, name, `blob-${name}`, nadia.actorId],
        )
      ).rows[0]!.id,
  );

interface RunOptions {
  trigger?: string;
  channelId?: string | null;
  threadId?: string | null;
  asker?: string | null;
  status?: 'running' | 'done';
  startedAt?: string;
  endedAt?: string | null;
}

const run = (lines: ReadonlyArray<readonly [string, string, string]>, options: RunOptions = {}): Promise<string> =>
  sys(async (tx) => {
    const status = options.status ?? 'running';
    // Both instants come from the one statement's clock (`now()` is the transaction's), so a run never ends before it started whatever the
    // clocks of the test process and the database say; an explicit `startedAt`/`endedAt` is used as given.
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, thread_id, channel_id, status, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()),
                 CASE WHEN $8 = 'running' THEN NULL ELSE coalesce($10::timestamptz, greatest(now(), coalesce($9::timestamptz, now()))) END)
         RETURNING id`,
        [
          omar.workspaceId,
          botId,
          ENG,
          options.trigger ?? 'mention',
          options.asker === undefined ? nadia.actorId : options.asker,
          options.threadId ?? null,
          options.channelId ?? null,
          status,
          options.startedAt ?? null,
          options.endedAt ?? null,
        ],
      )
    ).rows[0]!.id;
    for (const [i, [type, ref, scope]] of lines.entries()) {
      await tx.query('INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, $2, $3, $4, $5)', [id, i, type, ref, scope]);
    }
    return id;
  });

interface Verdict {
  retain_refusal: string | null;
  narrowest_scope: string;
  source_lines: number;
  source_scopes: string[];
}
const verdictOf = (runId: string): Promise<Verdict> =>
  sys(async (tx) => (await tx.query<Verdict>('SELECT * FROM app.run_retain_verdict($1)', [runId])).rows[0]!);

/** What `app.memory_run_scope()` says to the run's own bot, called the way the kernel calls anything: inside withActor, which sets app.run_id. */
const scopeAsBot = async (runId: string): Promise<{ retain_refusal: string | null } | undefined> =>
  withActor({ kind: 'bot', id: botActorId, workspaceId: omar.workspaceId, runId } as never, async (tx) => (await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.memory_run_scope()')).rows[0], { pool: appPool });

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
    ],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'memo', 'Memo', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    botId = bot.rows[0]!.id;
    botActorId = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId])).rows[0]!.id;
  });
  pubEngChannel = await channel(ENG, 'dev', 'channel', false);
  privEngChannel = await channel(ENG, 'war-room', 'channel', true);
  pubMktChannel = await channel(MKT, 'launch', 'channel', false);
  dmChannel = await channel(null, '', 'dm', true);
  pubEngMessage = await message(pubEngChannel, 'The cache TTL is 60 seconds.');
  privEngMessage = await message(privEngChannel, 'Layoffs are planned for June.');
  pubMktMessage = await message(pubMktChannel, 'Launch is on the ninth.');
  dmMessage = await message(dmChannel, 'Between the two of us.');
  pubEngFile = await file(pubEngChannel, 'public.txt');
  privEngFile = await file(privEngChannel, 'private.txt');
  pubThreadRoot = pubEngMessage;
  privThreadRoot = privEngMessage;
  await sys(async (tx) => {
    await tx.query('INSERT INTO app.threads (root_message_id, channel_id) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [pubThreadRoot, pubEngChannel, privThreadRoot, privEngChannel]);
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the narrowest-source rule: app.run_retain_verdict(run)', () => {
  const NIL = '00000000-0000-7000-8000-000000000000';

  // [name, lines (type, ref-key, scope), run options (keys resolved below), expected refusal, expected narrowest scope]
  type Ref = 'pubMsg' | 'privMsg' | 'mktMsg' | 'dmMsg' | 'pubFile' | 'privFile' | 'nil' | 'garbage' | 'bank';
  type Case = {
    name: string;
    lines: ReadonlyArray<readonly [string, Ref, string]>;
    options?: { trigger?: string; channel?: 'pub' | 'priv' | 'dm'; thread?: 'pub' | 'priv' };
    refusal: string | null;
    narrowest: 'team' | 'channel' | 'person';
  };
  const matrix: Case[] = [
    { name: 'reads nothing', lines: [], refusal: null, narrowest: 'team' },
    { name: 'reads only the team memory bank (scope team)', lines: [['memory', 'bank', 'team']], refusal: null, narrowest: 'team' },
    { name: 'reads a message of a public channel of its own team', lines: [['message', 'pubMsg', 'channel']], refusal: null, narrowest: 'team' },
    { name: 'reads that message mislabelled `team` (a label is a claim)', lines: [['message', 'pubMsg', 'team']], refusal: null, narrowest: 'team' },
    { name: 'reads a message of a PRIVATE channel', lines: [['message', 'privMsg', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a private message mislabelled `team` (0001 let this through)', lines: [['message', 'privMsg', 'team']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a direct message', lines: [['message', 'dmMsg', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a direct message mislabelled `team`', lines: [['message', 'dmMsg', 'team']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads another team’s public message', lines: [['message', 'mktMsg', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a message that does not exist', lines: [['message', 'nil', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a ref that is not even an id', lines: [['message', 'garbage', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a file of a public channel of its team', lines: [['file', 'pubFile', 'channel']], refusal: null, narrowest: 'team' },
    { name: 'reads a file of a private channel', lines: [['file', 'privFile', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a team file (no channel, labelled team)', lines: [['file', 'nil', 'team']], refusal: null, narrowest: 'team' },
    { name: 'reads a file nobody knows under a channel label', lines: [['file', 'nil', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a source of an unknown type under a channel label', lines: [['thread', 'pubMsg', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'reads a source of an unknown type labelled team', lines: [['page', 'garbage', 'team']], refusal: null, narrowest: 'team' },
    { name: 'reads a person-scoped source', lines: [['drive', 'garbage', 'person']], refusal: 'person_source', narrowest: 'person' },
    { name: 'reads team sources AND a person-scoped one (the narrowest wins)', lines: [['memory', 'bank', 'team'], ['message', 'pubMsg', 'channel'], ['drive', 'garbage', 'person']], refusal: 'person_source', narrowest: 'person' },
    { name: 'reads public sources AND one private one (the narrowest wins)', lines: [['memory', 'bank', 'team'], ['message', 'pubMsg', 'channel'], ['message', 'privMsg', 'channel']], refusal: 'private_source', narrowest: 'channel' },
    { name: 'is a conversation run, reading nothing', lines: [], options: { trigger: 'conversation' }, refusal: 'conversation', narrowest: 'person' },
    { name: 'answers in a private channel', lines: [], options: { channel: 'priv' }, refusal: 'private_channel', narrowest: 'channel' },
    { name: 'answers in a DM', lines: [], options: { channel: 'dm' }, refusal: 'private_channel', narrowest: 'channel' },
    { name: 'answers in a public channel of its team', lines: [], options: { channel: 'pub' }, refusal: null, narrowest: 'team' },
    { name: 'was started in a thread of a private channel', lines: [], options: { thread: 'priv' }, refusal: 'private_thread', narrowest: 'channel' },
    { name: 'was started in a thread of a public channel', lines: [], options: { thread: 'pub' }, refusal: null, narrowest: 'team' },
    { name: 'a person source beats a conversation trigger as the reason', lines: [['drive', 'garbage', 'person']], options: { trigger: 'conversation' }, refusal: 'person_source', narrowest: 'person' },
  ];

  it.each(matrix)('$name', async ({ lines, options, refusal, narrowest }) => {
    const refs: Record<Ref, string> = {
      pubMsg: pubEngMessage,
      privMsg: privEngMessage,
      mktMsg: pubMktMessage,
      dmMsg: dmMessage,
      pubFile: pubEngFile,
      privFile: privEngFile,
      nil: NIL,
      garbage: 'not-an-id',
      bank: 'bank:team:kahf:engineering',
    };
    const channels = { pub: pubEngChannel, priv: privEngChannel, dm: dmChannel };
    const threads = { pub: pubThreadRoot, priv: privThreadRoot };
    const id = await run(
      lines.map(([type, ref, scope]) => [type, refs[ref], scope] as const),
      {
        ...(options?.trigger ? { trigger: options.trigger } : {}),
        ...(options?.channel ? { channelId: channels[options.channel] } : {}),
        ...(options?.thread ? { threadId: threads[options.thread] } : {}),
      },
    );
    const v = await verdictOf(id);
    expect(v.retain_refusal).toBe(refusal);
    expect(v.narrowest_scope).toBe(narrowest);
    expect(v.source_lines).toBe(lines.length);
    expect(v.source_scopes).toEqual([...new Set(lines.map((l) => l[2]))].sort());
    // `memory.retain` reads the very same decision (the live run's own door).
    expect((await scopeAsBot(id))?.retain_refusal).toBe(refusal);
  });

  it('an unknown run has no verdict', async () => {
    expect(await sys(async (tx) => (await tx.query('SELECT * FROM app.run_retain_verdict($1)', [NIL])).rows)).toEqual([]);
  });

  it('is not reachable from the request role, nor is the one for authored text', async () => {
    const id = await run([]);
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.run_retain_verdict($1)', [id])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.memory_authored_verdict($1, now())', [botActorId])))).toBe('42501');
    // the retain log door is callable, but a person who is not a live run's bot or asker gets no line
    expect(await as(omar, async (tx) => (await tx.query<{ n: number }>("SELECT app.memory_retain_log_run('retained', 'b', ARRAY['d']) AS n")).rows[0]?.n)).toBe(0);
  });

  it('memory_run_scope is empty once the run has closed, and for a person who is not its asker', async () => {
    const id = await run([], { status: 'done' });
    expect(await scopeAsBot(id)).toBeUndefined();
    const live = await run([]);
    const other = await withActor({ kind: 'person', id: rafi.actorId, workspaceId: omar.workspaceId, runId: live } as never, async (tx) => (await tx.query('SELECT * FROM app.memory_run_scope()')).rows, { pool: appPool });
    expect(other).toEqual([]);
    const asker = await withActor({ kind: 'person', id: nadia.actorId, workspaceId: omar.workspaceId, runId: live } as never, async (tx) => (await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.memory_run_scope()')).rows, { pool: appPool });
    expect(asker).toEqual([{ retain_refusal: null }]);
  });
});

describe('what a bot wrote: app.memory_authored_verdict(bot actor, at)', () => {
  // Fixed instants in 2020 (nothing else in this file ran then), so the runs of the matrix above, which started "now", never cover them.
  const verdict = (at: string) =>
    sys(async (tx) => (await tx.query<{ run_open: boolean; retain_refusal: string | null; runs: number }>('SELECT * FROM app.memory_authored_verdict($1, $2::timestamptz)', [botActorId, at])).rows[0]!);

  it('is clean, and counts no run, when the bot had none open at that moment', async () => {
    expect(await verdict('2019-01-01T00:00:00.000Z')).toEqual({ run_open: false, retain_refusal: null, runs: 0 });
  });

  it('a closed run covers its own interval (and two seconds either side) and no other', async () => {
    await run([['message', pubEngMessage, 'channel'], ['message', privEngMessage, 'channel']], {
      startedAt: '2020-03-01T10:00:00.000Z',
      status: 'done',
      endedAt: '2020-03-01T10:05:00.000Z',
    });
    expect(await verdict('2020-03-01T10:02:00.000Z')).toEqual({ run_open: false, retain_refusal: 'private_source', runs: 1 });
    expect(await verdict('2020-03-01T10:05:01.000Z')).toMatchObject({ retain_refusal: 'private_source', runs: 1 }); // git dates have one-second resolution
    expect(await verdict('2020-03-01T10:30:00.000Z')).toEqual({ run_open: false, retain_refusal: null, runs: 0 });
  });

  it('a run that has not ended covers every instant since its start, however long (a 3 h run that read a person source), up to a day back', async () => {
    await run([['drive', 'x', 'person']], { startedAt: '2020-04-01T09:00:00.000Z', status: 'running' });
    // inside the first two hours, and at hour three and after: the run is still open and its refusal applies
    expect(await verdict('2020-04-01T10:30:00.000Z')).toEqual({ run_open: true, retain_refusal: 'person_source', runs: 1 });
    expect(await verdict('2020-04-01T12:30:00.000Z')).toEqual({ run_open: true, retain_refusal: 'person_source', runs: 1 });
    expect(await verdict('2020-04-01T08:00:00.000Z')).toMatchObject({ runs: 0 }); // before it started
    // more than a day after its start the lookup no longer reaches it (a lost worker holds text back for a day at most)
    expect(await verdict('2020-04-02T09:30:00.000Z')).toMatchObject({ runs: 0, retain_refusal: null });
  });

  it('says a run is still going while a fresh one is open, and takes its refusal', async () => {
    const id = await run([['drive', 'x', 'person']], { status: 'running' });
    const now = await sys(async (tx) =>
      (await tx.query<{ run_open: boolean; retain_refusal: string | null }>('SELECT run_open, retain_refusal FROM app.memory_authored_verdict($1, now())', [botActorId])).rows[0]!,
    );
    expect(now).toEqual({ run_open: true, retain_refusal: expect.any(String) });
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [id]));
  });

  it('a bot that no longer exists is refused: its runs went with it, so what it wrote must not read as "outside a run"', async () => {
    const gone = await sys(async (tx) => {
      const bot = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'short-lived', 'Short lived', '', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot])).rows[0]!.id;
      const runId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at, ended_at)
           VALUES ($1, $2, $3, 'mention', $4, 'done', '2016-05-01T10:00:00Z', '2016-05-01T10:05:00Z') RETURNING id`,
          [omar.workspaceId, bot, ENG, nadia.actorId],
        )
      ).rows[0]!.id;
      await tx.query("INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 0, 'drive', 'x', 'person')", [runId]);
      return { bot, actor };
    });
    const at = '2016-05-01T10:02:00.000Z';
    const ask = () =>
      sys(async (tx) => (await tx.query<{ retain_refusal: string | null; runs: number }>('SELECT retain_refusal, runs FROM app.memory_authored_verdict($1, $2::timestamptz)', [gone.actor, at])).rows[0]!);
    expect(await ask()).toEqual({ retain_refusal: 'person_source', runs: 1 });
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [gone.bot]));
    expect(await ask()).toEqual({ retain_refusal: 'bot_removed', runs: 0 });
  });

  it('is for a bot actor only: a person actor id has no runs', async () => {
    const res = await sys(async (tx) => (await tx.query<{ runs: number }>('SELECT runs FROM app.memory_authored_verdict($1, now())', [nadia.actorId])).rows[0]!);
    expect(res.runs).toBe(0);
  });
});

describe('memory_retain_log and memory_feed_pending: who reads, who writes', () => {
  let engLine = '';
  let mktLine = '';

  const insertLine = (team: string, outcome: string, reason = ''): Promise<string> =>
    sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason)
             VALUES ($1, $2, 'team:kahf:x', 'message', $3, $4, $5) RETURNING id`,
            [omar.workspaceId, team, `src-${Math.random()}`, outcome, reason],
          )
        ).rows[0]!.id,
    );

  beforeAll(async () => {
    engLine = await insertLine(ENG, 'retained');
    mktLine = await insertLine(MKT, 'withheld', 'person_source');
  });

  const visible = (p: Persona): Promise<string[]> =>
    as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.memory_retain_log WHERE id = ANY($1) ORDER BY id', [[engLine, mktLine]])).rows.map((r) => r.id));

  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['memory_retain_log', 'memory_feed_pending']) expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('is readable by the leads of the team and by a workspace admin, not by members, other teams’ leads or guests', async () => {
    expect(await visible(omar)).toEqual([engLine, mktLine].sort()); // a workspace admin reads every team
    expect(await visible(tariq)).toEqual([mktLine]); // the lead of Marketing
    for (const p of [nadia, rafi, priya, lena]) expect(await visible(p), p.key).toEqual([]);
  });

  it('nobody writes it from a request: not an admin, not a lead, not a member', async () => {
    for (const who of [omar, tariq, nadia]) {
      expect(
        await code(
          as(who, (tx) =>
            tx.query(`INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome) VALUES ($1, $2, 'b', 'message', 'x', 'retained')`, [omar.workspaceId, ENG]),
          ),
        ),
        who.key,
      ).toBe('42501');
      expect(await code(as(who, (tx) => tx.query("UPDATE app.memory_retain_log SET reason = 'x'"))), who.key).toBe('42501');
      expect(await code(as(who, (tx) => tx.query('DELETE FROM app.memory_retain_log'))), who.key).toBe('42501');
    }
  });

  it('is append-only for the system role as well', async () => {
    expect(await code(sys((tx) => tx.query("UPDATE app.memory_retain_log SET reason = 'edited'")))).toBe('42501');
    expect(await code(sys((tx) => tx.query('DELETE FROM app.memory_retain_log WHERE id = $1', [engLine])))).toBe('42501');
  });

  it('refuses a value outside the vocabulary (outcome, kind, store, scopes) and a source id of no length', async () => {
    const bad = (cols: string, vals: unknown[]) =>
      code(sys((tx) => tx.query(`INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, ${cols}) VALUES ($1, $2, 'b', ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [omar.workspaceId, ENG, ...vals])));
    expect(await bad('source_kind, source_id, outcome', ['message', 'x', 'kept'])).toBe('23514');
    expect(await bad('source_kind, source_id, outcome', ['mail', 'x', 'retained'])).toBe('23514');
    expect(await bad('source_kind, source_id, outcome', ['message', '', 'retained'])).toBe('23514');
    expect(await bad('source_kind, source_id, outcome, store', ['message', 'x', 'retained', 'cloud'])).toBe('23514');
    expect(await bad('source_kind, source_id, outcome, source_scopes', ['message', 'x', 'retained', ['workspace']])).toBe('23514');
  });

  it('the work list is the platform’s: no privilege for the request role, not even a select', async () => {
    await sys((tx) => tx.query("INSERT INTO app.memory_feed_pending (source_kind, source_id, workspace_id) VALUES ('message', 'x', $1)", [omar.workspaceId]));
    for (const who of [omar, nadia]) {
      expect(await code(as(who, (tx) => tx.query('SELECT * FROM app.memory_feed_pending'))), who.key).toBe('42501');
      expect(await code(as(who, (tx) => tx.query("INSERT INTO app.memory_feed_pending (source_kind, source_id, workspace_id) VALUES ('message', 'y', $1)", [omar.workspaceId]))), who.key).toBe('42501');
    }
  });

  it('a run’s own memory.retain door writes for a live run only, and says what it knew', async () => {
    const id = await run([['message', privEngMessage, 'channel']]);
    const wrote = await withActor({ kind: 'bot', id: botActorId, workspaceId: omar.workspaceId, runId: id } as never, async (tx) => {
      const refused = (await tx.query<{ n: number }>("SELECT app.memory_retain_log_run('withheld', 'team:kahf:engineering', ARRAY[]::text[]) AS n")).rows[0]!.n;
      const retained = (await tx.query<{ n: number }>("SELECT app.memory_retain_log_run('retained', 'team:kahf:engineering', ARRAY['run:x:1', 'run:x:2']) AS n")).rows[0]!.n;
      return { refused, retained };
    }, { pool: appPool });
    expect(wrote).toEqual({ refused: 1, retained: 2 });
    // asking again is not a second line: one refusal per run, however often the model retries
    const again = await withActor({ kind: 'bot', id: botActorId, workspaceId: omar.workspaceId, runId: id } as never, async (tx) => (await tx.query<{ n: number }>("SELECT app.memory_retain_log_run('withheld', 'team:kahf:engineering', ARRAY[]::text[]) AS n")).rows[0]!.n, { pool: appPool });
    expect(again).toBe(0);
    const rows = await sys(async (tx) =>
      (await tx.query<{ source_kind: string; outcome: string; reason: string; source_scopes: string[]; run_id: string }>(
        "SELECT source_kind, outcome, reason, source_scopes, run_id FROM app.memory_retain_log WHERE run_id = $1 ORDER BY id", [id])).rows);
    expect(rows).toEqual([
      { source_kind: 'run_tool', outcome: 'withheld', reason: 'private_source', source_scopes: ['channel'], run_id: id },
      { source_kind: 'run_tool', outcome: 'retained', reason: '', source_scopes: ['channel'], run_id: id },
      { source_kind: 'run_tool', outcome: 'retained', reason: '', source_scopes: ['channel'], run_id: id },
    ]);
    // a closed run writes nothing
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [id]));
    const after = await withActor({ kind: 'bot', id: botActorId, workspaceId: omar.workspaceId, runId: id } as never, async (tx) => (await tx.query<{ n: number }>("SELECT app.memory_retain_log_run('retained', 'b', ARRAY['d']) AS n")).rows[0]!.n, { pool: appPool });
    expect(after).toBe(0);
  });
});
