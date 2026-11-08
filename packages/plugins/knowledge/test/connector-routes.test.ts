import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOLDER } from '../../../test-utils/src/fake-providers-data.ts';
import { personas, startAdminWorld, type AdminWorld } from '../../connections/test/admin-world.ts';
import { setDocumentsConnectorForTests } from '../src/connector-sync.ts';

// Bundle D, P16-08 (work package D2): the routes that add a connected-app source to a base, list the folders and services a person can pick, remove a Personal source and show the admin's
// health rows. A real server, the real connections plugin and a fake Google Drive.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, priya, tariq } = personas;

let x: AdminWorld;

interface Source { id: string; kind: string; provider?: string; status?: string; label: string | null; remoteRoot?: string | null; readWith?: string | null }
const folder = (id: string, name: string) => ({ id, name, mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
const add = (who: typeof omar, body: Record<string, unknown>, path = '/api/teams/engineering/knowledge/wiki/connector-sources') => x.w.call<{ source: Source; message?: string }>(who, 'POST', path, body);

beforeAll(async () => {
  x = await startAdminWorld();
  await x.sys(async (tx) => {
    for (const p of [omar, nadia, rafi, priya, tariq]) {
      await tx.query('INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', [p.workspaceId, p.personId, p.email]);
    }
  });
  await x.connect(omar, 'google', ['drive']);
  x.fake.putFile(omar.email, folder('folder-a', 'Plans'));
  x.fake.putFile(omar.email, folder('folder-b', 'Notes'));
  for (let i = 0; i < 10; i++) x.fake.putFile(omar.email, folder(`cap-${String(i)}`, `Cap ${String(i)}`));
  expect((await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'wiki', name: 'Wiki' })).status).toBe(201);
  expect((await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'capped', name: 'Capped' })).status).toBe(201);
  expect((await x.w.call(omar, 'POST', '/api/me/knowledge', { slug: 'mine', name: 'Mine' })).status).toBe(201);
  expect((await x.w.call(nadia, 'POST', '/api/me/knowledge', { slug: 'drive', name: 'My Drive' })).status).toBe(201);
  expect((await x.w.call(priya, 'POST', '/api/me/knowledge', { slug: 'notes', name: 'Notes' })).status).toBe(201);
}, 240_000);

