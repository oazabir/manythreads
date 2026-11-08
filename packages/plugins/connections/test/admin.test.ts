import { AdminDisconnectConnectionResponse, ListConnectionPeopleResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { personas, startAdminWorld, TEAM_IDS, WS, type AdminWorld } from './admin-world.ts';

// Bundle D, P16-11 (decision D32): what an admin sees of the people's sign-ins (provider, services, state, last use; never an account address, never a token) and the one
// action, "Disconnect". A real server and a fake Google, Microsoft and Notion.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, tariq, lena, priya } = personas;

let x: AdminWorld;
const people = async (who = omar) => {
  const res = await x.raw(who, 'GET', '/api/admin/connections/people');
  expect(res.status, await res.clone().text()).toBe(200);
  return ListConnectionPeopleResponse.parse(await res.json()).people;
};
const secretsOf = (connectionId: string) => x.sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_secrets WHERE connection_id = $1', [connectionId])).rows.length);
const events = (type: string) => x.sys(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

beforeAll(async () => {
  x = await startAdminWorld();
  await x.connect(nadia, 'google', ['drive', 'calendar']);
  await x.connect(rafi, 'microsoft');
  await x.connect(priya, 'notion');
}, 180_000);
afterAll(async () => {
  await x?.close();
});

describe('the people list', () => {
  it('shows each sign-in with its provider, the services granted and its state, and never an account address', async () => {
    const rows = await people();
    expect(rows.map((r) => `${r.personName}:${r.connector}`).sort()).toEqual(['Nadia:google', 'Priya:notion', 'Rafi:microsoft']);
    const nadiaRow = rows.find((r) => r.personId === nadia.personId)!;
    expect(nadiaRow).toMatchObject({ connector: 'google', state: 'ok', lastUsedOn: null });
    expect([...nadiaRow.services].sort()).toEqual(['calendar', 'drive']);
    expect(nadiaRow.connectedAt).toMatch(/^\d{4}-/);
    const text = JSON.stringify(rows);
    // no address of any account, no token of any kind
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/access-|refresh-|account/i);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['connectedAt', 'connectionId', 'connector', 'lastUsedOn', 'personId', 'personName', 'refreshedAt', 'services', 'state']);
  });

  it('an admin only: a team lead, a member and a guest are refused, a visitor is turned away', async () => {
    for (const who of [tariq, nadia, lena]) expect((await x.raw(who, 'GET', '/api/admin/connections/people')).status, who.name).toBe(403);
    expect((await fetch(`${x.w.server.url}/api/admin/connections/people`)).status).toBe(401);
  });

  it('a sign-in the provider refused says to reconnect, a switched-off one says disabled, and the last use shows once a call was counted', async () => {
    const rafiId = (await x.connectionOf(rafi, 'microsoft'))!.id;
    const priyaId = (await x.connectionOf(priya, 'notion'))!.id;
    await x.sys(async (tx) => {
      await tx.query(`UPDATE app.connection_oauth SET state = 'needs_reconnect' WHERE connection_id = $1`, [rafiId]);
      await tx.query(`UPDATE app.connections SET status = 'disabled' WHERE id = $1`, [priyaId]);
      await tx.query('SELECT app.connection_usage_bump($1, true)', [priyaId]);
    });
    const rows = await people();
    expect(rows.find((r) => r.personId === rafi.personId)!.state).toBe('needs_reconnect');
    const priyaRow = rows.find((r) => r.personId === priya.personId)!;
    expect(priyaRow.state).toBe('disabled');
    expect(priyaRow.lastUsedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('disconnecting one person’s sign-in', () => {
  const del = (who: typeof omar, id: string) => x.raw(who, 'DELETE', `/api/admin/connections/people/${id}`);

  it('is refused to everyone but an admin, and answers 404 for a connection that is not a person’s sign-in', async () => {
    const id = (await x.connectionOf(nadia, 'google'))!.id;
    for (const who of [tariq, nadia, lena]) expect((await del(who, id)).status, who.name).toBe(403);
    expect((await x.connectionOf(nadia, 'google'))!.id).toBe(id);
    // a team connection is not one: it is not removed here
    const teamId = await x.sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, 'eng-mail', 'email', 'eng-mail', 'team', $3) RETURNING id`,
          [WS, TEAM_IDS.Engineering, omar.actorId],
        )
      ).rows[0]!.id,
    );
    expect((await del(omar, teamId)).status).toBe(404);
    expect((await del(omar, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await del(omar, 'not-an-id')).status).toBe(400);
    expect(await x.sys(async (tx) => (await tx.query('SELECT 1 FROM app.connections WHERE id = $1', [teamId])).rows.length)).toBe(1);
  });

  it('asks the provider to forget the token, deletes the sign-in and its sealed tokens, and leaves one audit line', async () => {
    const id = (await x.connectionOf(nadia, 'google'))!.id;
    expect(await secretsOf(id)).toBeGreaterThan(0);
    const before = x.fake.revoked.length;
    const res = await del(omar, id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(AdminDisconnectConnectionResponse.parse(await res.json())).toEqual({ removed: true, providerRevoked: true });
    expect(x.fake.revoked.slice(before)).toEqual([{ provider: 'google', kind: 'refresh' }]);
    expect(await x.connectionOf(nadia, 'google')).toBeUndefined();
    expect(await secretsOf(id)).toBe(0);
    const line = (await events('connections.connection.changed')).find((e) => e['connectionId'] === id);
    expect(line).toMatchObject({ change: 'deleted', scope: 'person', kind: 'google', slug: 'google', actorId: omar.actorId });
    expect(JSON.stringify(line)).not.toMatch(/access-|refresh-|@/);
    // she sees it gone, and the second press finds nothing
    const mine = await x.raw(nadia, 'GET', '/api/me/connections/providers');
    expect(((await mine.json()) as { providers: Array<{ id: string; connected: boolean }> }).providers.find((p) => p.id === 'google')!.connected).toBe(false);
    expect((await del(omar, id)).status).toBe(404);
  });

  it('a provider with no revoke address is still removed, and says the provider was not asked', async () => {
    const id = (await x.connectionOf(rafi, 'microsoft'))!.id;
    const before = x.fake.revoked.length;
    const res = await del(omar, id);
    expect(AdminDisconnectConnectionResponse.parse(await res.json())).toEqual({ removed: true, providerRevoked: false });
    expect(x.fake.revoked.length).toBe(before);
    expect(await x.connectionOf(rafi, 'microsoft')).toBeUndefined();
    expect(await secretsOf(id)).toBe(0);
  });

  it('a provider that is down does not stop the removal', async () => {
    const id = (await x.connectionOf(priya, 'notion'))!.id;
    const base = process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'];
    process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'] = 'http://127.0.0.1:1';
    try {
      const res = await del(omar, id);
      expect(AdminDisconnectConnectionResponse.parse(await res.json())).toEqual({ removed: true, providerRevoked: false });
    } finally {
      if (base === undefined) delete process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'];
      else process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'] = base;
    }
    expect(await x.connectionOf(priya, 'notion')).toBeUndefined();
    expect(await people()).toEqual([]);
  });
});
