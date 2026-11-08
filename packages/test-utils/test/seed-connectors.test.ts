import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { designReviewStart, ownerSql, SEED_CONNECTORS, seedWorld, startTestServer, usageFor, type TestServer } from '../src/index.ts';

// Seed v16 (PLAN Bundle D, P16-12) is opt-in: it needs tools/fake-saas and a running server, and it would move every channel list, member count and plate of a stack that did not ask for it
// (MISTAKES P21-24). The seed's own header says "a test asserts `seedWorld` alone never creates it": this is that test. The seed itself runs end to end in the stack of
// e2e/connections (MANYTHREADS_STACK_SEED=connectors); the pieces that have no server in them are tested here.
let server: TestServer;
let storageDir: string;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed16-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedConnectors (seed v16)', () => {
  it('is not part of the default world: seedWorld with content and repo makes no #design, no sign-in, no work-app address, no bridge and no connector source', async () => {
    await seedWorld(server.db, { content: true, repo: true });
    // the plugins are loaded by the test server, so the tables must be there: a missing table would make this test pass for the wrong reason
    for (const table of ['app.connections', 'app.scheduled_meetings', 'app.webhooks', 'app.bridge_accounts', 'app.knowledge_sources']) {
      expect((await sql<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table]))[0]?.t, table).toBe(table);
    }
    expect(await sql(`SELECT 1 FROM app.channels WHERE name = $1`, [SEED_CONNECTORS.design.channel])).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.connections WHERE scope = 'person'`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.connection_oauth`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.connection_usage_daily`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.scheduled_meetings`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.webhooks WHERE kind = 'provider'`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.bridge_accounts`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.knowledge_sources WHERE kind = 'connector'`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.bots WHERE slug = $1`, [SEED_CONNECTORS.responder.slug])).toEqual([]);
  });
});

describe('the pieces of the seed that need no server', () => {
  it('plans the Design review at 15:00 today when that is between three minutes and eleven hours away, else four hours from now', () => {
    const at = (h: number, m = 0): Date => new Date(2026, 10, 9, h, m, 20);
    expect(designReviewStart(at(9)).getHours()).toBe(15);
    expect(designReviewStart(at(9)).getMinutes()).toBe(0);
    expect(designReviewStart(at(14, 56)).getHours()).toBe(15);
    // 14:58 is two minutes ahead: too close, so four hours from now; 16:00 has gone by; 02:00 is thirteen hours ahead
    for (const now of [at(14, 58), at(16), at(2)]) {
      const start = designReviewStart(now);
      expect(start.getTime() - now.getTime(), String(now)).toBeGreaterThanOrEqual(3.9 * 3_600_000);
      expect(start.getTime() - now.getTime()).toBeLessThanOrEqual(4 * 3_600_000);
      expect(start.getSeconds()).toBe(0);
    }
  });

  it('gives each sign-in the same seven days of counts on every run, with failures never above calls', () => {
    for (let i = 0; i < 3; i++) {
      const days = usageFor(i);
      expect(days).toHaveLength(7);
      expect(usageFor(i)).toEqual(days);
      for (const [calls, failures] of days) {
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(failures).toBeLessThanOrEqual(calls);
      }
    }
    expect(usageFor(0)).not.toEqual(usageFor(1));
  });

  it('keeps the signing secret of the Zendesk address long enough for the route (8 to 500 characters)', () => {
    expect(SEED_CONNECTORS.zendesk.secret.length).toBeGreaterThanOrEqual(8);
    expect(SEED_CONNECTORS.zendesk.secret.length).toBeLessThanOrEqual(500);
  });
});