afterAll(async () => {
  setDocumentsConnectorForTests(undefined);
  // the first read of every source added here is queued; let the queue empty so the server closes quietly
  const deadline = Date.now() + 30_000;
  while (x && Date.now() < deadline) {
    const left = await x.sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'knowledge.connector' AND state IN ('ready', 'running')`)).rows[0]!.n);
    if (left === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await x?.close();
});

describe('which services and folders a person can pick', () => {
  it('lists only the services the person has connected', async () => {
    expect((await x.w.call<{ providers: string[] }>(omar, 'GET', '/api/me/knowledge-providers')).body).toEqual({ providers: ['google_drive'] });
    expect((await x.w.call<{ providers: string[] }>(nadia, 'GET', '/api/me/knowledge-providers')).body).toEqual({ providers: [] });
  });

  it('lists the folders of the person\'s own connection; a person who has not connected gets "not connected" and no folders', async () => {
    const mine = await x.w.call<{ roots: Array<{ id: string; name: string }>; connected: boolean }>(omar, 'GET', '/api/me/knowledge-roots?provider=google_drive');
    expect(mine.status).toBe(200);
    expect(mine.body.connected).toBe(true);
    expect(mine.body.roots.map((r) => r.id)).toEqual(expect.arrayContaining(['folder-a', 'folder-b']));
    const theirs = await x.w.call<{ roots: unknown[]; connected: boolean }>(nadia, 'GET', '/api/me/knowledge-roots?provider=google_drive');
    expect(theirs.body).toEqual({ roots: [], connected: false });
    expect((await x.w.call(omar, 'GET', '/api/me/knowledge-roots?provider=evernote')).status).toBe(400);
  });
});

describe('adding a source to a team base', () => {
  it('is for a lead or admin; a member is refused', async () => {
    const r = await add(nadia, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true });
    expect(r.status).toBe(403);
    // a lead of another team is no lead here
    expect([403, 404]).toContain((await add(tariq, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true })).status);
  });

  it('needs the sentence about the team rule to be confirmed', async () => {
    const missing = await add(omar, { provider: 'google_drive', root: 'folder-a' });
    expect(missing.status).toBe(400);
    const no = await add(omar, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: false });
    expect(no.status).toBe(400);
    expect(JSON.stringify(no.body)).toMatch(/everyone on Engineering can already open/);
  });

  it('refuses a folder the person\'s connection cannot open', async () => {
    const r = await add(omar, { provider: 'google_drive', root: 'folder-nobody-has', acknowledgeTeamRule: true });
    expect(r.status).toBe(400);
  });

  it('says to connect first when the person has no connection to the service', async () => {
    const r = await add(omar, { provider: 'notion', root: 'page-1', acknowledgeTeamRule: true });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/Connect Notion first/);
  });

  it('makes the source with the caller\'s own connection, names it after the folder, and starts the first read', async () => {
    const r = await add(omar, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.source).toMatchObject({ kind: 'connector', provider: 'google_drive', status: 'ready', label: 'Plans', readWith: 'Omar’s Google Drive' });
    const row = await x.sys(async (tx) =>
      (await tx.query<{ granted_by: string; connection_id: string | null; team_id: string | null }>('SELECT granted_by, connection_id, team_id FROM app.knowledge_sources WHERE id = $1', [r.body.source.id])).rows[0],
    );
    expect(row?.granted_by).toBe(omar.personId);
    expect(row?.connection_id).not.toBeNull();
    expect(row?.team_id).not.toBeNull();
    const jobs = await x.sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'knowledge.connector'`)).rows[0]!.n);
    expect(jobs).toBeGreaterThan(0);
  });

  it('refuses the same folder twice in a base, and takes another folder', async () => {
    expect((await add(omar, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true })).status).toBe(409);
    expect((await add(omar, { provider: 'google_drive', root: 'folder-b', acknowledgeTeamRule: true, label: 'Team notes' })).body.source).toMatchObject({ label: 'Team notes' });
  });

  it('takes at most 10 sources in a base; the eleventh is refused in plain words', async () => {
    const path = '/api/teams/engineering/knowledge/capped/connector-sources';
    for (let i = 0; i < 10; i++) expect((await add(omar, { provider: 'google_drive', root: `cap-${String(i)}`, acknowledgeTeamRule: true }, path)).status, `source ${String(i)}`).toBe(201);
    const eleventh = await add(omar, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true }, path);
    expect(eleventh.status).toBe(409);
    expect(JSON.stringify(eleventh.body)).toMatch(/10/);
  });

  it('an unknown base is not found', async () => {
    expect((await add(omar, { provider: 'google_drive', root: 'folder-a', acknowledgeTeamRule: true }, '/api/teams/engineering/knowledge/nothing/connector-sources')).status).toBe(404);
  });
});

