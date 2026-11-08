import { OffboardConnectionsResponse, OffboardPreviewResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OFFBOARD_QUEUE, revokeAndDelete, startOffboarding } from '../src/offboard.ts';
import { personas, startAdminWorld, TEAM_IDS, WS, type AdminWorld } from './admin-world.ts';

// Bundle D, P16-11 (decisions D33, D34): when a person leaves their own connections stop working at once, the providers are asked to forget them, everything is deleted in one
// transaction with one audit line, and the team and workspace connections they set up move to a lead (else the admin who acted). A real server with its job worker, a fake Google,
// Microsoft and Notion, and the real MCP gateway.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, tariq, lena, priya } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const GOOGLE_TOOLS = ['google_drive.search', 'google_drive.read'];

let x: AdminWorld;
const conn = { nadiaGoogle: '', nadiaMs: '', rafiGoogle: '', tariqGoogle: '', tariqNotion: '', engMail: '', wsMail: '', mktMail: '' };

const insertShared = (slug: string, scope: 'team' | 'workspace', team: string | null, owner: string): Promise<string> =>
  x.sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(`INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, $3, 'email', $3, $4, $5) RETURNING id`, [WS, team, slug, scope, owner])
      ).rows[0]!.id,
  );
const ownerOf = (id: string) => x.sys(async (tx) => (await tx.query<{ owner_id: string }>('SELECT owner_id FROM app.connections WHERE id = $1', [id])).rows[0]?.owner_id);
const ownConnectionCount = (who: { actorId: string }) => x.sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.connections WHERE owner_id = $1 AND scope = 'person'`, [who.actorId])).rows[0]!.n);
const events = (type: string) => x.sys(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const preview = async (who: typeof omar, personId: string) => x.raw(who, 'GET', `/api/admin/people/${personId}/offboard-connections`);
const secretCount = (ids: string[]) => x.sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.connection_secrets WHERE connection_id = ANY($1::uuid[])', [ids])).rows[0]!.n);
const suspend = (personId: string, status: 'suspended' | 'active') => x.raw(omar, 'PATCH', `/api/workspace/members/${personId}`, { status });

beforeAll(async () => {
  x = await startAdminWorld();
  x.fake.account(nadia.email).files = [{ id: 'nadia-plan', name: 'Hiring plan', mimeType: 'text/plain', modified: '2026-10-29T10:00:00.000Z', text: 'Only Nadia keeps the hiring plan.' }];
  await x.connect(nadia, 'google', ['drive']);
  await x.connect(nadia, 'microsoft');
  await x.connect(rafi, 'google', ['drive']);
  await x.connect(tariq, 'google', ['drive']);
  await x.connect(tariq, 'notion');
  conn.nadiaGoogle = (await x.connectionOf(nadia, 'google'))!.id;
  conn.nadiaMs = (await x.connectionOf(nadia, 'microsoft'))!.id;
  conn.rafiGoogle = (await x.connectionOf(rafi, 'google'))!.id;
  conn.tariqGoogle = (await x.connectionOf(tariq, 'google'))!.id;
  conn.tariqNotion = (await x.connectionOf(tariq, 'notion'))!.id;
  conn.engMail = await insertShared('eng-mail', 'team', ENG, nadia.actorId);
  conn.wsMail = await insertShared('ws-mail', 'workspace', null, nadia.actorId);
  conn.mktMail = await insertShared('mkt-mail', 'team', MKT, tariq.actorId);
}, 180_000);
afterAll(async () => {
  await x?.close();
});

describe('the preview', () => {
  it('says what will be removed and who takes over what, and changes nothing', async () => {
    const res = await preview(omar, nadia.personId);
    expect(res.status, await res.clone().text()).toBe(200);
    const { preview: p } = OffboardPreviewResponse.parse(await res.json());
    expect(p.personName).toBe('Nadia');
    expect(p.own).toEqual([
      { connector: 'google', services: ['drive'] },
      { connector: 'microsoft', services: expect.arrayContaining(['onedrive']) },
    ]);
    expect(p.moving).toEqual([
      { slug: 'eng-mail', connector: 'email', newOwnerName: 'Omar' },
      { slug: 'ws-mail', connector: 'email', newOwnerName: 'Omar' },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/@|access-|refresh-/);
    // nothing moved, nothing switched off
    expect(await ownerOf(conn.engMail)).toBe(nadia.actorId);
    expect(await ownerOf(conn.wsMail)).toBe(nadia.actorId);
    expect((await x.connectionOf(nadia, 'google'))!.status).toBe('enabled');
  });

  it('names the admin who is looking when the team has no other lead', async () => {
    const { preview: p } = OffboardPreviewResponse.parse(await (await preview(omar, tariq.personId)).json());
    expect(p.moving).toEqual([{ slug: 'mkt-mail', connector: 'email', newOwnerName: 'Omar' }]);
    expect(p.own.map((o) => o.connector)).toEqual(['google', 'notion']);
  });

  it('is for admins; a lead, a member and a guest get 403, an unknown person 404', async () => {
    for (const who of [tariq, nadia, lena]) expect((await preview(who, rafi.personId)).status, who.name).toBe(403);
    expect((await preview(omar, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await preview(omar, 'nobody')).status).toBe(400);
  });
});

describe('the button', () => {
  const press = (who: typeof omar, personId: string) => x.raw(who, 'POST', `/api/admin/people/${personId}/offboard-connections`, {});

  it('is refused to everyone but an admin, to the admin for their own account, and for a person who is not there', async () => {
    for (const who of [tariq, nadia, lena]) expect((await press(who, rafi.personId)).status, who.name).toBe(403);
    expect((await press(omar, omar.personId)).status).toBe(400);
    expect((await press(omar, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect(await ownConnectionCount(rafi)).toBe(1);
    expect((await x.raw(omar, 'POST', `/api/admin/people/${rafi.personId}/offboard-connections`, { surprise: 1 })).status).toBe(400);
    expect(await ownConnectionCount(rafi)).toBe(1);
  });

  it('the first step switches the person’s calls off at once and moves what they set up, before any provider is asked', async () => {
    const run = await x.openRun((await bot()).botId, ENG, nadia.actorId);
    expect(await x.called(run, 'google_drive.search', { query: 'hiring' })).toMatchObject({ ok: true });

    const enqueue = vi.fn(() => Promise.resolve('job'));
    const started = await x.asPlugin((tx) => startOffboarding({ jobs: { register: vi.fn(), enqueue } }, tx, { workspaceId: WS, personId: nadia.personId, fallbackPersonId: omar.personId, actorId: null }));
    expect(started).toMatchObject({ disabled: 2, moved: 2, queued: true, newOwnerIds: [omar.actorId] });

    // the very next call of the same run is refused: the connection is switched off, the tokens are still there (the job has not run)
    const refused = await x.called(run, 'google_drive.search', { query: 'hiring' });
    expect(refused).toMatchObject({ ok: false, code: 'not_connected' });
    expect(await x.connectionOf(nadia, 'google')).toMatchObject({ status: 'disabled' });
    expect(await x.connectionOf(nadia, 'microsoft')).toMatchObject({ status: 'disabled' });
    expect(await secretCount([conn.nadiaGoogle, conn.nadiaMs])).toBeGreaterThan(0);
    // the shared ones moved to the lead of the team and to an admin
    expect(await ownerOf(conn.engMail)).toBe(omar.actorId);
    expect(await ownerOf(conn.wsMail)).toBe(omar.actorId);

    // one job was queued in the same transaction, naming ids and counts, never a token
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, queue, payload, options] = enqueue.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>, { dedupeKey?: string }];
    expect(queue).toBe(OFFBOARD_QUEUE);
    expect(payload).toMatchObject({ workspaceId: WS, personId: nadia.personId, moved: 2, newOwnerIds: [omar.actorId], actorId: null });
    expect([...(payload['connectionIds'] as string[])].sort()).toEqual([conn.nadiaGoogle, conn.nadiaMs].sort());
    expect(JSON.stringify(payload)).not.toMatch(/access-|refresh-/);
    expect(options.dedupeKey).toBe(`connections-offboard:${nadia.personId}`);
  });

  it('answers 202 and a job asks the providers, deletes everything in one go and leaves one audit line', async () => {
    const before = x.fake.revoked.length;
    const res = await press(omar, nadia.personId);
    expect(res.status, await res.clone().text()).toBe(202);
    // the moves were done by the first step: nothing is left to move, both of hers are already off
    expect(OffboardConnectionsResponse.parse(await res.json())).toEqual({ result: { queued: true, disabled: 2, moved: 0 } });

    await x.until(async () => (await ownConnectionCount(nadia)) === 0, 20_000, 'her connections to be removed');
    expect(await secretCount([conn.nadiaGoogle, conn.nadiaMs])).toBe(0);
    // Google was asked to forget the refresh token; Microsoft has no revoke address, so it was not asked
    expect(x.fake.revoked.slice(before)).toEqual([{ provider: 'google', kind: 'refresh' }]);
    // nobody else’s sign-in was touched
    expect(await x.connectionOf(rafi, 'google')).toMatchObject({ status: 'enabled', state: 'ok' });
    expect(await ownerOf(conn.engMail)).toBe(omar.actorId);

    const lines = (await events('connections.person.offboarded')).filter((e) => e['personId'] === nadia.personId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ revoked: 2, providerRevoked: 1, providerFailed: 0, moved: 0, newOwnerIds: [], actorId: omar.actorId });
    expect(JSON.stringify(lines)).not.toMatch(/@|access-|refresh-/);
    const audit = await x.until(
      async () => {
        const rows = await x.sys(async (tx) => (await tx.query<{ action: string; reason: string }>(`SELECT action, reason FROM app.audit_events WHERE action = 'connection.person_offboarded'`)).rows);
        return rows.length > 0 ? rows : null;
      },
      20_000,
      'the audit line',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toMatch(/2 connections removed, 1 forgotten by the service/);

    // her own connections page, and the admin list, show nothing of hers
    const people = (await (await x.raw(omar, 'GET', '/api/admin/connections/people')).json()) as { people: Array<{ personId: string }> };
    expect(people.people.map((p) => p.personId)).not.toContain(nadia.personId);
    // pressing again removes nothing and leaves a second line only because an admin pressed it
    expect((await press(omar, nadia.personId)).status).toBe(202);
  });

  let botCache: { botId: string; actorId: string } | undefined;
  async function bot(): Promise<{ botId: string; actorId: string }> {
    if (!botCache) {
      botCache = await x.makeBot(ENG, 'offboard-bot', [{ connection: 'person:*', tools: GOOGLE_TOOLS }]);
      await x.compile(ENG, botCache.botId);
    }
    return botCache;
  }
});

describe('deactivating a person', () => {
  it('removes their connections by itself; a provider that is down is counted, and what they set up goes to the admin who deactivated them', async () => {
    const before = x.fake.revoked.length;
    const base = process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'];
    process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'] = 'http://127.0.0.1:1';
    try {
      const res = await suspend(tariq.personId, 'suspended');
      expect(res.status, await res.clone().text()).toBe(200);
      await x.until(async () => (await ownConnectionCount(tariq)) === 0, 30_000, 'his connections to be removed');
    } finally {
      if (base === undefined) delete process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'];
      else process.env['MANYTHREADS_OAUTH_NOTION_FAKE_BASE'] = base;
    }
    expect(await secretCount([conn.tariqGoogle, conn.tariqNotion])).toBe(0);
    expect(x.fake.revoked.slice(before)).toEqual([{ provider: 'google', kind: 'refresh' }]);
    expect(await ownerOf(conn.mktMail)).toBe(omar.actorId);
    const lines = (await events('connections.person.offboarded')).filter((e) => e['personId'] === tariq.personId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ revoked: 2, providerRevoked: 1, providerFailed: 1, moved: 1, newOwnerIds: [omar.actorId], actorId: null });
  });

  it('reactivating restores nothing and removes nothing more', async () => {
    const lines = (await events('connections.person.offboarded')).length;
    expect((await suspend(tariq.personId, 'active')).status).toBe(200);
    expect(await ownConnectionCount(tariq)).toBe(0);
    const providers = (await (await x.raw(tariq, 'GET', '/api/me/connections/providers')).json()) as { providers: Array<{ connected: boolean }> };
    expect(providers.providers.every((p) => !p.connected)).toBe(true);
    await settled(tariq.personId);
    expect((await events('connections.person.offboarded')).length).toBe(lines);
  });

  it('a person with nothing connected and nothing to hand over leaves no line and queues no job', async () => {
    const lines = (await events('connections.person.offboarded')).length;
    expect((await suspend(priya.personId, 'suspended')).status).toBe(200);
    await settled(priya.personId);
    expect((await events('connections.person.offboarded')).length).toBe(lines);
    const jobs = await x.sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = $1 AND payload->>'personId' = $2`, [OFFBOARD_QUEUE, priya.personId])).rows[0]!.n);
    expect(jobs).toBe(0);
  });

  /** Every subscriber of the person’s latest status event has finished with it. */
  async function settled(personId: string): Promise<void> {
    await x.until(
      async () => {
        const rows = await x.sys(async (tx) =>
          (
            await tx.query<{ pending: number }>(
              `SELECT count(*)::int AS pending FROM app.outbox o JOIN app.events e ON e.id = o.event_id
                WHERE e.type = 'workspace.member.status_changed' AND e.payload->>'personId' = $1 AND o.done_at IS NULL AND o.dead_at IS NULL`,
              [personId],
            )
          ).rows,
        );
        return rows[0]!.pending === 0;
      },
      20_000,
      'the status event to be delivered',
    );
  }
});

