import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
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

// P5-20: who may read an approval and its decision, who may write them, and the two doors that do. The rows exist through the system role;
// every assertion runs as a persona through the app pool, which is what a request is.

const { omar, nadia, rafi, priya, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (e: { code?: string }) => e.code);

let engApproval = '';
let runId = '';
let botId = '';
let engLeadsApproval = '';
let mktApproval = '';

const insert = (team: string, requester: string, scope: object, summary: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, resume, approver_scope, requester_id)
           VALUES ($1, $2, 'grant', 'pages.write', $3, '{"path":"pages/x.md"}', '{"kind":"tool","capability":"pages.write","args":{"secret":"real"},"trigger":"mention"}', $4, $5)
           RETURNING id`,
          [omar.workspaceId, team, summary, JSON.stringify(scope), requester],
        )
      ).rows[0]!.id,
  );

const visible = (p: Persona): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ summary: string }>('SELECT summary FROM app.approvals ORDER BY summary')).rows.map((r) => r.summary));

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  // a bot of Engineering with a run Nadia asked for: what a request names
  runId = await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'asker', 'Asker', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    botId = bot.rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, bot.rows[0]!.id]);
    const run = await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'mention', $4, 'running') RETURNING id`,
      [omar.workspaceId, bot.rows[0]!.id, ENG, nadia.actorId],
    );
    return run.rows[0]!.id;
  });
  // Nadia asked for all three; Rafi holds role:on-call, Nadia holds role:release-owner (neither is a lead)
  engApproval = await insert(ENG, nadia.actorId, { roles: ['role:on-call', 'role:release-owner'], people: [], leads: false }, 'eng: on-call decides');
  engLeadsApproval = await insert(ENG, nadia.actorId, { roles: [], people: [], leads: true }, 'eng: leads decide');
  mktApproval = await insert(MKT, tariq.actorId, { roles: [], people: [], leads: true }, 'mkt: leads decide');
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('approvals and approval_decisions (P5-20)', () => {
  it('passes the RLS harness: forced, with a policy and an rls comment on both tables', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('reads without a per-row policy helper (the team visibility set is hoisted)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      for (const table of ['approvals', 'approval_decisions']) {
        expect(await findPerRowPolicyCalls(admin, table), `per-row calls in ${table}`).toEqual([]);
      }
    } finally {
      await admin.end();
    }
  });

  it('an approval is readable by the people of its team and by a workspace admin, by nobody else', async () => {
    const eng = ['eng: leads decide', 'eng: on-call decides'];
    expect(await visible(nadia)).toEqual(eng);
    expect(await visible(rafi)).toEqual(eng);
    expect(await visible(priya)).toEqual([...eng, 'mkt: leads decide'].sort()); // Priya is on both teams
    expect(await visible(omar)).toEqual([...eng, 'mkt: leads decide'].sort()); // a workspace admin reads every team
    expect(await visible(tariq)).toEqual(['mkt: leads decide']);
    expect(await visible(sameera)).toEqual([]); // Customer support only
    expect(await visible(lena)).toEqual([]); // a guest has no team
  });

  it('the request role reads every column but the one that holds the call\'s real arguments', async () => {
    expect(await code(as(rafi, (tx) => tx.query('SELECT resume FROM app.approvals LIMIT 1')))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('SELECT dedupe_key FROM app.approvals LIMIT 1')))).toBe('42501');
    const cols = await as(rafi, (tx) => tx.query('SELECT id, args_preview, resume_kind, approver_scope FROM app.approvals LIMIT 1'));
    expect(cols.rows).toHaveLength(1);
    expect(await sys(async (tx) => (await tx.query<{ resume: { args: { secret: string } } }>('SELECT resume FROM app.approvals WHERE id = $1', [engApproval])).rows[0]?.resume.args.secret)).toBe('real');
  });

  it('nobody writes the tables directly: not the lead, not the admin, not the requester', async () => {
    for (const who of [omar, nadia, rafi]) {
      expect(await code(as(who, (tx) => tx.query("UPDATE app.approvals SET status = 'approved'")))).toBe('42501');
      expect(await code(as(who, (tx) => tx.query('DELETE FROM app.approvals')))).toBe('42501');
      expect(
        await code(
          as(who, (tx) =>
            tx.query(
              `INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decision) VALUES ($1, $2, $3, $4, 'approved')`,
              [engApproval, omar.workspaceId, ENG, who.actorId],
            ),
          ),
        ),
      ).toBe('42501');
    }
  });

  it('filing an approval needs the run\'s own bot or the system: a person, even the asker, is refused', async () => {
    const file = (p: Persona) =>
      as(p, (tx) => tx.query("SELECT * FROM app.approvals_request($1, 'grant', 'pages.write', 's', '{}', false, '{\"kind\":\"handoff\",\"payload\":{}}', NULL, NULL)", [runId]));
    expect(await code(file(nadia))).toBe('42501');
    expect(await code(file(omar))).toBe('42501');
    // the system role files it: the bot, the team and the asker are read from the run
    const filed = await sys(async (tx) => (await tx.query<{ o_team_id: string; o_requester_id: string; o_bot_id: string }>(
      "SELECT * FROM app.approvals_request($1, 'dlp', 'llm.call', 's', '{}', false, '{\"kind\":\"handoff\",\"payload\":{}}', ARRAY['role:on-call'], 'k')",
      [runId],
    )).rows[0]);
    expect(filed).toMatchObject({ o_team_id: ENG, o_requester_id: nadia.actorId });
    expect(await code(sys((tx) => tx.query("SELECT * FROM app.approvals_request('00000000-0000-7000-8000-00000000ffff', 'grant', 't', 's', '{}', false, '{\"kind\":\"handoff\",\"payload\":{}}', NULL, NULL)")))).toBe('23503');
  });

  it('the decide function says who may and who may not, with the reason', async () => {
    const reason = (p: Persona, id: string): Promise<string | null> =>
      as(p, async (tx) => (await tx.query<{ r: string | null }>('SELECT app.approvals_block_reason($1) AS r', [id])).rows[0]!.r);
    // named role tags decide; the requester never does, even holding a named tag; a lead is not a named approver
    expect(await reason(rafi, engApproval)).toBeNull();
    expect(await reason(nadia, engApproval)).toBe('requester');
    expect(await reason(omar, engApproval)).toBe('not_approver');
    expect(await reason(priya, engApproval)).toBe('not_approver');
    // an approval of a team the caller cannot read answers like a missing one: the function is no way to probe another team's ids
    expect(await reason(sameera, engApproval)).toBe('not_found');
    expect(await reason(lena, engApproval)).toBe('not_found');
    // no approver named: the team's leads and workspace admins
    expect(await reason(omar, engLeadsApproval)).toBeNull();
    expect(await reason(rafi, engLeadsApproval)).toBe('not_approver');
    expect(await reason(tariq, mktApproval)).toBe('requester'); // Tariq leads Marketing and asked
    expect(await reason(omar, mktApproval)).toBeNull(); // a workspace admin decides in every team
    expect(await reason(omar, '00000000-0000-7000-8000-00000000ffff')).toBe('not_found');
  });

  it('a decision is written by the door only, once, and approving queues the stopped action', async () => {
    const decide = (p: Persona, id: string, decision: string) => as(p, (tx) => tx.query('SELECT app.approvals_decide($1, $2, $3)', [id, decision, 'ok']));
    expect(await code(decide(nadia, engApproval, 'approved'))).toBe('42501'); // the requester
    expect(await code(decide(omar, engApproval, 'approved'))).toBe('42501'); // not named
    expect(await code(decide(rafi, engApproval, 'maybe'))).toBe('22023');
    await decide(rafi, engApproval, 'approved');
    const row = await sys(
      async (tx) =>
        (
          await tx.query<{ status: string; outcome: string; decided_at: Date | null; decision: string; decider_id: string; note: string }>(
            `SELECT a.status, a.outcome, a.decided_at, d.decision, d.decider_id, d.note
               FROM app.approvals a JOIN app.approval_decisions d ON d.approval_id = a.id WHERE a.id = $1`,
            [engApproval],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({ status: 'approved', outcome: 'queued', decision: 'approved', decider_id: rafi.actorId, note: 'ok' });
    expect(row?.decided_at).not.toBeNull();
    // settled: a second decision, either way, finds it settled
    expect(await code(decide(rafi, engApproval, 'denied'))).toBe('55000');
    expect(await code(decide(rafi, engApproval, 'approved'))).toBe('55000');
    // and denying one leaves nothing to run
    await decide(omar, engLeadsApproval, 'denied');
    expect(await sys(async (tx) => (await tx.query<{ status: string; outcome: string }>('SELECT status, outcome FROM app.approvals WHERE id = $1', [engLeadsApproval])).rows[0])).toEqual({
      status: 'denied',
      outcome: 'none',
    });
    // the decision is readable with its team
    expect(await as(priya, async (tx) => (await tx.query('SELECT 1 FROM app.approval_decisions')).rows.length)).toBe(2);
    expect(await as(sameera, async (tx) => (await tx.query('SELECT 1 FROM app.approval_decisions')).rows.length)).toBe(0);
  });

  it('the table\'s own checks: a settled approval has a time, an unapproved one has no outcome', async () => {
    expect(await code(sys((tx) => tx.query("UPDATE app.approvals SET status = 'pending', decided_at = now() WHERE id = $1", [mktApproval])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.approvals SET outcome = 'ran' WHERE id = $1", [mktApproval])))).toBe('23514');
  });
});

describe('what an approval is made of stays in its conversation (P5-20 review)', () => {
  let priv = '';
  let dm = '';
  let privApproval = '';
  let privLeads = '';
  let dmApproval = '';
  let publicApproval = '';

  beforeAll(async () => {
    await sys(async (tx) => {
      const channel = async (sql: string, params: unknown[]): Promise<string> => (await tx.query<{ id: string }>(sql, params)).rows[0]!.id;
      priv = await channel(
        "INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'secret', 'channel', true) RETURNING id",
        [omar.workspaceId, ENG],
      );
      dm = await channel(
        "INSERT INTO app.channels (workspace_id, name, kind, private, dm_key) VALUES ($1, '', 'dm', true, 'nadia:omar') RETURNING id",
        [omar.workspaceId],
      );
      for (const [channelId, person] of [[priv, nadia], [priv, rafi], [dm, nadia], [dm, omar]] as const) {
        await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [channelId, person.personId]);
      }
    });
    const file = (summary: string, scope: object, channelId: string | null) =>
      sys(
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, resume, approver_scope, requester_id, channel_id)
               VALUES ($1, $2, 'dlp', 'llm.call', $3, '{"message":"salary for [redacted:card-number]"}', '{"kind":"handoff","payload":{}}', $4, $5, $6) RETURNING id`,
              [omar.workspaceId, ENG, summary, JSON.stringify(scope), nadia.actorId, channelId],
            )
          ).rows[0]!.id,
      );
    publicApproval = await file('chan: public', { roles: ['role:on-call'], people: [], leads: false }, null);
    privApproval = await file('chan: private', { roles: ['role:on-call'], people: [], leads: false }, priv);
    privLeads = await file('chan: private leads', { roles: [], people: [], leads: true }, priv);
    dmApproval = await file('chan: dm', { roles: [], people: [], leads: true }, dm);
  });

  const mine = (p: Persona): Promise<string[]> =>
    as(p, async (tx) => (await tx.query<{ summary: string }>("SELECT summary FROM app.approvals WHERE summary LIKE 'chan:%' ORDER BY summary")).rows.map((r) => r.summary));
  const reason = (p: Persona, id: string): Promise<string | null> =>
    as(p, async (tx) => (await tx.query<{ r: string | null }>('SELECT app.approvals_block_reason($1) AS r', [id])).rows[0]!.r);

  it('an approval raised in a private channel or a DM is read by that conversation\'s people, not by the rest of the team', async () => {
    // Nadia is in both; Rafi only in the private channel; Omar (a lead and admin) only in the DM; Priya in neither
    expect(await mine(nadia)).toEqual(['chan: dm', 'chan: private', 'chan: private leads', 'chan: public']);
    expect(await mine(rafi)).toEqual(['chan: private', 'chan: private leads', 'chan: public']);
    expect(await mine(omar)).toEqual(['chan: dm', 'chan: public']);
    expect(await mine(priya)).toEqual(['chan: public']);
    expect(await mine(sameera)).toEqual([]);
  });

  it('the decision rule asks the same question: an approver who cannot read the channel cannot decide', async () => {
    // named tag, and a member of the private channel
    expect(await reason(rafi, privApproval)).toBeNull();
    // a lead of the team, named by "no one named", but not in the private channel or the DM's other half: the approval is not theirs to see
    expect(await reason(omar, privLeads)).toBe('not_found');
    expect(await reason(priya, privApproval)).toBe('not_found');
    // in the DM Omar is a participant and a lead: he may decide what Nadia's DM raised
    expect(await reason(omar, dmApproval)).toBeNull();
    expect(await reason(rafi, dmApproval)).toBe('not_found');
    // the public one is unchanged
    expect(await reason(rafi, publicApproval)).toBeNull();
    expect(await reason(priya, publicApproval)).toBe('not_approver');
  });

  it('a thread query for a conversation the caller is not in answers nothing, whatever id it names', async () => {
    await sys((tx) => tx.query("UPDATE app.approvals SET thread_root_id = '00000000-0000-7000-8000-00000000f00d' WHERE id = $1", [privApproval]));
    const rows = (p: Persona) => as(p, async (tx) => (await tx.query("SELECT id FROM app.approvals WHERE thread_root_id = '00000000-0000-7000-8000-00000000f00d'")).rows.length);
    expect(await rows(rafi)).toBe(1);
    expect(await rows(priya)).toBe(0);
    expect(await rows(omar)).toBe(0);
  });

  it('the full call is the deciders\' alone', async () => {
    await sys((tx) => tx.query(`UPDATE app.approvals SET resume = '{"kind":"tool","capability":"llm.call","args":{"a":1},"trigger":"mention"}' WHERE id = $1`, [publicApproval]));
    const full = (p: Persona) => as(p, async (tx) => (await tx.query<{ a: unknown }>('SELECT app.approvals_full_args($1) AS a', [publicApproval])).rows[0]!.a);
    expect(await full(rafi)).toEqual({ a: 1 });
    for (const who of [nadia, priya, omar, sameera]) expect(await code(full(who))).toBe('42501');
  });

  it('a tool approval names the capability it will make, and only that', async () => {
    const insertTool = (tool: string) =>
      sys((tx) =>
        tx.query(
          `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, resume, approver_scope, requester_id)
           VALUES ($1, $2, 'grant', $3, 'mismatch', '{"kind":"tool","capability":"pages.write","args":{},"trigger":"mention"}', '{"roles":[],"people":[],"leads":true}', $4)`,
          [omar.workspaceId, ENG, tool, nadia.actorId],
        ),
      );
    expect(await code(insertTool('email.send'))).toBe('23514');
    expect(await code(insertTool('pages.write'))).toBeUndefined();
  });

  it('the same pending call is one approval per asker (a second asker is not folded into the first)', async () => {
    const dup = (requester: string) =>
      sys((tx) =>
        tx.query(
          `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, resume, approver_scope, requester_id, bot_id, dedupe_key)
           VALUES ($1, $2, 'dlp', 'llm.call', 'dup', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $3, $4, 'dup-k')`,
          [omar.workspaceId, ENG, requester, botId],
        ),
      );
    expect(await code(dup(nadia.actorId))).toBeUndefined();
    expect(await code(dup(nadia.actorId))).toBe('23505'); // the same asker twice
    expect(await code(dup(omar.actorId))).toBeUndefined(); // a different asker
  });
});

describe('review round 3', () => {
  it('a hidden approval and a missing one look the same, and every id gets an answer', async () => {
    const missing = '00000000-0000-7000-8000-00000000f00e';
    const rows = await as(sameera, async (tx) => (await tx.query<{ o_id: string; o_reason: string | null }>('SELECT o_id, o_reason FROM app.approvals_block_reasons(ARRAY[$1::uuid, $2::uuid])', [engApproval, missing])).rows);
    expect(rows.map((r) => r.o_reason)).toEqual(['not_found', 'not_found']);
    expect(rows.map((r) => r.o_id).sort()).toEqual([engApproval, missing].sort());
  });

  it('deleting a channel deletes the approvals raised in it: they never become the team\'s', async () => {
    const channel = await sys(async (tx) =>
      (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'gone-soon', 'channel', true) RETURNING id", [omar.workspaceId, ENG])).rows[0]!.id,
    );
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, resume, approver_scope, requester_id, channel_id)
         VALUES ($1, $2, 'dlp', 'llm.call', 'cascade', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $3, $4)`,
        [omar.workspaceId, ENG, nadia.actorId, channel],
      ),
    );
    await sys((tx) => tx.query('DELETE FROM app.channels WHERE id = $1', [channel]));
    expect(await sys(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.approvals WHERE summary = 'cascade'")).rows[0]?.n)).toBe(0);
  });

  it('the schema-wide CREATE the definer functions needed while they were handed over is taken back', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect((await admin.query<{ ok: boolean }>("SELECT has_schema_privilege('manythreads_system', 'app', 'CREATE') AS ok")).rows[0]?.ok).toBe(false);
    } finally {
      await admin.end();
    }
  });
});