describe('a Personal base', () => {
  it('takes a source from its owner\'s own connection, and nobody else may add to it', async () => {
    const mine = await add(omar, { provider: 'google_drive', root: 'folder-a' }, '/api/me/knowledge/mine/connector-sources');
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.source).toMatchObject({ kind: 'connector', provider: 'google_drive', label: 'Plans' });
    // Nadia's base has the name "drive"; Rafi has no such base
    expect((await add(rafi, { provider: 'google_drive', root: 'folder-a' }, '/api/me/knowledge/drive/connector-sources')).status).toBe(404);
    // Nadia has not connected Google
    const none = await add(nadia, { provider: 'google_drive', root: 'folder-a' }, '/api/me/knowledge/drive/connector-sources');
    expect(none.status).toBe(409);
    expect(JSON.stringify(none.body)).toMatch(/Connect Google Drive first/);
    // Omar cannot add to Nadia's base by naming it: a Personal base is looked up by its owner
    expect((await add(omar, { provider: 'google_drive', root: 'folder-a' }, '/api/me/knowledge/drive/connector-sources')).status).toBe(404);
  });

  it('its owner removes a source and its documents; the second try and another person find nothing', async () => {
    const mine = await x.w.call<{ sources: Source[] }>(omar, 'GET', '/api/me/knowledge/mine');
    const source = mine.body.sources.find((s) => s.kind === 'connector') as Source;
    expect(source).toBeDefined();
    expect((await x.w.call(rafi, 'DELETE', `/api/me/knowledge/mine/sources/${source.id}`)).status).toBe(404);
    expect((await x.w.call(nadia, 'DELETE', `/api/me/knowledge/mine/sources/${source.id}`)).status).toBe(404);
    const gone = await x.w.call<{ removed: boolean; documents: number }>(omar, 'DELETE', `/api/me/knowledge/mine/sources/${source.id}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body.removed).toBe(true);
    expect((await x.w.call(omar, 'DELETE', `/api/me/knowledge/mine/sources/${source.id}`)).status).toBe(404);
    expect((await x.w.call<{ sources: Source[] }>(omar, 'GET', '/api/me/knowledge/mine')).body.sources.filter((s) => s.kind === 'connector')).toEqual([]);
  });

  it('a Personal base\'s upload source cannot be removed this way', async () => {
    const mine = await x.w.call<{ sources: Source[] }>(omar, 'GET', '/api/me/knowledge/mine');
    const upload = mine.body.sources.find((s) => s.kind === 'upload');
    if (upload) expect((await x.w.call(omar, 'DELETE', `/api/me/knowledge/mine/sources/${upload.id}`)).status).toBe(409);
  });
});

describe('removing a team source', () => {
  it('is for a lead or admin and takes the source out of the base', async () => {
    const detail = await x.w.call<{ sources: Source[] }>(omar, 'GET', '/api/teams/engineering/knowledge/wiki');
    const source = detail.body.sources.find((s) => s.label === 'Team notes') as Source;
    expect(source).toBeDefined();
    expect((await x.w.call(nadia, 'DELETE', `/api/teams/engineering/knowledge/wiki/sources/${source.id}`)).status).toBe(403);
    expect((await x.w.call(omar, 'DELETE', `/api/teams/engineering/knowledge/wiki/sources/${source.id}`)).status).toBe(200);
    const after = await x.w.call<{ sources: Source[] }>(omar, 'GET', '/api/teams/engineering/knowledge/wiki');
    expect(after.body.sources.map((s) => s.label)).not.toContain('Team notes');
  });
});

describe('the admin\'s health rows', () => {
  interface Row { connector: string; area: string; people: number; shared: number; needsReconnect: number; calls7d: number; failures7d: number; refused7d: Record<string, number>; lastUsedAt: string | null; problem: string | null }

  it('are for admins only', async () => {
    expect((await x.w.call(nadia, 'GET', '/api/admin/knowledge/connector-health')).status).toBe(403);
    expect((await x.w.call(priya, 'GET', '/api/admin/knowledge/connector-health')).status).toBe(403);
    expect((await x.w.call(omar, 'GET', '/api/admin/knowledge/connector-health')).status).toBe(200);
  });

  it('have the shape of every other area, count people and shared sources, and never carry a name, an address or a folder', async () => {
    const r = await x.w.call<{ rows: Row[] }>(omar, 'GET', '/api/admin/knowledge/connector-health');
    const row = r.body.rows.find((o) => o.connector === 'google_drive') as Row;
    expect(row).toMatchObject({ area: 'knowledge', people: 1, needsReconnect: 0 });
    expect(row.shared).toBeGreaterThanOrEqual(11);
    expect(row.refused7d).toEqual(expect.any(Object));
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/Plans|Team notes|Cap \d|kahf\.example|folder-/);
  });

  it('say so when a source waits for a sign-in that is gone', async () => {
    await x.sys((tx) => tx.query(`UPDATE app.knowledge_sources SET status = 'paused' WHERE id = (SELECT id FROM app.knowledge_sources WHERE kind = 'connector' LIMIT 1)`));
    const r = await x.w.call<{ rows: Row[] }>(omar, 'GET', '/api/admin/knowledge/connector-health');
    const row = r.body.rows.find((o) => o.connector === 'google_drive') as Row;
    expect(row.needsReconnect).toBe(1);
    expect(row.problem).toMatch(/paused/);
  });
});
