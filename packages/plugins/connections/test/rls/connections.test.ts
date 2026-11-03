import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  connectionsMigrationSource,
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// P8-01 and, in the last two describes, P8-29/P8-30 (the mailbox and the claims of the inbox trigger): who may see a connection (a team's to the people of the team, a workspace's to its admins, a person's to that person alone), who may set one up, that a
// credential row is unreachable to every person-facing role, and the rules the database keeps whatever the code does (a grant names a connection of its own team and
// a bot that is a member of it; a secret belongs to the connection's workspace; nobody forges `has_credentials`).

const { omar, nadia, priya, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const asActor = <T>(actorId: string, kind: 'person' | 'bot', fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind, id: actorId as never, workspaceId: omar.workspaceId as never }, fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const sysAny = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const slugsOf = (p: Persona): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.connections ORDER BY slug')).rows.map((r) => r.slug));

const insertConnection = (tx: Tx, f: { team: string | null; slug: string; scope: 'team' | 'person' | 'workspace'; owner: string; kind?: string; ws?: string }): Promise<{ id: string }> =>
  tx
    .query<{ id: string }>(
      `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, $3, $4, $3, $5, $6) RETURNING id`,
      [f.ws ?? omar.workspaceId, f.team, f.slug, f.kind ?? 'email', f.scope, f.owner],
    )
    .then((r) => r.rows[0]!);

const ids: Record<string, string> = {};
let botEng: string;
let botMkt: string;
let otherWs: { workspace: string; team: string; actor: string };

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource, connectionsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  await sys(async (tx) => {
    ids.eng = (await insertConnection(tx, { team: ENG, slug: 'support-mail', scope: 'team', owner: omar.actorId })).id;
    ids.mkt = (await insertConnection(tx, { team: MKT, slug: 'press-mail', scope: 'team', owner: omar.actorId })).id;
    ids.ws = (await insertConnection(tx, { team: null, slug: 'company-drive', scope: 'workspace', owner: omar.actorId })).id;
    ids.nadia = (await insertConnection(tx, { team: null, slug: 'nadia-mail', scope: 'person', owner: nadia.actorId })).id;
    ids.omar = (await insertConnection(tx, { team: null, slug: 'omar-mail', scope: 'person', owner: omar.actorId })).id;
    // a bot on each team: an actor and its membership (the bots plugin's rows, without the bots table)
    for (const [key, team] of [['botEng', ENG], ['botMkt', MKT]] as const) {
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actor, omar.workspaceId]);
      ids[key] = actor;
    }
    botEng = ids.botEng!;
    botMkt = ids.botMkt!;
    await tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.read'), ($1, $2, $3, $4, 'email.send')`, [omar.workspaceId, ids.eng, ENG, botEng]);
    await tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.read')`, [omar.workspaceId, ids.mkt, MKT, botMkt]);
  });

  // a second workspace with its own team, person and connection: nothing of it may ever show in the first
  otherWs = await sysAny(async (tx) => {
    const workspace = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other-ws', 'Other') RETURNING id`)).rows[0]!.id;
    const team = (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'other-team', 'Other team') RETURNING id`, [workspace])).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [workspace, randomUUID()])).rows[0]!.id;
    await insertConnection(tx, { team, slug: 'other-mail', scope: 'team', owner: actor, ws: workspace });
    return { workspace, team, actor };
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const TABLES = ['connections', 'connection_grants', 'connection_secrets', 'connection_messages', 'connection_mail_claims', 'connection_oauth_apps', 'connection_oauth_app_secrets'];

describe('connections tables follow the RLS rules', () => {
  it('pass the harness and read without a per-row policy helper', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of TABLES) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
      const rls = await client.query<{ relname: string; force: boolean; enabled: boolean }>(
        `SELECT relname, relforcerowsecurity AS force, relrowsecurity AS enabled FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relname = ANY ($1)`,
        [TABLES],
      );
      expect(rls.rows).toHaveLength(TABLES.length);
      for (const row of rls.rows) expect(row, row.relname).toMatchObject({ force: true, enabled: true });
    } finally {
      await client.end();
    }
  });
});

describe('who reads a connection', () => {
  it('a team connection is read by the people of its team; a person connection only by its owner', async () => {
    expect(await slugsOf(nadia)).toEqual(['nadia-mail', 'support-mail']);
    expect(await slugsOf(tariq)).toEqual(['press-mail']);
    // priya is on both teams
    expect(await slugsOf(priya)).toEqual(['press-mail', 'support-mail']);
  });

  it('a workspace connection is read by workspace admins alone, and an admin reads every team’s but not another person’s own', async () => {
    expect(await slugsOf(omar)).toEqual(['company-drive', 'omar-mail', 'press-mail', 'support-mail']);
    for (const person of [nadia, tariq, priya]) expect(await slugsOf(person), person.name).not.toContain('company-drive');
  });

  it('someone on no team, and a guest, read nothing (not even a connection that names them nowhere)', async () => {
    expect(await slugsOf(sameera)).toEqual([]);
    expect(await slugsOf(lena)).toEqual([]);
  });

  it('nothing of another workspace is ever visible, to an admin either', async () => {
    expect(await slugsOf(omar)).not.toContain('other-mail');
    const stranger = await withActor({ kind: 'person', id: otherWs.actor as never, workspaceId: otherWs.workspace as never }, async (tx) => (await tx.query('SELECT slug FROM app.connections')).rows, { pool: appPool });
    // a person of the other workspace reads nothing of it either until they are on that team (no membership row here)
    expect(stranger).toEqual([]);
  });

  it('a bot reads the connections of its own team and no other', async () => {
    const eng = await asActor(botEng, 'bot', async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.connections ORDER BY slug')).rows.map((r) => r.slug));
    expect(eng).toEqual(['support-mail']);
    const mkt = await asActor(botMkt, 'bot', async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.connections ORDER BY slug')).rows.map((r) => r.slug));
    expect(mkt).toEqual(['press-mail']);
  });
});

describe('who sets up a connection', () => {
  const insertAs = (p: Persona, f: Parameters<typeof insertConnection>[1]): Promise<string | undefined> => code(as(p, (tx) => insertConnection(tx, f)));

  it('a workspace admin sets up a team or workspace connection; a team lead, a member and a guest do not', async () => {
    expect(await insertAs(omar, { team: ENG, slug: 'second-mail', scope: 'team', owner: omar.actorId })).toBeUndefined();
    expect(await insertAs(omar, { team: null, slug: 'second-drive', scope: 'workspace', owner: omar.actorId })).toBeUndefined();
    for (const person of [nadia, tariq, sameera, lena]) {
      expect(await insertAs(person, { team: MKT, slug: `try-${person.key}`, scope: 'team', owner: person.actorId }), person.name).toBe('42501');
      expect(await insertAs(person, { team: null, slug: `ws-${person.key}`, scope: 'workspace', owner: person.actorId }), person.name).toBe('42501');
    }
  });

  it('a person sets up their own, and cannot set one up for somebody else', async () => {
    expect(await insertAs(nadia, { team: null, slug: 'nadia-calendar', scope: 'person', owner: nadia.actorId })).toBeUndefined();
    expect(await insertAs(nadia, { team: null, slug: 'as-omar', scope: 'person', owner: omar.actorId })).toBe('42501');
  });

  it('a new connection is off and holds no credential, and cannot be created claiming one', async () => {
    const row = await sys(async (tx) => (await tx.query<{ status: string; has_credentials: boolean }>('SELECT status, has_credentials FROM app.connections WHERE id = $1', [ids.eng])).rows[0]);
    expect(row).toEqual({ status: 'disabled', has_credentials: false });
    expect(
      await code(as(omar, (tx) => tx.query(`INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id, has_credentials) VALUES ($1, $2, 'forged', 'email', 'f', 'team', $3, true)`, [omar.workspaceId, ENG, omar.actorId]))),
    ).toBe('42501');
  });

  it('an admin switches a team connection on and sets its end date and environment; a member’s change does nothing', async () => {
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connections SET status = 'enabled', environment = 'staging', expires_at = now() + interval '30 days' WHERE id = $1`, [ids.eng])))).toBeUndefined();
    const after = await sys(async (tx) => (await tx.query<{ status: string; environment: string }>('SELECT status, environment FROM app.connections WHERE id = $1', [ids.eng])).rows[0]);
    expect(after).toEqual({ status: 'enabled', environment: 'staging' });
    // nadia sees the row but the write policy filters it: zero rows, no error, no change
    const changed = await as(nadia, async (tx) => (await tx.query(`UPDATE app.connections SET status = 'disabled' WHERE id = $1 RETURNING id`, [ids.eng])).rows.length);
    expect(changed).toBe(0);
    const still = await sys(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.connections WHERE id = $1', [ids.eng])).rows[0]);
    expect(still?.status).toBe('enabled');
    // the owner of a person connection switches it
    expect(await as(nadia, async (tx) => (await tx.query(`UPDATE app.connections SET status = 'enabled' WHERE id = $1 RETURNING id`, [ids.nadia])).rows.length)).toBe(1);
    expect(await as(omar, async (tx) => (await tx.query(`UPDATE app.connections SET status = 'enabled' WHERE id = $1 RETURNING id`, [ids.nadia])).rows.length)).toBe(0);
  });

  it('what a connection is cannot be changed: scope, team, owner, kind, short name, workspace and the credential flag', async () => {
    for (const set of [`scope = 'workspace', team_id = NULL`, `team_id = '${MKT}'`, `owner_id = '${nadia.actorId}'`, `kind = 'drive'`, `slug = 'renamed'`, 'has_credentials = true']) {
      expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connections SET ${set} WHERE id = $1`, [ids.eng]))), set).toMatch(/^(42501|23514)$/);
    }
  });

  it('only the system role deletes a connection (so its credentials are removed first)', async () => {
    const gone = await as(omar, async (tx) => (await tx.query(`DELETE FROM app.connections WHERE id = $1 RETURNING id`, [ids.mkt])).rows.length);
    expect(gone).toBe(0);
    expect(await slugsOf(tariq)).toEqual(['press-mail']);
  });

  it('the database refuses what the policy cannot see: a short name used twice on a team, a team of another workspace, an owner of another workspace', async () => {
    expect(await code(sys((tx) => insertConnection(tx, { team: ENG, slug: 'support-mail', scope: 'team', owner: omar.actorId })))).toBe('23505');
    // the same short name on another team is fine
    expect(await code(sys((tx) => insertConnection(tx, { team: MKT, slug: 'support-mail', scope: 'team', owner: omar.actorId })))).toBeUndefined();
    expect(await code(sys((tx) => insertConnection(tx, { team: otherWs.team, slug: 'crossed', scope: 'team', owner: omar.actorId })))).toBe('23514');
    expect(await code(sys((tx) => insertConnection(tx, { team: ENG, slug: 'foreign-owner', scope: 'team', owner: otherWs.actor })))).toBe('23514');
    // a team connection needs a team and any other does not have one
    expect(await code(sys((tx) => insertConnection(tx, { team: null, slug: 'no-team', scope: 'team', owner: omar.actorId })))).toBe('23514');
    expect(await code(sys((tx) => insertConnection(tx, { team: ENG, slug: 'team-on-person', scope: 'person', owner: omar.actorId })))).toBe('23514');
    // a person connection is owned by a person, never a bot
    expect(await code(sys((tx) => insertConnection(tx, { team: null, slug: 'bot-owned', scope: 'person', owner: botEng })))).toBe('23514');
    // shape of the short name and the kind
    expect(await code(sys((tx) => insertConnection(tx, { team: ENG, slug: 'Bad Slug', scope: 'team', owner: omar.actorId })))).toBe('23514');
    expect(await code(sys((tx) => insertConnection(tx, { team: ENG, slug: 'odd-kind', scope: 'team', owner: omar.actorId, kind: 'Email!' })))).toBe('23514');
  });
});

describe('connection grants', () => {
  const grantsOf = (p: Persona): Promise<string[]> =>
    as(p, async (tx) => (await tx.query<{ t: string }>(`SELECT g.tool || '@' || c.slug AS t FROM app.connection_grants g JOIN app.connections c ON c.id = g.connection_id ORDER BY 1`)).rows.map((r) => r.t));

  it('are read by the people of the team they belong to, and by nobody else', async () => {
    expect(await grantsOf(nadia)).toEqual(['email.read@support-mail', 'email.send@support-mail']);
    expect(await grantsOf(tariq)).toEqual(['email.read@press-mail']);
    expect(await grantsOf(sameera)).toEqual([]);
    expect(await grantsOf(lena)).toEqual([]);
    const own = await asActor(botEng, 'bot', async (tx) => (await tx.query('SELECT 1 FROM app.connection_grants')).rows.length);
    expect(own).toBe(2);
  });

  it('are written by the system role alone: not a workspace admin, not a lead, not the bot itself', async () => {
    const row = `INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.draft')`;
    const args = [omar.workspaceId, ids.eng, ENG, botEng];
    expect(await code(as(omar, (tx) => tx.query(row, args)))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(row, args)))).toBe('42501');
    expect(await code(asActor(botEng, 'bot', (tx) => tx.query(row, args)))).toBe('42501');
    // the application role has no UPDATE or DELETE on it at all
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.connection_grants`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connection_grants SET needs_approval = true`)))).toBe('42501');
  });

  it('can only name a connection of their own team, and a bot that is a member of that team', async () => {
    const grant = (connection: string, team: string, actor: string, tool = 'email.draft') =>
      sys((tx) => tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, $5)`, [omar.workspaceId, connection, team, actor, tool]));
    // Marketing's bot, Engineering's connection (under either team id)
    expect(await code(grant(ids.eng!, ENG, botMkt))).toBe('23503');
    expect(await code(grant(ids.eng!, MKT, botMkt))).toBe('23503');
    // a person's or the workspace's connection has no team to grant within
    expect(await code(grant(ids.nadia!, ENG, botEng))).toBe('23503');
    expect(await code(grant(ids.ws!, ENG, botEng))).toBe('23503');
    // the right pair works
    expect(await code(grant(ids.eng!, ENG, botEng))).toBeUndefined();
  });

  it('allow one exact tool, once per bot', async () => {
    const tool = (t: string) => sys((tx) => tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, $5)`, [omar.workspaceId, ids.eng, ENG, botEng, t]));
    expect(await code(tool('email.*'))).toBe('23514');
    expect(await code(tool('send'))).toBe('23514');
    expect(await code(tool('email.read'))).toBe('23505');
  });

  it('go when the bot leaves the team, and when the connection goes', async () => {
    const extra = await sys(async (tx) => {
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actor, omar.workspaceId]);
      await tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.read')`, [omar.workspaceId, ids.eng, ENG, actor]);
      return actor;
    });
    const count = (): Promise<number> => sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_grants WHERE actor_id = $1', [extra])).rows.length);
    expect(await count()).toBe(1);
    await sys((tx) => tx.query('DELETE FROM app.team_members WHERE actor_id = $1', [extra]));
    expect(await count()).toBe(0);
    // a grant is a row in the connection's team: removing the connection removes its grants
    const doomed = await sys((tx) => insertConnection(tx, { team: ENG, slug: 'doomed', scope: 'team', owner: omar.actorId }));
    await sys((tx) => tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, extra, omar.workspaceId]));
    await sys((tx) => tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.read')`, [omar.workspaceId, doomed.id, ENG, extra]));
    await sys((tx) => tx.query('DELETE FROM app.connections WHERE id = $1', [doomed.id]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_grants WHERE connection_id = $1', [doomed.id])).rows.length)).toBe(0);
  });
});

