import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import {
  CONNECTION_ADMIN_ONLY,
  CONNECTION_KIND_TOOLS,
  Connection,
  CreateConnectionResponse,
  DeleteConnectionResponse,
  ListConnectionsResponse,
  PutConnectionCredentialResponse,
  UpdateConnectionResponse,
} from '@manythreads/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { TOOLS } from '../src/index.ts';

// P8-06: the routes that add, change, switch on and remove a team's connection, on a real server. Only a workspace admin writes a team's connection; the credential
// goes in sealed and never comes back out (not in an answer, an event or a log line); every change leaves one audit line; removing a connection removes its
// credentials and the broker's rows that came from it.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const SECRET = 'mailbox-password-SENTINEL-77d2a1';

let w: RepoWorld;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

beforeAll(async () => {
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  await w?.close();
});

const create = (who: typeof omar, body: unknown) => w.call<{ connection?: Connection; error?: { message: string } }>(who, 'POST', '/api/teams/engineering/connections', body);

describe('adding a connection', () => {
  it('a team member who is not a workspace admin is told, in plain words, who can', async () => {
    const res = await create(nadia, { kind: 'email', name: 'Nadia mailbox' });
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toBe(CONNECTION_ADMIN_ONLY);
  });

  it('a workspace admin adds one: switched off, nothing stored, a short name made from the name, and the same name twice gets a second short name', async () => {
    const res = await create(omar, { kind: 'email', name: 'Support Mailbox', environment: 'staging' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const made = CreateConnectionResponse.parse(res.body).connection;
    expect(made).toMatchObject({ slug: 'support-mailbox', kind: 'email', scope: 'team', status: 'disabled', environment: 'staging', hasCredentials: false, teamId: ENG });
    const again = CreateConnectionResponse.parse((await create(omar, { kind: 'email', name: 'Support Mailbox' })).body).connection;
    expect(again.slug).toBe('support-mailbox-2');
  });

  it('refuses a short name that is taken, and a kind that is unknown, each with words', async () => {
    const taken = await create(omar, { kind: 'email', name: 'Another', slug: 'support-mailbox' });
    expect(taken.status).toBe(409);
    expect(taken.body.error?.message).toMatch(/short name/);
    expect((await create(omar, { kind: 'telepathy', name: 'Mind' })).status).toBe(400);
  });
});

describe('the credential and the switch', () => {
  let id: string;

  beforeAll(async () => {
    id = CreateConnectionResponse.parse((await create(omar, { kind: 'email', name: 'Switchable' })).body).connection.id;
  });

  it('a connection with nothing stored cannot be switched on', async () => {
    const res = await w.call<{ error?: { message: string } }>(omar, 'PATCH', `/api/connections/${id}`, { status: 'enabled' });
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/credential/);
  });

  it('only a workspace admin puts a credential in; a name the kind does not have is refused', async () => {
    expect((await w.call(nadia, 'PUT', `/api/connections/${id}/credentials/password`, { value: SECRET })).status).toBe(403);
    expect((await w.call(omar, 'PUT', `/api/connections/${id}/credentials/nothing`, { value: SECRET })).status).toBe(400);
    expect((await w.call(omar, 'PUT', `/api/connections/${id}/credentials/password`, { value: '' })).status).toBe(400);
  });

  it('the credential goes in sealed and the answer says only that something is stored; then it can be switched on and off', async () => {
    const put = await w.call(omar, 'PUT', `/api/connections/${id}/credentials/password`, { value: SECRET });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(PutConnectionCredentialResponse.parse(put.body).connection.hasCredentials).toBe(true);
    expect(JSON.stringify(put.body)).not.toContain(SECRET);

    const on = await w.call(omar, 'PATCH', `/api/connections/${id}`, { status: 'enabled' });
    expect(UpdateConnectionResponse.parse(on.body).connection.status).toBe('enabled');
    const off = await w.call(omar, 'PATCH', `/api/connections/${id}`, { status: 'disabled', name: 'Switchable mail' });
    expect(UpdateConnectionResponse.parse(off.body).connection).toMatchObject({ status: 'disabled', name: 'Switchable mail' });
    expect((await w.call(nadia, 'PATCH', `/api/connections/${id}`, { status: 'enabled' })).status).toBe(403);
  });

  it('the team lists it without the credential, and nothing the server wrote holds the value', async () => {
    const list = ListConnectionsResponse.parse((await w.call(nadia, 'GET', '/api/teams/engineering/connections')).body);
    expect(list.connections.find((c) => c.id === id)).toMatchObject({ hasCredentials: true, status: 'disabled' });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(w.server.logs.join('\n')).not.toContain(SECRET);
    const inEvents = await sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [SECRET])).rows[0]!.n);
    expect(inEvents).toBe(0);
  });

  it('every change left one audit line, by kind of change, without a credential or a display name', async () => {
    const lines = await sys(async (tx) =>
      (await tx.query<{ change: string }>(`SELECT payload->>'change' AS change FROM app.events WHERE type = 'connections.connection.changed' AND payload->>'connectionId' = $1 ORDER BY id`, [id])).rows.map((r) => r.change),
    );
    expect(lines).toEqual(['created', 'credential_set', 'switched', 'updated', 'switched']);
    const raw = await sys(async (tx) => (await tx.query<{ payload: object }>(`SELECT payload FROM app.events WHERE type = 'connections.connection.changed' AND payload->>'connectionId' = $1`, [id])).rows);
    expect(JSON.stringify(raw)).not.toContain('Switchable');
  });
});

