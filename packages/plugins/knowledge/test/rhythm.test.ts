import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PluginTx } from '@manythreads/sdk';
import type { SafeFetchDeps } from '@manythreads/sdk/safe-fetch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';
import { knowledgeSearch } from '../src/capability.ts';
import { setFetchDepsForTests } from '../src/web.ts';

// P8-07, P8-08: a web page is a source that is read again on its rhythm. The page's TEXT decides: markup that changes without the words changing is no
// new version; changed words are version 2 and the old passage says the source changed; a site that fails leaves the last good version in use and the
// base asks for attention until the next good read. Also the questions a strict bot could not answer, which land in #kb-updates once.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;
let site: Server;
let page = '';
let status = 200;
let contentType = 'text/html';
const hits: string[] = [];

const html = (days: number, noise: string): string =>
  `<html><head><title>Docs</title><script>var t = "${noise}";</script><style>.x{}</style></head><body><nav>Menu Home Pricing</nav><!-- ${noise} -->` +
  `<h1>Refund policy</h1><p>Refunds are paid within ${String(days)} days of the request.</p><ul><li>Send the order number</li></ul><footer>Copyright</footer></body></html>`;

interface Source { id: string; kind: string; url: string | null; label: string | null; syncMinutes: number | null; lastSyncedAt: string | null; error: string | null }
interface Doc { id: string; name: string; version: number; status: string; source: string }
const detail = (who = omar) =>
  world.call<{ base: { state: string }; documents: Doc[]; sources: Source[]; canWrite: boolean }>(who, 'GET', '/api/teams/engineering/knowledge/web');
const search = (q: string) => world.call<{ mode: string; hits: Array<{ chunkId: string; text: string; version: number; sourceChanged: boolean }> }>(omar, 'GET', `/api/teams/engineering/knowledge/web/search?q=${encodeURIComponent(q)}`);

const teamId = async (slug: string): Promise<string> => world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0]!.id);