describe('connection secrets', () => {
  const seal = (tx: Tx, workspace: string | null): Promise<string> =>
    tx
      .query<{ id: string }>(`INSERT INTO app.secrets (ciphertext, wrapped_key, key_id, workspace_id) VALUES ('\\x00', '\\x00', 'test', $1) RETURNING id`, [workspace])
      .then((r) => r.rows[0]!.id);

  it('no person-facing role can read, count or list them: the application role has no privilege on the table at all', async () => {
    const secret = await sys(async (tx) => {
      const id = await seal(tx, omar.workspaceId);
      await tx.query(`INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, 'password', $3)`, [omar.workspaceId, ids.eng, id]);
      return id;
    });
    for (const person of [omar, nadia, tariq, sameera, lena]) {
      expect(await code(as(person, (tx) => tx.query('SELECT 1 FROM app.connection_secrets'))), person.name).toBe('42501');
      expect(await code(as(person, (tx) => tx.query('SELECT count(*) FROM app.connection_secrets'))), person.name).toBe('42501');
      expect(await code(as(person, (tx) => tx.query(`INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, 'x', $3)`, [omar.workspaceId, ids.eng, secret]))), person.name).toBe('42501');
      // and the sealed row behind it is the system's too
      expect(await code(as(person, (tx) => tx.query('SELECT 1 FROM app.secrets'))), person.name).toBe('42501');
    }
    expect(await code(asActor(botEng, 'bot', (tx) => tx.query('SELECT 1 FROM app.connection_secrets')))).toBe('42501');
  });

  it('keep the connection’s has_credentials flag true while one is stored, and nobody else can set it', async () => {
    const flag = (): Promise<boolean> => sys(async (tx) => (await tx.query<{ f: boolean }>('SELECT has_credentials AS f FROM app.connections WHERE id = $1', [ids.eng])).rows[0]!.f);
    expect(await flag()).toBe(true);
    // what a person reads of the connection says only that something is stored
    const seen = await as(nadia, async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.connections WHERE id = $1', [ids.eng])).rows[0]!);
    expect(seen.has_credentials).toBe(true);
    expect(Object.keys(seen).filter((k) => /secret|password|token|credential/.test(k) && k !== 'has_credentials')).toEqual([]);
    await sys((tx) => tx.query('DELETE FROM app.connection_secrets WHERE connection_id = $1', [ids.eng]));
    expect(await flag()).toBe(false);
  });

  it('take the sealed value with them when the row goes, also when a connection, a team or a workspace is removed and the rows go by cascade', async () => {
    const exists = (id: string): Promise<boolean> => sysAny(async (tx) => (await tx.query('SELECT 1 FROM app.secrets WHERE id = $1', [id])).rows.length > 0);
    const withSecret = async (tx: Tx, connectionId: string, workspace: string): Promise<string> => {
      const id = await seal(tx, workspace);
      await tx.query(`INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, 'password', $3)`, [workspace, connectionId, id]);
      return id;
    };
    // the row itself
    const direct = await sys(async (tx) => withSecret(tx, (await insertConnection(tx, { team: ENG, slug: 'reap-direct', scope: 'team', owner: omar.actorId })).id, omar.workspaceId));
    expect(await exists(direct)).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.connection_secrets WHERE secret_id = $1`, [direct]));
    expect(await exists(direct)).toBe(false);
    // the connection (cascade to its credential rows)
    const byConnection = await sys(async (tx) => withSecret(tx, (await insertConnection(tx, { team: ENG, slug: 'reap-conn', scope: 'team', owner: omar.actorId })).id, omar.workspaceId));
    expect(await exists(byConnection)).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.connections WHERE slug = 'reap-conn'`));
    expect(await exists(byConnection)).toBe(false);
    // the team (cascade to its connections, then to their credential rows)
    const byTeam = await sys(async (tx) => {
      const team = (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'reap-team', 'Reap team') RETURNING id`, [omar.workspaceId])).rows[0]!.id;
      return withSecret(tx, (await insertConnection(tx, { team, slug: 'reap-team-mail', scope: 'team', owner: omar.actorId })).id, omar.workspaceId);
    });
    expect(await exists(byTeam)).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.teams WHERE slug = 'reap-team'`));
    expect(await exists(byTeam)).toBe(false);
    // the whole workspace
    const byWorkspace = await sysAny(async (tx) => {
      const workspace = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('reap-ws', 'Reap') RETURNING id`)).rows[0]!.id;
      const team = (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'reap-ws-team', 'Reap') RETURNING id`, [workspace])).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [workspace, randomUUID()])).rows[0]!.id;
      const connection = await insertConnection(tx, { team, slug: 'reap-ws-mail', scope: 'team', owner: actor, ws: workspace });
      return withSecret(tx, connection.id, workspace);
    });
    expect(await exists(byWorkspace)).toBe(true);
    await sysAny((tx) => tx.query(`DELETE FROM app.workspaces WHERE slug = 'reap-ws'`));
    expect(await exists(byWorkspace)).toBe(false);
  });

  it('refuse a secret of another workspace, a missing secret and a second credential of the same name', async () => {
    const foreign = await sysAny((tx) => seal(tx, otherWs.workspace));
    const insert = (secret: string, name = 'password') =>
      sys((tx) => tx.query(`INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, $3, $4)`, [omar.workspaceId, ids.eng, name, secret]));
    expect(await code(insert(foreign))).toBe('23514');
    expect(await code(insert(randomUUID()))).toMatch(/^(23514|23503)$/);
    const mine = await sys((tx) => seal(tx, omar.workspaceId));
    expect(await code(insert(mine))).toBeUndefined();
    expect(await code(insert(await sys((tx) => seal(tx, omar.workspaceId))))).toBe('23505');
    expect(await code(insert(await sys((tx) => seal(tx, omar.workspaceId)), 'Bad Name'))).toBe('23514');
  });
});