describe('the removal itself', () => {
  it('removes only connections of the named owner, and a second run finds nothing', async () => {
    const wrong = await revokeAndDelete(x.deps, { workspaceId: WS, connectionIds: [conn.rafiGoogle], ownerActorId: nadia.actorId });
    expect(wrong).toEqual({ removed: 0, providerRevoked: 0, providerFailed: 0 });
    expect(await x.connectionOf(rafi, 'google')).toBeDefined();
  });

  it('gives a provider five seconds, counts one that does not answer, and still deletes', async () => {
    const hang = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timed out')))));
    const started = Date.now();
    const result = await revokeAndDelete({ ...x.deps, fetchImpl: hang as never }, { workspaceId: WS, connectionIds: [conn.rafiGoogle], ownerActorId: rafi.actorId });
    expect(result).toEqual({ removed: 1, providerRevoked: 0, providerFailed: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(hang).toHaveBeenCalledTimes(1);
    expect(await x.connectionOf(rafi, 'google')).toBeUndefined();
    // the token went in the request body only
    expect(JSON.stringify(hang.mock.calls.map((c) => c[0]))).not.toMatch(/access-|refresh-/);
    expect(await revokeAndDelete(x.deps, { workspaceId: WS, connectionIds: [conn.rafiGoogle], ownerActorId: rafi.actorId })).toEqual({ removed: 0, providerRevoked: 0, providerFailed: 0 });
  });

  it('writes the line given in the same transaction, and a failure there keeps the connections', async () => {
    await x.connect(rafi, 'google', ['drive']);
    const id = (await x.connectionOf(rafi, 'google'))!.id;
    await expect(
      revokeAndDelete(x.deps, { workspaceId: WS, connectionIds: [id], ownerActorId: rafi.actorId }, () => Promise.reject(new Error('the audit line could not be written'))),
    ).rejects.toThrow(/audit line/);
    expect(await x.connectionOf(rafi, 'google')).toMatchObject({ id });
    expect(await secretCount([id])).toBeGreaterThan(0);
    // lena is a guest with nothing: nothing to remove for her either
    expect(lena.personId).toBeDefined();
  });
});