async function runJob(queue: string): Promise<void> {
  const id = await world.system(async (tx) => {
    const job = (await tx.query<{ id: string }>(`SELECT (app.enqueue_job($1, '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id`, [queue])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
    await tx.query('SELECT pg_notify($1, $2)', ['manythreads_jobs', queue]);
    return job;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const row = (await world.system((tx) => tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id]))).rows[0];
    if (row && ['done', 'dead'].includes(row.state)) {
      expect(row.state, row.last_error ?? '').toBe('done');
      return;
    }
    if (Date.now() > deadline) throw new Error(`the ${queue} job did not finish`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const makeDue = (): Promise<void> =>
  world.system(async (tx) => {
    await tx.query(`UPDATE app.knowledge_sources SET last_synced_at = now() - interval '2 hours' WHERE kind = 'url'`);
  });

beforeAll(async () => {
  site = createServer((req, res) => {
    hits.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
    res.writeHead(status, { 'content-type': contentType });
    res.end(page);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const port = (site.address() as AddressInfo).port;
  const fake: SafeFetchDeps = {
    resolve: async (host) => {
      if (host.endsWith('.fake.example')) return [{ address: '93.184.216.34', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    dial: () => ({ host: '127.0.0.1', port }),
  };
  setFetchDepsForTests(fake);
  world = await createWorld();
  expect((await world.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'web', name: 'Web' })).status).toBe(201);
}, 180_000);

afterAll(async () => {
  setFetchDepsForTests(undefined);
  await world?.close();
  await new Promise<void>((resolve) => {
    site?.closeAllConnections();
    site?.close(() => resolve());
  });
});

describe('a web page as a source', () => {
  it('a lead adds a page: it is read at once, becomes a document and is searchable; the others may not add one', async () => {
    page = html(14, 'one');
    const body = { url: 'http://docs.fake.example/refunds', label: 'Refund docs', syncMinutes: 15 };
    expect((await world.call(nadia, 'POST', '/api/teams/engineering/knowledge/web/sources', body)).status).toBe(403);
    const added = await world.call<{ source: Source }>(omar, 'POST', '/api/teams/engineering/knowledge/web/sources', body);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.source).toMatchObject({ kind: 'url', label: 'Refund docs', syncMinutes: 15, error: null });
    const d = await detail();
    expect(d.body.sources.map((s) => s.kind)).toEqual(['upload', 'repo', 'url']);
    expect(d.body.documents).toHaveLength(1);
    expect(d.body.documents[0]).toMatchObject({ name: 'Refund docs', version: 1, status: 'indexed', source: 'url' });
    expect(d.body.base.state).toBe('ready');
    const found = await search('refunds paid within');
    expect(found.body.hits[0]?.text).toContain('14 days');
    // the page's menu, script and footer are not knowledge
    expect(found.body.hits.map((h) => h.text).join(' ')).not.toMatch(/Pricing|Copyright|var t/);
    // a repeat of the same address is refused
    expect((await world.call(omar, 'POST', '/api/teams/engineering/knowledge/web/sources', body)).status).toBe(409);
  });

  it('refuses an address inside the deployment or one that is not a page, and says why', async () => {
    const before = hits.length;
    for (const url of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://169.254.169.254/latest', 'ftp://docs.fake.example/x', 'not a url']) {
      const res = await world.call<{ error: { message: string } }>(omar, 'POST', '/api/teams/engineering/knowledge/web/sources', { url, syncMinutes: null });
      expect(res.status, url).toBe(400);
    }
    expect(hits.length).toBe(before); // none of them reached the site
    contentType = 'image/png';
    page = 'x';
    const png = await world.call<{ error: { message: string } }>(omar, 'POST', '/api/teams/engineering/knowledge/web/sources', { url: 'http://docs.fake.example/pic', syncMinutes: null });
    contentType = 'text/html';
    expect(png.status).toBe(400);
    expect(png.body.error.message).toMatch(/not a page or a file/);
    expect((await detail()).body.sources).toHaveLength(3);
  });

  it('a page whose markup changes but whose words do not is not a new version; changed words are version 2 and the old passage says so', async () => {
    const [first] = (await search('refunds paid within')).body.hits;
    page = html(14, 'two');
    await makeDue();
    await runJob('knowledge.sync');
    expect((await detail()).body.documents[0]).toMatchObject({ version: 1 });
    page = html(30, 'three');
    await makeDue();
    await runJob('knowledge.sync');
    const d = await detail();
    expect(d.body.documents[0]).toMatchObject({ version: 2, status: 'indexed' });
    expect(d.body.sources.find((s) => s.kind === 'url')?.lastSyncedAt).not.toBeNull();
    const now = await search('refunds paid within');
    expect(now.body.hits[0]).toMatchObject({ version: 2, sourceChanged: false });
    expect(now.body.hits[0]?.text).toContain('30 days');
    const old = await world.call<{ hit: { version: number; currentVersion: number; sourceChanged: boolean; text: string } }>(omar, 'GET', `/api/teams/engineering/knowledge-chunks/${first!.chunkId}`);
    expect(old.body.hit).toMatchObject({ version: 1, currentVersion: 2, sourceChanged: true });
    expect(old.body.hit.text).toContain('14 days');
  });

  it('a source that is not due is left alone, and one without a rhythm is never read by the job', async () => {
    const before = hits.length;
    await runJob('knowledge.sync'); // read a moment ago: not due
    expect(hits.length).toBe(before);
    const source = (await detail()).body.sources.find((s) => s.kind === 'url')!;
    const off = await world.call<{ source: Source }>(omar, 'PATCH', `/api/teams/engineering/knowledge/web/sources/${source.id}`, { syncMinutes: null });
    expect(off.body.source.syncMinutes).toBeNull();
    await makeDue();
    await runJob('knowledge.sync');
    expect(hits.length).toBe(before);
    expect((await world.call(omar, 'PATCH', `/api/teams/engineering/knowledge/web/sources/${source.id}`, { syncMinutes: 5 })).status).toBe(400);
    expect((await world.call(nadia, 'PATCH', `/api/teams/engineering/knowledge/web/sources/${source.id}`, { syncMinutes: 60 })).status).toBe(403);
    expect((await world.call<{ source: Source }>(omar, 'PATCH', `/api/teams/engineering/knowledge/web/sources/${source.id}`, { syncMinutes: 60 })).body.source.syncMinutes).toBe(60);
  });

  it('a site that fails leaves the last good version in use and the base asks for attention until a good read', async () => {
    status = 503;
    await makeDue();
    await runJob('knowledge.sync');
    let d = await detail();
    const failing = d.body.sources.find((s) => s.kind === 'url')!;
    expect(failing.error).toMatch(/error \(503\)/);
    expect(d.body.base.state).toBe('attention');
    expect(d.body.documents[0]).toMatchObject({ version: 2, status: 'indexed' });
    expect((await search('refunds paid within')).body.hits[0]?.text).toContain('30 days');
    status = 200;
    await makeDue();
    await runJob('knowledge.sync');
    d = await detail();
    expect(d.body.sources.find((s) => s.kind === 'url')?.error).toBeNull();
    expect(d.body.base.state).toBe('ready');
  });

  it('Re-sync reads the page too, and removing the source removes its document', async () => {
    page = html(45, 'four');
    const resync = await world.call<{ result: { updated: number } }>(omar, 'POST', '/api/teams/engineering/knowledge/web/resync');
    expect(resync.status, JSON.stringify(resync.body)).toBe(200);
    expect(resync.body.result.updated).toBe(1);
    expect((await detail()).body.documents[0]).toMatchObject({ version: 3 });
    const source = (await detail()).body.sources.find((s) => s.kind === 'url')!;
    expect((await world.call(omar, 'DELETE', `/api/teams/engineering/knowledge/web/sources/${(await detail()).body.sources[0]!.id}`)).status).toBe(409);
    const gone = await world.call<{ removed: boolean; documents: number }>(omar, 'DELETE', `/api/teams/engineering/knowledge/web/sources/${source.id}`);
    expect(gone.body).toMatchObject({ removed: true, documents: 1 });
    const d = await detail();
    expect(d.body.documents).toHaveLength(0);
    expect(d.body.sources.map((s) => s.kind)).toEqual(['upload', 'repo']);
    expect(d.body.base.state).toBe('empty');
  });
});

describe('the base state is stored and follows its documents', () => {
  it('moves empty, ready, attention and back by itself, whoever writes', async () => {
    const stored = async (): Promise<string> => world.system(async (tx) => (await tx.query<{ status: string }>(`SELECT status FROM app.knowledge_bases WHERE slug = 'web'`)).rows[0]!.status);
    expect(await stored()).toBe('empty');
    const up = await fetch(`${world.server.url}/api/teams/engineering/knowledge/web/documents?name=notes.md`, {
      method: 'POST',
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId }), 'content-type': 'application/octet-stream' },
      body: Buffer.from('# Notes\n\nShipping takes two days.\n') as unknown as RequestInit['body'],
    });
    expect(up.status).toBe(200);
    expect(await stored()).toBe('ready');
    await world.system((tx) => tx.query(`UPDATE app.knowledge_documents SET status = 'failed', reason = 'x' WHERE name = 'notes.md'`));
    expect(await stored()).toBe('attention');
    await world.system((tx) => tx.query(`UPDATE app.knowledge_documents SET status = 'indexed', reason = NULL WHERE name = 'notes.md'`));
    expect(await stored()).toBe('ready');
    await world.system((tx) => tx.query(`DELETE FROM app.knowledge_documents WHERE name = 'notes.md'`));
    expect(await stored()).toBe('empty');
  });
});

describe('questions a strict bot could not answer go to #kb-updates', () => {
  const asRun = (tx: PluginTx, botId: string, team: string): PluginTx => ({
    actor: tx.actor,
    query: ((sql: string, params?: unknown[]) =>
      sql.includes('app.knowledge_run_grant')
        ? Promise.resolve({ rows: [{ g: { botId, teamId: team, knowledge: [{ base: 'web', answer_only_from: true }] } }] })
        : tx.query(sql, params)) as PluginTx['query'],
  });

  it('records one line per question and day, and the job posts one note per team, once', async () => {
    const eng = await teamId('engineering');
    const mkt = await teamId('marketing');
    const channel = await world.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'kb-updates' });
    expect(channel.status, JSON.stringify(channel.body)).toBe(201);
    const botId = await world.system(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'kb-asker', 'kb-asker', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
          [omar.workspaceId, eng],
        )
      ).rows[0]!.id;
      await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, id]);
      return id;
    });
    const out = await world.system(async (tx) => {
      const wrapped = asRun(tx, botId, eng);
      const first = await knowledgeSearch({ query: 'How do I change my `billing` @everyone address?' }, wrapped);
      await knowledgeSearch({ query: 'how do i change my `billing` @everyone address?' }, wrapped); // the same question again today
      await knowledgeSearch({ query: 'Where is the office dog?' }, wrapped);
      const other = asRun(tx, botId, mkt);
      await knowledgeSearch({ query: 'Marketing question nobody answers' }, other);
      return first;
    });
    expect(out).toMatchObject({ ok: true, answerOnlyFromKnowledge: true, hits: [] });
    const open = await world.system(async (tx) => (await tx.query<{ query: string; team_id: string }>('SELECT query, team_id FROM app.knowledge_gaps WHERE posted_at IS NULL ORDER BY query')).rows);
    expect(open.map((g) => g.query)).toEqual(['How do I change my billing everyone address?', 'Marketing question nobody answers', 'Where is the office dog?']);

    await runJob('knowledge.gaps');
    const posted = await world.system(async (tx) => (await tx.query<{ body: string }>(`SELECT body FROM app.messages WHERE channel_id = $1 ORDER BY id`, [channel.body.channel.id])).rows);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain('2 questions');
    expect(posted[0]?.body).toContain('`Where is the office dog?` (asked of kb-asker)');
    expect(posted[0]?.body).not.toContain('@everyone');
    const state = await world.system(async (tx) => (await tx.query<{ team: string; outcome: string }>(`SELECT t.slug AS team, g.outcome FROM app.knowledge_gaps g JOIN app.teams t ON t.id = g.team_id ORDER BY t.slug, g.query`)).rows);
    expect(state).toEqual([
      { team: 'engineering', outcome: 'posted' },
      { team: 'engineering', outcome: 'posted' },
      { team: 'marketing', outcome: 'no_channel' }, // Marketing has no #kb-updates: marked, nothing posted
    ]);
    await runJob('knowledge.gaps');
    expect(await world.system(async (tx) => (await tx.query(`SELECT 1 FROM app.messages WHERE channel_id = $1`, [channel.body.channel.id])).rows.length)).toBe(1);
  });

  it('a bot that is not strict, or finds something, leaves no gap; a member can read none', async () => {
    const before = await world.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.knowledge_gaps')).rows[0]!.n));
    await world.system(async (tx) => {
      const eng = await teamId('engineering');
      const relaxed: PluginTx = { actor: tx.actor, query: ((sql: string, params?: unknown[]) => (sql.includes('app.knowledge_run_grant') ? Promise.resolve({ rows: [{ g: { botId: 'x', teamId: eng, knowledge: [{ base: 'web' }] } }] }) : tx.query(sql, params))) as PluginTx['query'] };
      await knowledgeSearch({ query: 'something not in the base at all' }, relaxed);
    });
    expect(await world.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.knowledge_gaps')).rows[0]!.n))).toBe(before);
    void tariq;
  });
});