// P8-29/P8-30: the dummy mailbox and the claims of the inbox trigger.
describe('mail (connection_messages)', () => {
  const mail = (tx: Tx, f: { connection: string; team: string; direction?: string; messageId: string; from?: string; thread?: string; ws?: string }) =>
    tx.query<{ id: string }>(
      `INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, thread_key, message_id, from_address, to_address, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'support@example.com', 'Refund', 'Please refund me.') RETURNING id`,
      [f.ws ?? omar.workspaceId, f.team, f.connection, f.direction ?? 'in', f.thread ?? f.messageId, f.messageId, f.from ?? 'customer@example.com'],
    );
  const seen = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ message_id: string }>('SELECT message_id FROM app.connection_messages WHERE direction = $1 ORDER BY message_id', ['in'])).rows.map((r) => r.message_id));
  let inboundEng: string;

  it('only a workspace admin puts a mail in (the delivery door); a lead, a member, a guest and a bot cannot, and nobody can put in a sent or saved one', async () => {
    expect(await code(as(omar, (tx) => mail(tx, { connection: ids.eng!, team: ENG, messageId: '<in-1@example.com>' })))).toBeUndefined();
    for (const person of [nadia, tariq, sameera, lena]) {
      expect(await code(as(person, (tx) => mail(tx, { connection: ids.eng!, team: ENG, messageId: `<try-${person.key}@example.com>` }))), person.name).toBe('42501');
    }
    expect(await code(asActor(botEng, 'bot', (tx) => mail(tx, { connection: ids.eng!, team: ENG, messageId: '<bot@example.com>' })))).toBe('42501');
    for (const direction of ['out', 'draft']) {
      expect(await code(as(omar, (tx) => mail(tx, { connection: ids.eng!, team: ENG, direction, messageId: `<${direction}@example.com>` }))), direction).toBe('42501');
    }
    inboundEng = (await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.connection_messages WHERE message_id = '<in-1@example.com>'`)).rows[0]!)).id;
  });

  it('is read by the people of the connection’s team and its bots, and by nobody else', async () => {
    await sys((tx) => mail(tx, { connection: ids.mkt!, team: MKT, messageId: '<press-1@example.com>' }));
    expect(await seen(nadia)).toEqual(['<in-1@example.com>']);
    expect(await seen(tariq)).toEqual(['<press-1@example.com>']);
    expect(await seen(priya)).toEqual(['<in-1@example.com>', '<press-1@example.com>']);
    expect(await seen(sameera)).toEqual([]);
    expect(await seen(lena)).toEqual([]);
    expect(await asActor(botEng, 'bot', async (tx) => (await tx.query('SELECT 1 FROM app.connection_messages')).rows.length)).toBe(1);
  });

  it('is immutable to every person-facing role: no update, no delete', async () => {
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connection_messages SET body = 'changed'`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.connection_messages')))).toBe('42501');
  });

  it('refuses the same mail twice on a connection, a connection of another team and a workspace that is not the connection’s', async () => {
    expect(await code(sys((tx) => mail(tx, { connection: ids.eng!, team: ENG, messageId: '<in-1@example.com>' })))).toBe('23505');
    // the same Message-ID on another connection is another mail
    expect(await code(sys((tx) => mail(tx, { connection: ids.mkt!, team: MKT, messageId: '<in-1@example.com>' })))).toBeUndefined();
    expect(await code(sys((tx) => mail(tx, { connection: ids.eng!, team: MKT, messageId: '<crossed@example.com>' })))).toBe('23503');
    expect(await code(sys((tx) => mail(tx, { connection: ids.eng!, team: otherWs.team, messageId: '<foreign@example.com>', ws: otherWs.workspace })))).toMatch(/^(23503|23514)$/);
  });

  // The writer answers a mail only for the run the transaction acts for, and only a mail that run answers (a claim linked to it): `bind` makes the claim, the actor gets the run.
  const RUN = randomUUID();
  const bind = (mailId: string, run: string = RUN): Promise<unknown> =>
    sys((tx) =>
      tx.query(
        `INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id, run_id, root_message_id, linked_at)
         SELECT m.workspace_id, m.team_id, m.connection_id, gen_random_uuid(), m.thread_key, m.id, $2::uuid, gen_random_uuid(), now() FROM app.connection_messages m WHERE m.id = $1 ON CONFLICT DO NOTHING`,
        [mailId, run],
      ),
    );
  afterEach(() => sys((tx) => tx.query('DELETE FROM app.connection_mail_claims WHERE run_id = $1', [RUN])));
  const put = (actor: string, connection: string, tool: string, replyTo: string | null, to: string | null, run: string | null = RUN) =>
    withActor({ kind: 'bot', id: actor as never, workspaceId: omar.workspaceId as never, ...(run ? { runId: run as never } : {}) }, async (tx) => (await tx.query<{ id: string }>('SELECT app.connection_mail_put_outbound($1::uuid, $2, $3::uuid, $4, $5, $6) AS id', [connection, tool, replyTo, to, 'Re: Refund', 'On its way.'])).rows[0]!.id, { pool: appPool });

  it('a send goes to the sender of the stored mail it answers; the address passed in is ignored', async () => {
    await bind(inboundEng);
    const id = await put(botEng, ids.eng!, 'email.send', inboundEng, 'attacker@example.com');
    const row = await sys(async (tx) => (await tx.query<{ direction: string; to_address: string; from_address: string; thread_key: string; in_reply_to: string }>('SELECT direction, to_address, from_address, thread_key, in_reply_to FROM app.connection_messages WHERE id = $1', [id])).rows[0]);
    expect(row).toMatchObject({ direction: 'out', to_address: 'customer@example.com', thread_key: '<in-1@example.com>', in_reply_to: '<in-1@example.com>' });
    expect(row?.from_address).toMatch(/^support-mail@/);
  });

  it('a send needs a mail to answer, and the mail must be an inbound one of the same connection', async () => {
    expect(await code(put(botEng, ids.eng!, 'email.send', null, 'someone@example.com'))).toBe('23514');
    const pressMail = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.connection_messages WHERE message_id = '<press-1@example.com>' AND connection_id = $1`, [ids.mkt])).rows[0]!.id);
    expect(await code(put(botEng, ids.eng!, 'email.send', pressMail, null))).toBe('P0002');
    const sent = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.connection_messages WHERE direction = 'out' AND connection_id = $1`, [ids.eng])).rows[0]!);
    expect(await code(put(botEng, ids.eng!, 'email.send', sent.id, null))).toBe('P0002');
  });

  it('writes nothing for a caller with no grant for the tool on that connection (another team’s bot, a tool not granted, a person)', async () => {
    expect(await code(put(botMkt, ids.eng!, 'email.send', inboundEng, null))).toBe('42501');
    // a bot of the same team with no grant at all
    const bare = await sys(async (tx) => {
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actor, omar.workspaceId]);
      return actor;
    });
    expect(await code(put(bare, ids.eng!, 'email.send', inboundEng, null))).toBe('42501');
    expect(await code(put(bare, ids.eng!, 'email.draft', inboundEng, 'x@example.com'))).toBe('42501');
    expect(await code(put(botEng, ids.eng!, 'email.read', inboundEng, null))).toBe('23514');
    expect(await code(as(omar, async (tx) => tx.query('SELECT app.connection_mail_put_outbound($1::uuid, $2, $3::uuid, $4, $5, $6)', [ids.eng, 'email.send', inboundEng, null, 's', 'b'])))).toBe('42501');
  });

  it('a draft with a mail to answer goes to that mail’s sender; without one it needs an address, and is never sent', async () => {
    await sys((tx) => tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.draft') ON CONFLICT DO NOTHING`, [omar.workspaceId, ids.eng, ENG, botEng]));
    await bind(inboundEng);
    const answered = await put(botEng, ids.eng!, 'email.draft', inboundEng, 'attacker@example.com');
    expect(await sys(async (tx) => (await tx.query<{ to_address: string; direction: string }>('SELECT to_address, direction FROM app.connection_messages WHERE id = $1', [answered])).rows[0])).toEqual({ to_address: 'customer@example.com', direction: 'draft' });
    expect(await code(put(botEng, ids.eng!, 'email.draft', null, null))).toBe('23514');
    const loose = await put(botEng, ids.eng!, 'email.draft', null, 'someone@example.com');
    expect((await sys(async (tx) => (await tx.query<{ to_address: string }>('SELECT to_address FROM app.connection_messages WHERE id = $1', [loose])).rows[0]))?.to_address).toBe('someone@example.com');
  });

  it('go when their connection goes', async () => {
    const doomed = await sys((tx) => insertConnection(tx, { team: ENG, slug: 'doomed-mail', scope: 'team', owner: omar.actorId }));
    await sys((tx) => mail(tx, { connection: doomed.id, team: ENG, messageId: '<doomed@example.com>' }));
    await sys((tx) => tx.query('DELETE FROM app.connections WHERE id = $1', [doomed.id]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_messages WHERE connection_id = $1', [doomed.id])).rows.length)).toBe(0);
  });
});

describe('mail claims (connection_mail_claims)', () => {
  let mailId: string;
  const claim = (tx: Tx, f: { bot: string; thread: string; run?: string | null; root?: string | null }) =>
    tx.query<{ id: string }>(
      `INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id, run_id, root_message_id, linked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [omar.workspaceId, ENG, ids.eng, f.bot, f.thread, mailId, f.run ?? null, f.root ?? null],
    );
  const claimsSeenBy = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.connection_mail_claims')).rows.length);

  it('are written by the system only, and read by the people of the team', async () => {
    mailId = (await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.connection_messages WHERE message_id = '<in-1@example.com>' AND connection_id = $1`, [ids.eng])).rows[0]!)).id;
    expect(await code(sys((tx) => claim(tx, { bot: randomUUID(), thread: '<in-1@example.com>' })))).toBeUndefined();
    for (const person of [omar, nadia]) expect(await code(as(person, (tx) => claim(tx, { bot: randomUUID(), thread: '<x@example.com>' }))), person.name).toBe('42501');
    expect(await code(asActor(botEng, 'bot', (tx) => claim(tx, { bot: randomUUID(), thread: '<y@example.com>' })))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connection_mail_claims SET run_id = gen_random_uuid()`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.connection_mail_claims')))).toBe('42501');
    expect(await claimsSeenBy(nadia)).toBe(1);
    expect(await claimsSeenBy(tariq)).toBe(0);
    expect(await claimsSeenBy(sameera)).toBe(0);
    expect(await claimsSeenBy(lena)).toBe(0);
  });

  it('allow one claim per bot per mail thread (the same mail twice is one run), a thread of its own per bot, and a link that is whole or absent', async () => {
    const botId = randomUUID();
    expect(await code(sys((tx) => claim(tx, { bot: botId, thread: '<t@example.com>' })))).toBeUndefined();
    expect(await code(sys((tx) => claim(tx, { bot: botId, thread: '<t@example.com>' })))).toBe('23505');
    expect(await code(sys((tx) => claim(tx, { bot: randomUUID(), thread: '<t@example.com>' })))).toBeUndefined();
    // a run without a post, a post without a run: refused by the table
    expect(await code(sys((tx) => tx.query(`UPDATE app.connection_mail_claims SET run_id = gen_random_uuid() WHERE bot_id = $1`, [botId])))).toBe('23514');
    const run = randomUUID();
    const root = randomUUID();
    expect(await code(sys((tx) => tx.query(`UPDATE app.connection_mail_claims SET run_id = $2, root_message_id = $3, linked_at = now() WHERE bot_id = $1`, [botId, run, root])))).toBeUndefined();
    // a run and a post each belong to one claim
    expect(await code(sys((tx) => claim(tx, { bot: randomUUID(), thread: '<u@example.com>', run, root: randomUUID() })))).toBe('23505');
    expect(await code(sys((tx) => claim(tx, { bot: randomUUID(), thread: '<v@example.com>', run: randomUUID(), root })))).toBe('23505');
  });

  it('go with their mail', async () => {
    const doomed = await sys((tx) => insertConnection(tx, { team: ENG, slug: 'doomed-claims', scope: 'team', owner: omar.actorId }));
    const mailRow = await sys((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, thread_key, message_id, from_address, to_address) VALUES ($1, $2, $3, 'in', 'k', 'k', 'a@b.c', 'd@e.f') RETURNING id`,
        [omar.workspaceId, ENG, doomed.id],
      ),
    );
    await sys((tx) =>
      tx.query(`INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id) VALUES ($1, $2, $3, $4, 'k', $5)`, [omar.workspaceId, ENG, doomed.id, randomUUID(), mailRow.rows[0]!.id]),
    );
    await sys((tx) => tx.query('DELETE FROM app.connections WHERE id = $1', [doomed.id]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_mail_claims WHERE connection_id = $1', [doomed.id])).rows.length)).toBe(0);
  });
});