describe('removing a connection', () => {
  it('takes the stored credential and the broker rows that came from it, and only a workspace admin may', async () => {
    const id = CreateConnectionResponse.parse((await create(omar, { kind: 'email', name: 'Doomed', slug: 'doomed-mail' })).body).connection.id;
    expect((await w.call(omar, 'PUT', `/api/connections/${id}/credentials/password`, { value: SECRET })).status).toBe(200);
    // a bot of the team that holds a tool through it, as the compile leaves it
    const actorId = await sys(async (tx) => {
      const botId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
           VALUES ($1, $2, 'doomed-bot', 'agent', 'rules', 'team', repeat('e', 64), 'active', '[]'::jsonb) RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, botId])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actor, omar.workspaceId]);
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'email.read', false, '{"connection":"doomed-mail"}'::jsonb)`, [ENG, actor]);
      return actor;
    });

    expect((await w.call(nadia, 'DELETE', `/api/connections/${id}`)).status).toBe(403);
    const res = await w.call(omar, 'DELETE', `/api/connections/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DeleteConnectionResponse.parse(res.body).deleted).toBe(true);
    expect((await w.call(omar, 'DELETE', `/api/connections/${id}`)).status).toBe(404);

    expect(await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.connection_secrets WHERE connection_id = $1`, [id])).rowCount)).toBe(0);
    await vi.waitFor(
      async () => expect(await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.capability_grants WHERE actor_id = $1`, [actorId])).rowCount)).toBe(0),
      { timeout: 20_000, interval: 200 },
    );
  });
});

describe('a person’s own connections', () => {
  it('the list is theirs alone and empty until they have one', async () => {
    const res = await w.call(nadia, 'GET', '/api/me/connections');
    expect(res.status).toBe(200);
    expect(ListConnectionsResponse.parse(res.body).connections).toEqual([]);
    expect((await w.call(null, 'GET', '/api/me/connections')).status).toBe(401);
  });

  it('shows their own and nobody else’s, and they may remove it', async () => {
    const mine = await sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.connections (workspace_id, slug, kind, name, scope, owner_id) VALUES ($1, 'my-drive', 'email', 'My drive', 'person', $2) RETURNING id`,
          [omar.workspaceId, nadia.actorId],
        )
      ).rows[0]!.id,
    );
    expect(ListConnectionsResponse.parse((await w.call(nadia, 'GET', '/api/me/connections')).body).connections.map((c) => c.slug)).toEqual(['my-drive']);
    expect(ListConnectionsResponse.parse((await w.call(omar, 'GET', '/api/me/connections')).body).connections).toEqual([]);
    expect((await w.call(omar, 'DELETE', `/api/connections/${mine}`)).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', `/api/connections/${mine}`)).status).toBe(200);
  });
});

describe('the kinds list', () => {
  it('names exactly the tools the plugin serves', () => {
    expect(Object.values(CONNECTION_KIND_TOOLS).flat().sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });
});
