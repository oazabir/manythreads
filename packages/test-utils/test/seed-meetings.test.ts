import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerSql, seedWorld, startTestServer, type TestServer } from '../src/index.ts';

// Seed v15 (PLAN P15-17) is opt-in: it makes three finished calls through the routes of a running server, and it would move every message count, channel list and plate of a stack
// that did not ask for it (MISTAKES P21-24). The seed's own header says "a test asserts seedWorld alone never creates a meeting": this is that test.
let server: TestServer;
let storageDir: string;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed15-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedMeetings (seed v15)', () => {
  it('is not part of the default world: seedWorld with content and repo makes no meeting, no notes, no line and no notes card', async () => {
    await seedWorld(server.db, { content: true, repo: true });
    // the meetings plugin is loaded by the test server, so the table must be there: a missing table would make this test pass for the wrong reason
    expect((await sql<{ t: string | null }>(`SELECT to_regclass('app.meetings')::text AS t`))[0]?.t).toBe('app.meetings');
    expect(await sql(`SELECT id FROM app.meetings`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.meeting_notes`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.meeting_segments`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE a.kind = 'bot' AND m.meta ? 'meetingNotes'`)).toEqual([]);
  });
});