// Review of P8-29/P8-30 (migration 0004): the mail writer serves the run the transaction acts for and nothing else, and only on a connection that is on.
describe('the mail writer is bound to the run and to a connection that is on', () => {
  let conn: string;
  let mailA: string;
  let mailB: string;
  let botId: string;
  let writer: string;
  const RUN_A = randomUUID();
  const RUN_B = randomUUID();

  const mailIn = (messageId: string): Promise<string> =>
    sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, thread_key, message_id, from_address, to_address, subject, body)
           VALUES ($1, $2, $3, 'in', $4, $4, $5, 'support@example.com', 'Refund', 'Please refund me.') RETURNING id`,
          [omar.workspaceId, ENG, conn, messageId, `${messageId.replace(/[<>@.]/g, '')}@customer.example`],
        )
      ).rows[0]!.id,
    );
  const claimFor = (mailId: string, f: { run?: string | null; root?: string | null; bot?: string }): Promise<unknown> =>
    sys((tx) =>
      tx.query(
        `INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id, run_id, root_message_id, linked_at)
         SELECT m.workspace_id, m.team_id, m.connection_id, $2::uuid, m.thread_key, m.id, $3::uuid, $4::uuid, CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END FROM app.connection_messages m WHERE m.id = $1`,
        [mailId, f.bot ?? randomUUID(), f.run ?? null, f.root ?? null],
      ),
    );
  const clearClaims = () => sys((tx) => tx.query('DELETE FROM app.connection_mail_claims WHERE connection_id = $1', [conn]));
  const actorOf = (run: string | null) => ({ kind: 'bot' as const, id: writer as never, workspaceId: omar.workspaceId as never, ...(run ? { runId: run as never } : {}) });
  const send = (replyTo: string | null, run: string | null, tool = 'email.send', body = 'On its way.') =>
    withActor(
      actorOf(run),
      async (tx) => (await tx.query<{ id: string }>('SELECT app.connection_mail_put_outbound($1::uuid, $2, $3::uuid, $4, $5, $6) AS id', [conn, tool, replyTo, tool === 'email.draft' && replyTo === null ? 'someone@example.com' : null, 'Re: Refund', body])).rows[0]!.id,
      { pool: appPool },
    );
  /** What `app.connection_mail_claims_of_run` answers to a transaction acting for `run`, asked about `asked`. */
  const claimsOf = (run: string | null, asked: string, body: string | null = null): Promise<Array<{ mail_id: string; route: number }>> =>
    withActor(actorOf(run), async (tx) => (await tx.query<{ mail_id: string; route: number }>('SELECT mail_id, route FROM app.connection_mail_claims_of_run($1::uuid, $2) ORDER BY route, mail_id', [asked, body])).rows, { pool: appPool });
  const bot = (slug: string): Promise<string> =>
    sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG, slug],
        )
      ).rows[0]!.id,
    );
  const run = (botOf: string, trigger: string, f: { job?: string | null; reply?: string | null; status?: string } = {}): Promise<string> =>
    sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, job_id, reply_root_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [omar.workspaceId, botOf, ENG, trigger, f.status ?? 'running', f.job ?? null, f.reply ?? null],
        )
      ).rows[0]!.id,
    );

  beforeAll(async () => {
    conn = (await sys((tx) => insertConnection(tx, { team: ENG, slug: 'bound-mail', scope: 'team', owner: omar.actorId }))).id;
    await sys(async (tx) => {
      await tx.query(`UPDATE app.connections SET status = 'enabled' WHERE id = $1`, [conn]);
      // a bot actor of its own (a grant is one per actor and tool, and the others already hold theirs on the support mailbox)
      writer = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, writer, omar.workspaceId]);
      await tx.query(`INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool) VALUES ($1, $2, $3, $4, 'email.send'), ($1, $2, $3, $4, 'email.draft')`, [omar.workspaceId, conn, ENG, writer]);
    });
    mailA = await mailIn('<bound-a@example.com>');
    mailB = await mailIn('<bound-b@example.com>');
    botId = await bot('bound-bot');
  });
  afterEach(clearClaims);

  it('writes a reply to the mail the run is linked to, and to no other mail of the connection', async () => {
    await claimFor(mailA, { run: RUN_A, root: randomUUID() });
    const ok = await send(mailA, RUN_A);
    expect((await sys(async (tx) => (await tx.query<{ to_address: string }>('SELECT to_address FROM app.connection_messages WHERE id = $1', [ok])).rows[0]))?.to_address).toBe('bound-aexamplecom@customer.example');
    // the mail of another thread, held by the same connection and the same grant, is not this run's
    expect(await code(send(mailB, RUN_A))).toBe('42501');
    expect(await code(send(mailB, RUN_A, 'email.draft'))).toBe('42501');
  });

  it('refuses a reply from a transaction with no run, from another run, and while no claim is the run’s', async () => {
    await claimFor(mailA, { run: RUN_A, root: randomUUID() });
    expect(await code(send(mailA, null))).toBe('42501');
    expect(await code(send(mailA, RUN_B))).toBe('42501');
    await clearClaims();
    expect(await code(send(mailA, RUN_A))).toBe('42501');
    // a claim that no run was linked to yet is nobody's to answer with
    await claimFor(mailA, {});
    expect(await code(send(mailA, RUN_A))).toBe('42501');
  });

  it('answers an inbox run its claim by the job that started it, before any post was made', async () => {
    const claim = (
      await sys(async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id) SELECT workspace_id, team_id, connection_id, $2::uuid, thread_key, id FROM app.connection_messages WHERE id = $1 RETURNING id`,
            [mailA, botId],
          )
        ).rows[0]!.id,
      )
    );
    const job = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.jobs (queue, payload) VALUES ('runtime-hermes.run', $1::jsonb) RETURNING id`, [JSON.stringify({ inbox: { claimId: claim, connectionId: conn, mailId: mailA } })])).rows[0]!.id);
    const inbox = await run(botId, 'inbox', { job });
    const mention = await run(botId, 'mention', { job });
    const stranger = await run(await bot('bound-other'), 'inbox', { job });
    expect(await claimsOf(inbox, inbox)).toEqual([{ mail_id: mailA, route: 0 }]);
    // the same job on a run that is not an inbox run, or that belongs to another bot, gives nothing
    expect(await claimsOf(mention, mention)).toEqual([]);
    expect(await claimsOf(stranger, stranger)).toEqual([]);
    // and the writer takes it: the inbox run replies before it has posted anything
    const draft = await withActor(actorOf(inbox), async (tx) => (await tx.query<{ id: string }>('SELECT app.connection_mail_put_outbound($1::uuid, $2, $3::uuid, NULL, $4, $5) AS id', [conn, 'email.draft', mailA, 's', 'b'])).rows[0]!.id, { pool: appPool });
    expect(draft).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers a run the claim of the thread it answers in, and a transaction only about its own run', async () => {
    const root = randomUUID();
    await claimFor(mailA, { run: RUN_A, root });
    const mention = await run(botId, 'mention', { reply: root });
    expect(await claimsOf(mention, mention)).toEqual([{ mail_id: mailA, route: 1 }]);
    // asking about another run than the one the transaction acts for gives nothing
    expect(await claimsOf(mention, RUN_A)).toEqual([]);
    expect(await claimsOf(RUN_A, mention)).toEqual([]);
    expect(await claimsOf(null, mention)).toEqual([]);
  });

  it('answers a person-approved send its claim through the approval, only for the exact text and only when unambiguous', async () => {
    const origin = await run(botId, 'inbox', { status: 'stopped' });
    await claimFor(mailA, { run: origin, root: randomUUID() });
    const rerun = await run(botId, 'inbox');
    const approval = (runId: string, body: string): Promise<unknown> =>
      sys((tx) =>
        tx.query(
          `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, requester_name, bot_id, run_id, decided_at)
           VALUES ($1, $2, 'grant', 'approved', 'running', 'email.send', 'email.send', '{}', $3::jsonb, '{"roles":[],"people":[],"leads":true}', $4, 'Nadia', $5, $6, now())`,
          [omar.workspaceId, ENG, JSON.stringify({ kind: 'tool', capability: 'email.send', args: { body }, trigger: 'inbox' }), nadia.actorId, botId, runId],
        ),
      );
    await approval(origin, 'Approved text.');
    // no text, or other text, finds nothing: the route is for the exact call a person approved
    expect(await claimsOf(rerun, rerun)).toEqual([]);
    expect(await claimsOf(rerun, rerun, 'Other text.')).toEqual([]);
    expect(await claimsOf(rerun, rerun, 'Approved text.')).toEqual([{ mail_id: mailA, route: 2 }]);
    // a send that is not running (already ran) is not a licence
    await sys((tx) => tx.query(`UPDATE app.approvals SET outcome = 'ran' WHERE bot_id = $1`, [botId]));
    expect(await claimsOf(rerun, rerun, 'Approved text.')).toEqual([]);
    await sys((tx) => tx.query(`UPDATE app.approvals SET outcome = 'running' WHERE bot_id = $1`, [botId]));
    // two approved sends with the same text for two different mails are ambiguous: nothing is answered
    const origin2 = await run(botId, 'inbox', { status: 'stopped' });
    await claimFor(mailB, { run: origin2, root: randomUUID() });
    await approval(origin2, 'Approved text.');
    expect(await claimsOf(rerun, rerun, 'Approved text.')).toEqual([]);
    await sys((tx) => tx.query(`DELETE FROM app.approvals WHERE bot_id = $1`, [botId]));
  });

  it('refuses a connection that is switched off or past its end, and writes again when it is on', async () => {
    await claimFor(mailA, { run: RUN_A, root: randomUUID() });
    const set = (sql: string) => sys((tx) => tx.query(`UPDATE app.connections SET ${sql} WHERE id = $1`, [conn]));
    await set(`status = 'disabled'`);
    expect(await code(send(mailA, RUN_A))).toBe('42501');
    expect(await code(send(null, RUN_A, 'email.draft'))).toBe('42501');
    await set(`status = 'enabled', expires_at = now() - interval '1 minute'`);
    expect(await code(send(mailA, RUN_A))).toBe('42501');
    await set(`expires_at = now() + interval '1 day'`);
    expect(await code(send(mailA, RUN_A))).toBeUndefined();
    await set(`expires_at = NULL`);
  });
});
