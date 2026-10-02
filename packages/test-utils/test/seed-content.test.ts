import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dropTestDatabase,
  LENA,
  NADIA,
  ownerSql,
  personas,
  RAFI,
  seedWorld,
  SEED_IDS,
  startTestServer,
  type TestServer,
} from '../src/index.ts';

// Seed v3 (PLAN P3-15): content on top of the personas, needing the plugin tables, so the database comes from a started test server.
let server: TestServer;
let storage: string;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);
const as = (p: { actorId: string; workspaceId: string }): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads JSON of many shapes
const get = async (who: Parameters<typeof as>[0], path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${server.url}${path}`, { headers: as(who) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text };
};

beforeAll(async () => {
  storage = mkdtempSync(join(tmpdir(), 'manythreads-seed-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storage;
  process.env['MANYTHREADS_CLOCK'] = 'fixed';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_CLOCK'];
  if (server) await server.close();
  rmSync(storage, { recursive: true, force: true });
});

describe('seedWorld with content (seed v3)', () => {
  it('writes channels, messages, a thread, a private channel, a DM, a 5,000-message channel, a guest grant and an attachment', async () => {
    const first = await seedWorld(server.db, { content: true });
    expect(first.content).toMatchObject({ skipped: null, channels: 17, threadReplies: 12, attachments: 1 });

    // Channels from the three templates, once each, with the fixed ids.
    const channels = await sql<{ id: string; slug: string; name: string; private: boolean }>(
      `SELECT c.id, t.slug, c.name, c.private FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE c.kind = 'channel' ORDER BY t.slug, c.name`,
    );
    expect(channels).toHaveLength(17);
    for (const c of channels) expect(c.id).toBe((SEED_IDS.channels as Record<string, string>)[`${c.slug}/${c.name}`]);
    expect(channels.filter((c) => c.private).map((c) => c.name)).toEqual(['eng-leads']);
    expect(channels.filter((c) => c.slug === 'customer-support').map((c) => c.name).sort()).toEqual(['enquiries', 'escalations', 'kb-updates', 'support']);

    // About 40 messages per channel (the 5,000-message channel apart).
    const counts = await sql<{ name: string; n: number }>(
      `SELECT c.name, count(*)::int AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
        WHERE c.kind = 'channel' AND m.thread_root_id IS NULL GROUP BY c.name`,
    );
    for (const c of counts) {
      if (c.name === 'load-test') expect(c.n).toBe(5000);
      else expect(c.n, c.name).toBeGreaterThanOrEqual(25);
    }
    const byName = Object.fromEntries(counts.map((c) => [c.name, c.n]));
    expect(byName['dev']).toBeGreaterThanOrEqual(38);
    expect(byName['support']).toBeGreaterThanOrEqual(38);
    expect(byName['content']).toBeGreaterThanOrEqual(38);

    // The Deploy plan thread: a root in #dev, twelve replies from Nadia, Rafi and Omar.
    const thread = await sql<{ title: string; reply_count: number }>(`SELECT title, reply_count FROM app.threads`);
    expect(thread).toEqual([expect.objectContaining({ reply_count: 12 })]);
    expect(thread[0]?.title).toMatch(/^Deploy plan/);
    const authors = await sql<{ name: string }>(
      `SELECT DISTINCT p.display_name AS name FROM app.messages m JOIN app.actors a ON a.id = m.author_id JOIN app.people p ON p.id = a.ref_id
        WHERE m.thread_root_id IS NOT NULL ORDER BY 1`,
    );
    expect(authors.map((a) => a.name)).toEqual(['Nadia', 'Omar', 'Rafi']);
    const followers = await sql<{ name: string }>(
      `SELECT p.display_name AS name FROM app.thread_follows f JOIN app.people p ON p.id = f.person_id ORDER BY 1`,
    );
    expect(followers.map((f) => f.name)).toEqual(['Nadia', 'Omar', 'Rafi']);

    // The private channel is Omar's and Nadia's; the DM is one row between Nadia and Rafi, and Rafi asks about the rota.
    const members = await sql<{ name: string }>(
      `SELECT p.display_name AS name FROM app.channel_members cm JOIN app.people p ON p.id = cm.person_id WHERE cm.channel_id = $1 ORDER BY 1`,
      [SEED_IDS.channels['engineering/eng-leads']],
    );
    expect(members.map((m) => m.name)).toEqual(['Nadia', 'Omar']);
    const dm = await sql<{ id: string }>(`SELECT id FROM app.channels WHERE kind = 'dm'`);
    expect(dm).toHaveLength(1);
    const last = await sql<{ body: string }>(`SELECT body FROM app.messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`, [dm[0]?.id]);
    expect(last[0]?.body).toBe('Check the rota?');

    // Reactions, mentions of @rafi, one attachment, Lena's read grant on #releases.
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM app.message_reactions'))[0]?.n).toBeGreaterThan(10);
    expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM app.message_mentions WHERE mentioned_id = $1`, [RAFI.actorId]))[0]?.n).toBeGreaterThanOrEqual(2);
    expect(await sql(`SELECT 1 FROM app.files WHERE name = 'deploy-plan-v2.14.pdf' AND channel_id = $1 AND mime = 'application/pdf'`, [SEED_IDS.channels['engineering/dev']])).toHaveLength(1);
    const grants = await sql<{ resource_id: string; permission: string }>(`SELECT resource_id, permission FROM app.acl_entries WHERE subject_id = $1`, [LENA.personId]);
    expect(grants).toEqual([{ resource_id: SEED_IDS.channels['engineering/releases'], permission: 'read' }]);
  }, 120_000);

  it('is idempotent: a second run adds nothing, even a row', async () => {
    const tables = ['channels', 'channel_groups', 'channel_members', 'messages', 'message_reactions', 'message_mentions', 'threads', 'thread_follows', 'read_state', 'notifications', 'files', 'acl_entries'];
    const snapshot = async (): Promise<number[]> => Promise.all(tables.map(async (t) => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM app.${t}`))[0]?.n ?? -1));
    const before = await snapshot();
    const second = await seedWorld(server.db, { content: true });
    expect(second.content?.skipped).toBeNull();
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it('lets the people see what the story says they see (through the API)', async () => {
    // Lena: exactly #releases, read only, nothing else.
    const dir = await get(LENA, '/api/teams/engineering/channels');
    const names = (dir.body.groups as { channels: { name: string }[] }[]).flatMap((g) => g.channels.map((c) => c.name));
    expect(names).toEqual(['releases']);
    const releases = SEED_IDS.channels['engineering/releases'];
    const list = await get(LENA, `/api/channels/${releases}/messages?limit=5`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(5);
    expect((await get(LENA, `/api/channels/${SEED_IDS.channels['engineering/dev']}/messages`)).status).toBe(403);
    expect((await get(LENA, `/api/channels/${SEED_IDS.channels['engineering/eng-leads']}/messages`)).status).toBe(403);
    expect((await get(LENA, '/api/dms')).body.items ?? []).toEqual([]);

    // Priya (Engineering member) sees #dev but not #eng-leads; Sameera sees no Engineering channel.
    const priya = await get(personas.priya, '/api/teams/engineering/channels');
    const priyaNames = (priya.body.groups as { channels: { name: string }[] }[]).flatMap((g) => g.channels.map((c) => c.name));
    expect(priyaNames).toContain('dev');
    expect(priyaNames).not.toContain('eng-leads');
    expect((await get(personas.sameera, `/api/channels/${SEED_IDS.channels['engineering/dev']}/messages`)).status).toBe(403);

    // Nadia's DM list holds the one conversation with Rafi, one unread; Rafi has an unread mention and thread reply in his bell.
    const dms = await get(NADIA, '/api/dms');
    expect(dms.body.items).toHaveLength(1);
    expect(dms.body.items[0].unreadCount).toBe(1);
    expect(dms.body.items[0].lastMessage.preview).toBe('Check the rota?');
    const bell = await get(RAFI, '/api/notifications/summary');
    expect(bell.body.unreadCount).toBe(2);

    // The attachment downloads as a PDF through the ordinary route (the blob is where storage-local looks).
    const dev = await get(NADIA, `/api/channels/${SEED_IDS.channels['engineering/dev']}/messages?limit=200`);
    const root = (dev.body.items as { id: string; attachments?: { id: string; name: string }[] }[]).find((m) => m.attachments?.length);
    expect(root?.attachments?.[0]).toMatchObject({ id: SEED_IDS.file, name: 'deploy-plan-v2.14.pdf' });
    const file = await fetch(`${server.url}/api/files/${SEED_IDS.file}/content`, { headers: as(NADIA) });
    expect(file.status).toBe(200);
    expect((await file.text()).startsWith('%PDF-')).toBe(true);
    expect((await fetch(`${server.url}/api/files/${SEED_IDS.file}/content`, { headers: as(personas.sameera) })).status).toBe(403);
  }, 120_000);

  it('with MANYTHREADS_CLOCK=fixed two databases get the same ids and the same times', async () => {
    const other = await startTestServer();
    try {
      await seedWorld(other.db, { content: true });
      const digest = async (url: string): Promise<string> =>
        JSON.stringify(await ownerSql(url, `SELECT id, created_at, channel_id FROM app.messages WHERE channel_id <> $1 ORDER BY id`, [SEED_IDS.channels['engineering/load-test']]));
      expect(await digest(other.db.ownerUrl)).toBe(await digest(server.db.ownerUrl));
    } finally {
      await other.close();
    }
  }, 120_000);

  it('finds the channels a template sync made earlier (ids of its own) and writes the content into them', async () => {
    const early = await startTestServer();
    try {
      await seedWorld(early.db);
      for (const [who, team] of [[personas.omar, 'engineering'], [personas.sameera, 'customer-support'], [personas.tariq, 'marketing']] as const) {
        const res = await fetch(`${early.url}/api/teams/${team}/channels`, { headers: as(who) });
        expect(res.status).toBe(200);
      }
      const result = await seedWorld(early.db, { content: true });
      expect(result.content).toMatchObject({ skipped: null, channels: 17 });
      const rows = await ownerSql<{ n: number; c: number }>(early.db.ownerUrl, `SELECT (SELECT count(*) FROM app.channels WHERE kind = 'channel')::int AS n, (SELECT count(DISTINCT channel_id) FROM app.messages)::int AS c`);
      expect(rows[0]).toEqual({ n: 17, c: 18 }); // 17 channels (every one has words) and the DM
      expect((await ownerSql(early.db.ownerUrl, `SELECT 1 FROM app.channels WHERE name = 'dev' AND id = $1`, [SEED_IDS.channels['engineering/dev']])).length).toBe(0);
    } finally {
      await early.close();
    }
  }, 120_000);

  it('leaves the attachment out on request: no file row, no card on the message', async () => {
    const bare = await startTestServer();
    try {
      const res = await seedWorld(bare.db, { content: true, contentOptions: { attachment: false } });
      expect(res.content).toMatchObject({ skipped: null, attachments: 0 });
      expect(await ownerSql(bare.db.ownerUrl, 'SELECT 1 FROM app.files')).toHaveLength(0);
      expect(await ownerSql(bare.db.ownerUrl, `SELECT 1 FROM app.messages WHERE meta ? 'attachments'`)).toHaveLength(0);
    } finally {
      await bare.close();
    }
  }, 120_000);

  it('skips the content, and says so, when the plugin tables are not there', async () => {
    const { createTestDatabase } = await import('../src/index.ts');
    const bare = await createTestDatabase();
    try {
      const res = await seedWorld(bare, { content: true });
      expect(res.content?.skipped).toMatch(/channels tables/);
      expect(res.created).toBe(true);
    } finally {
      await dropTestDatabase(bare);
    }
  }, 60_000);
});

