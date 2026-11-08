import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSaas, type FakeSaas } from '../../../tools/fake-saas/src/index.ts';
import { ownerSql, SEED_CONNECTORS, seedConnectors, seedWorld, startTestServer, type SeedConnectorsResult, type TestServer } from '../src/index.ts';

// Seed v16 end to end (PLAN P16-12): the real server, tools/fake-saas, and the seed's own routes. The server's public address is its own port, so the Telegram stand-in can post
// its updates back (MISTAKES Bundle D: the test server's default public address is a fixed localhost:3000 nobody listens on).
let server: TestServer;
let saas: FakeSaas;
let storageDir: string;
let result: SeedConnectorsResult;
const touched: string[] = [];
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed16run-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  saas = await startFakeSaas({ seedKey: 'seed16-test', seedGrants: SEED_CONNECTORS.grants.map((g) => ({ provider: g.provider, email: g.who.email })) });
  for (const [key, value] of Object.entries(saas.env())) {
    process.env[key] = value;
    touched.push(key);
  }
  const port = await freePort();
  server = await startTestServer({ port, publicUrl: `http://127.0.0.1:${port}` });
  await seedWorld(server.db, { content: true, repo: true });
  result = await seedConnectors({ url: server.url, db: server.db, saas });
}, 300_000);

afterAll(async () => {
  await server?.close();
  await saas?.stop();
  for (const key of touched) delete process.env[key];
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedConnectors against a real server and the stand-ins', () => {
  it('plans the Design review in #design through the route, with an event at Nadia\'s calendar', async () => {
    const rows = await sql<{ title: string; status: string; provider: string; external_event_id: string | null; outside_count: number }>(`SELECT title, status, provider, external_event_id, outside_count FROM app.scheduled_meetings WHERE channel_id = $1`, [result.designChannelId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Design review', status: 'scheduled', provider: 'google', outside_count: 0 });
    expect(rows[0]!.external_event_id).toBeTruthy();
    expect(await sql(`SELECT 1 FROM app.scheduled_meeting_attendees WHERE scheduled_meeting_id = $1`, [result.scheduledMeetingId])).toHaveLength(1);
  });

  it('seals four sign-ins that are switched on, with no token in the open and seven days of counts for each', async () => {
    expect(await sql(`SELECT 1 FROM app.connections WHERE scope = 'person' AND status = 'enabled'`)).toHaveLength(4);
    expect(await sql(`SELECT 1 FROM app.connection_secrets WHERE name IN ('access_token', 'refresh_token')`)).toHaveLength(8);
    const token = saas.seedTokens('google', 'nadia@kahf.example').accessToken;
    expect(await sql(`SELECT 1 FROM app.secrets WHERE ciphertext::text LIKE '%' || $1 || '%'`, [token]).catch(() => [])).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.connection_usage_daily`)).toHaveLength(28);
  });

  it('makes the Zendesk address with the known secret, and the bot it wakes', async () => {
    expect(await sql(`SELECT 1 FROM app.webhooks WHERE id = $1 AND kind = 'provider'`, [result.zendeskEndpointId])).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM app.bots WHERE slug = $1 AND status = 'active'`, [SEED_CONNECTORS.responder.slug])).toHaveLength(1);
  });

  it('turns Telegram on, links Nadia and joins #support to the group', async () => {
    expect(await sql<{ status: string }>(`SELECT status FROM app.bridge_accounts WHERE provider = 'telegram'`)).toEqual([{ status: 'on' }]);
    expect(await sql(`SELECT 1 FROM app.bridge_identities WHERE account_id = $1`, [result.telegramAccountId])).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM app.bridge_links WHERE channel_id = $1`, [result.supportChannelId])).toHaveLength(1);
  });

  it('reads the handbook folder: the document anyone can open is in, the two-person one is counted and not stored', async () => {
    const docs = await sql<{ name: string }>(`SELECT name FROM app.knowledge_documents WHERE base_id = $1`, [result.handbookBaseId]);
    expect(docs.map((d) => d.name)).toEqual([SEED_CONNECTORS.handbook.shared.name]);
    expect(JSON.stringify(await sql(`SELECT * FROM app.knowledge_documents`))).not.toContain(SEED_CONNECTORS.handbook.limited.name);
    const source = await sql<{ skipped_limited: number }>(`SELECT skipped_limited FROM app.knowledge_sources WHERE kind = 'connector'`);
    expect(source[0]!.skipped_limited).toBeGreaterThanOrEqual(1);
  });

  it('refuses a second run in the same database', async () => {
    await expect(seedConnectors({ url: server.url, db: server.db, saas })).rejects.toThrow(/already there/);
  });
});
