import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOLDER } from '../../../test-utils/src/fake-providers-data.ts';
import { personas, startAdminWorld, TEAM_IDS, type AdminWorld } from '../../connections/test/admin-world.ts';
import { setDocumentsConnectorForTests } from '../src/connector-sync.ts';

// Bundle D, P16-08 (work package D2): reading a connected app into a base, end to end. A real server, the real connections plugin and its documents door, and a fake Google Drive. The team rule
// (decision D14, PLAN criterion 6): a file shared with only Nadia and Rafi is not in the Engineering base, it is found by Nadia's own Personal base, Priya finds nothing of it; a file made public
// appears on the next pass; one shared with a group is skipped.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, priya, tariq } = personas;
const OMAR_DRIVE = omar.email;
const NADIA_DRIVE = nadia.email;

let x: AdminWorld;
const text = (s: string): string => s;

interface Source { id: string; kind: string; provider?: string; status?: string; label: string | null; remoteRoot?: string | null; readWith?: string | null; skippedLimited?: number; documentCount?: number; error: string | null; lastSyncedAt: string | null }
interface Doc { id: string; name: string; status: string; source: string }
const teamDetail = async (who = omar) => {
  const r = await x.w.call<{ documents: Doc[]; sources: Source[] }>(who, 'GET', '/api/teams/engineering/knowledge/wiki');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const names = async (who = omar): Promise<string[]> => (await teamDetail(who)).documents.map((d) => d.name).sort();
const connectorSource = async (): Promise<Source> => (await teamDetail()).sources.find((s) => s.kind === 'connector') as Source;

/** Waits until the queue of connector passes is empty (a pass, and the follow-ups of a long one), and makes delayed ones run now. */
async function idle(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let quiet = 0;
  while (Date.now() < deadline) {
    const left = await x.sys(async (tx) => {
      await tx.query(`UPDATE app.jobs SET run_at = now() WHERE queue = 'knowledge.connector' AND state = 'ready' AND run_at > now()`);
      await tx.query(`SELECT pg_notify('manythreads_jobs', 'knowledge.connector')`);
      return (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'knowledge.connector' AND state IN ('ready', 'running', 'failed')`)).rows[0]!.n;
    });
    quiet = left === 0 ? quiet + 1 : 0;
    if (quiet >= 3) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const dead = await x.sys(async (tx) => (await tx.query<{ last_error: string | null }>(`SELECT last_error FROM app.jobs WHERE queue = 'knowledge.connector' AND state = 'dead'`)).rows);
  expect(dead, JSON.stringify(dead)).toEqual([]);
}

const file = (id: string, name: string, body: string, parentId: string, permissions: Array<{ type: 'anyone' } | { type: 'domain'; domain: string } | { type: 'user'; email: string } | { type: 'group'; email: string }> = []) => ({
  id,
  name,
  mimeType: 'text/plain',
  modified: '2026-11-01T00:00:00.000Z',
  text: body,
  parentId,
  permissions,
});

const everyone = [omar, nadia, rafi, priya].map((p) => ({ type: 'user' as const, email: p.email }));

beforeAll(async () => {
  x = await startAdminWorld();
  // the workspace has verified the addresses of the Engineering team (the rule counts only verified ones)
  await x.sys(async (tx) => {
    for (const p of [omar, nadia, rafi, priya, tariq]) {
      await tx.query('INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', [p.workspaceId, p.personId, p.email]);
    }
  });
  await x.connect(omar, 'google', ['drive']);
  await x.connect(nadia, 'google', ['drive']);
  const f = x.fake;
  f.putFile(OMAR_DRIVE, { id: 'folder-eng', name: 'Engineering', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
  f.putFile(OMAR_DRIVE, file('f-public', 'Public handbook', text('Visitors sign in at the front desk and wear a badge.'), 'folder-eng', [{ type: 'anyone' }]));
  f.putFile(OMAR_DRIVE, file('f-domain', 'Engineering handbook', text('On-call engineers carry the pager for one week at a time.'), 'folder-eng', [{ type: 'domain', domain: 'kahf.example' }]));
  f.putFile(OMAR_DRIVE, file('f-private', 'Salary review', text('The salary review for Nadia and Rafi is on Friday.'), 'folder-eng', [{ type: 'user', email: nadia.email }, { type: 'user', email: rafi.email }]));
  f.putFile(OMAR_DRIVE, file('f-group', 'Group plan', text('The group plan for the offsite is the lighthouse trip.'), 'folder-eng', [{ type: 'group', email: 'eng-all@kahf.example' }]));
  f.putFile(OMAR_DRIVE, file('f-owner', 'Private draft', text('Only the owner has seen this private draft of the reorganisation.'), 'folder-eng'));
  f.putFile(OMAR_DRIVE, file('f-all-listed', 'Listed one by one', text('Everyone on the team is listed by name on this rota.'), 'folder-eng', everyone));
  // Nadia's own Drive holds her copy of the private file
  f.putFile(NADIA_DRIVE, { id: 'folder-nadia', name: 'Nadia notes', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
  f.putFile(NADIA_DRIVE, file('n-private', 'Salary review', text('The salary review for Nadia and Rafi is on Friday.'), 'folder-nadia', [{ type: 'user', email: rafi.email }]));
  expect((await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'wiki', name: 'Wiki' })).status).toBe(201);
  expect((await x.w.call(nadia, 'POST', '/api/me/knowledge', { slug: 'drive', name: 'My Drive' })).status).toBe(201);
}, 240_000);

afterAll(async () => {
  setDocumentsConnectorForTests(undefined);
  await x?.close();
});

describe('a team source keeps to what everyone on the team may open', () => {
  it('copies the public file, the domain file and the file with every member listed; leaves out the private, group and owner-only ones; says how many without naming them', async () => {
    const added = await x.w.call<{ source: Source }>(omar, 'POST', '/api/teams/engineering/knowledge/wiki/connector-sources', { provider: 'google_drive', root: 'folder-eng', acknowledgeTeamRule: true });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.source).toMatchObject({ kind: 'connector', provider: 'google_drive', status: 'ready', label: 'Engineering', readWith: 'Omar’s Google Drive', error: null });
    await idle();
    expect(await names()).toEqual(['Engineering handbook', 'Listed one by one', 'Public handbook']);
    const source = await connectorSource();
    expect(source).toMatchObject({ status: 'ready', skippedLimited: 3, documentCount: 3, error: null });
    expect(source.lastSyncedAt).not.toBeNull();
    // the page shows a count, never the names of what was left out
    expect(JSON.stringify(source)).not.toMatch(/Salary|Group plan|Private draft/);
  });

  it('the file shared with only Nadia and Rafi is not in the Engineering base: Priya finds nothing of it, and neither does anyone else on the team', async () => {
    for (const who of [priya, omar, nadia, rafi]) {
      const found = await x.w.call<{ hits: Array<{ text: string }> }>(who, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=salary%20review');
      expect(found.status).toBe(200);
      expect(JSON.stringify(found.body.hits), who.name).not.toMatch(/salary/i);
    }
    const handbook = await x.w.call<{ hits: Array<{ text: string }> }>(priya, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=pager');
    expect(handbook.body.hits[0]?.text).toContain('pager');
    // the document keeps its identity at the service
    const row = await x.sys(async (tx) => (await tx.query<{ remote_id: string; remote_version: string; remote_url: string | null; source: string }>(
      `SELECT d.remote_id, d.remote_version, d.remote_url, s.kind AS source FROM app.knowledge_documents d JOIN app.knowledge_sources s ON s.id = d.source_id WHERE d.name = 'Public handbook'`,
    )).rows[0]);
    expect(row).toMatchObject({ remote_id: 'f-public', source: 'connector' });
    expect(row?.remote_version).not.toBe('');
  });

  it('is found by Nadia\'s own Personal base when she adds her own source, and not by Priya', async () => {
    const added = await x.w.call<{ source: Source }>(nadia, 'POST', '/api/me/knowledge/drive/connector-sources', { provider: 'google_drive', root: 'folder-nadia' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.source).toMatchObject({ readWith: 'Nadia’s Google Drive', label: 'Nadia notes' });
    await idle();
    const mine = await x.w.call<{ hits: Array<{ text: string }> }>(nadia, 'GET', '/api/me/knowledge/drive/search?q=salary%20review');
    expect(mine.body.hits[0]?.text).toContain('salary review');
    const detail = await x.w.call<{ documents: Doc[]; sources: Source[] }>(nadia, 'GET', '/api/me/knowledge/drive');
    expect(detail.body.documents.map((d) => d.name)).toEqual(['Salary review']);
    expect(detail.body.sources.find((s) => s.kind === 'connector')).toMatchObject({ status: 'ready', documentCount: 1, skippedLimited: 0 });
    // nobody else reads a Personal base
    expect((await x.w.call(priya, 'GET', '/api/me/knowledge/drive')).status).toBe(404);
    const priyas = await x.w.call<{ bases: unknown[] }>(priya, 'GET', '/api/me/knowledge');
    expect(priyas.body.bases).toEqual([]);
  });

  it('a file made public appears on the next pass; one shared with a group stays out', async () => {
    x.fake.setFilePermissions(OMAR_DRIVE, 'f-private', [{ type: 'anyone' }]);
    x.fake.setFilePermissions(OMAR_DRIVE, 'f-group', [{ type: 'group', email: 'eng-all@kahf.example' }, { type: 'domain', domain: 'kahf.example' }]);
    expect((await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync')).status).toBe(200);
    await idle();
    expect(await names()).toEqual(['Engineering handbook', 'Listed one by one', 'Public handbook', 'Salary review']);
    expect(await connectorSource()).toMatchObject({ skippedLimited: 2, documentCount: 4 });
    const found = await x.w.call<{ hits: Array<{ text: string }> }>(priya, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=salary%20review');
    expect(found.body.hits[0]?.text).toContain('salary review');
  });

  it('a file that stops being open to everyone is taken out again', async () => {
    x.fake.setFilePermissions(OMAR_DRIVE, 'f-private', [{ type: 'user', email: nadia.email }]);
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await names()).toEqual(['Engineering handbook', 'Listed one by one', 'Public handbook']);
    const found = await x.w.call<{ hits: unknown[] }>(priya, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=salary');
    expect(found.body.hits).toEqual([]);
  });

  it('a new member of the team is a person the listed-by-name file does not cover: the next pass takes it out', async () => {
    expect(await names()).toContain('Listed one by one');
    const added = await x.w.call(omar, 'POST', '/api/teams/engineering/members', { personId: tariq.personId, role: 'member' });
    expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
    // the team change is an event; the job it queues is delayed a few seconds, `idle` makes it run
    for (let i = 0; i < 40 && (await names()).includes('Listed one by one'); i++) {
      await idle();
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await names()).toEqual(['Engineering handbook', 'Public handbook']);
    // the domain file still stands (Tariq's verified address is at the same domain)
    expect(await connectorSource()).toMatchObject({ documentCount: 2 });
  });
});

describe('what changes at the service', () => {
  it('an edited file is a new version of the same document, a deleted one is removed, a new one is added', async () => {
    const before = (await teamDetail()).documents.find((d) => d.name === 'Public handbook') as Doc & { version?: number };
    x.fake.putFile(OMAR_DRIVE, file('f-public', 'Public handbook', text('Visitors sign in at the front desk and wear a green badge.'), 'folder-eng', [{ type: 'anyone' }]));
    x.fake.putFile(OMAR_DRIVE, file('f-new', 'Fire drill', text('The fire drill is on the first Monday of every month.'), 'folder-eng', [{ type: 'anyone' }]));
    x.fake.removeFile(OMAR_DRIVE, 'f-domain');
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await names()).toEqual(['Fire drill', 'Public handbook']);
    const after = (await teamDetail()).documents.find((d) => d.name === 'Public handbook') as Doc & { version?: number };
    expect(after.id).toBe(before.id);
    const found = await x.w.call<{ hits: Array<{ text: string; version: number }> }>(priya, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=green%20badge');
    expect(found.body.hits[0]).toMatchObject({ version: 2 });
  });

  it('a file moved out of the folder is dropped when the folder is read in full again', async () => {
    x.fake.putFile(OMAR_DRIVE, file('f-new', 'Fire drill', text('The fire drill is on the first Monday of every month.'), 'root', [{ type: 'anyone' }]));
    // (the file of the next test comes in with this read: the Re-sync route lets a lead press ten times a minute, and this file already uses them)
    x.fake.putFile(OMAR_DRIVE, file('f-quiet', 'Quiet note', text('The quiet note is about the lighthouse keys.'), 'folder-eng', [{ type: 'anyone' }]));
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await names()).toEqual(['Public handbook', 'Quiet note']);
  });

  it('a file that stops being open to everyone is taken out by a full read even when the service does not move its version', async () => {
    expect(await names()).toEqual(['Public handbook', 'Quiet note']);
    // the sharing changes at the service, and the stored version is the one it lists (a sharing change is not an edit)
    x.fake.setFilePermissions(OMAR_DRIVE, 'f-quiet', [{ type: 'user', email: nadia.email }]);
    const listed = (await x.sys(async (tx) => (await tx.query<{ remote_version: string }>(`SELECT remote_version FROM app.knowledge_documents WHERE remote_id = 'f-quiet'`)).rows[0]))?.remote_version;
    await x.sys(async (tx) => {
      await tx.query(`UPDATE app.knowledge_documents SET remote_version = $1 WHERE remote_id = 'f-quiet'`, [String(Number(listed) + 1)]);
    });
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await names()).toEqual(['Public handbook']);
    const found = await x.w.call<{ hits: unknown[] }>(priya, 'GET', '/api/teams/engineering/knowledge/wiki/search?q=lighthouse%20keys');
    expect(found.body.hits).toEqual([]);
  });

  it('a pass reads at most 100 documents; the rest follow on their own, and nothing is read twice', async () => {
    for (let i = 0; i < 130; i++) x.fake.putFile(OMAR_DRIVE, file(`bulk-${String(i)}`, `Bulk ${String(i).padStart(3, '0')}`, text(`Bulk note number ${String(i)} about the harbour crane.`), 'folder-eng', [{ type: 'anyone' }]));
    const calls = x.fake.apiCalls.length;
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    const all = await names();
    // 130 new files and the one that stays: the base holds at most 200 documents
    expect(all).toHaveLength(131);
    const source = await connectorSource();
    expect(source).toMatchObject({ status: 'ready', documentCount: 131 });
    expect(x.fake.apiCalls.length - calls).toBeGreaterThan(130);
    // the same read again changes nothing and fetches no document
    const fetched = x.fake.apiCalls.length;
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await names()).toHaveLength(131);
    const again = x.fake.apiCalls.slice(fetched).filter((c) => c.path.includes('/files/bulk-') && !c.path.endsWith('/permissions'));
    expect(again).toEqual([]);
  });
});

describe('when the service or the connection fails', () => {
  it('an answer that could not be had removes nothing and changes nothing: the source asks for attention and the next good pass puts it right', async () => {
    const before = await names();
    x.fake.failNextApi(500, 1000);
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    const hurt = await connectorSource();
    expect(hurt.status).toBe('attention');
    expect(hurt.error).toMatch(/did not answer/);
    expect(await names()).toEqual(before);
    x.fake.failNextApi(500, 0);
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    expect(await connectorSource()).toMatchObject({ status: 'ready', error: null });
    expect(await names()).toEqual(before);
  });

  it('a sign-in that is gone pauses the source in plain words and keeps what is indexed', async () => {
    const before = await names();
    // the person takes the access away at the service
    x.fake.expireAccessTokens();
    x.fake.revokeRefreshTokens();
    await x.w.call(omar, 'POST', '/api/teams/engineering/knowledge/wiki/resync');
    await idle();
    const paused = await connectorSource();
    expect(paused).toMatchObject({ status: 'paused', error: 'Omar’s Google Drive is no longer connected.' });
    expect(await names()).toEqual(before);
    // the base asks for attention too
    const base = await x.w.call<{ base: { state: string } }>(omar, 'GET', '/api/teams/engineering/knowledge/wiki');
    expect(base.body.base.state).toBe('attention');
  });

  it('events carry ids and counts, never a document name, text, address or token', async () => {
    const events = await x.sys(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'knowledge.source.synced' ORDER BY id`)).rows.map((r) => r.payload));
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['added', 'at', 'baseId', 'ownerPersonId', 'provider', 'removed', 'skippedLimited', 'sourceId', 'status', 'teamId', 'updated']);
    }
    const dump = JSON.stringify(events);
    expect(dump).not.toMatch(/Salary|handbook|badge|@kahf|access-|refresh-/i);
    expect(events.some((e) => e['teamId'] === TEAM_IDS.Engineering && e['skippedLimited'] === 3)).toBe(true);
    expect(events.some((e) => e['ownerPersonId'] === nadia.personId && e['teamId'] === null)).toBe(true);
  });
});
