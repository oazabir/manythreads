import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_ANIMAL_AVATAR_PRESETS } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerSql, seedPolish, seedWorld, SEED_POLISH, startTestServer, type TestServer } from '../src/index.ts';

// Seed v21 (PLAN P21-24, B17): `#polish`, the channel for the look checks, written on top of seeds v3 and v4 and only when asked for. The database comes
// from a started test server (its plugin migrations create the channel tables and load the coder bot from the v4 placeholder).
let server: TestServer;
let storageDir: string;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed21-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  process.env['MANYTHREADS_CLOCK'] = 'fixed';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_CLOCK'];
  await server?.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedPolish (seed v21)', () => {
  it('is not part of the default world: seedWorld alone makes no #polish', async () => {
    await seedWorld(server.db, { content: true, repo: true });
    expect(await sql(`SELECT id FROM app.channels WHERE name = $1`, [SEED_POLISH.channel.name])).toEqual([]);
  });

  it('writes the run, the long message, the Answer with three citations and the thread; a second run writes nothing', async () => {
    const first = await seedPolish(server.db, { botWaitMs: 60_000 });
    expect(first).toMatchObject({ skipped: null, answer: true, notes: [] });
    const count = async (): Promise<number> => Number((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM app.messages WHERE channel_id = $1`, [SEED_POLISH.channel.id]))[0]?.n);
    const total = await count();
    expect(total).toBe(SEED_POLISH.runLength + 1 + 1 + (SEED_POLISH.threadReplies + 1));

    const rows = await sql<{ body_plain: string; thread_root_id: string | null; created_at: Date; meta: { answer?: { citations?: unknown[] } } }>(
      `SELECT body_plain, thread_root_id, created_at, meta FROM app.messages WHERE channel_id = $1 ORDER BY created_at, id`,
      [SEED_POLISH.channel.id],
    );
    // the run: twelve messages by one person, the first and the last within five minutes
    // (the thread's root is the oldest row, so the run starts at its first line)
    const first0 = rows.findIndex((r) => r.body_plain === 'Morning. I looked at the deploy checklist.');
    expect(first0).toBeGreaterThanOrEqual(0);
    const run = rows.slice(first0, first0 + SEED_POLISH.runLength);
    expect(run).toHaveLength(SEED_POLISH.runLength);
    const spanMs = new Date(run[run.length - 1]!.created_at).getTime() - new Date(run[0]!.created_at).getTime();
    expect(spanMs).toBeLessThanOrEqual(5 * 60_000);
    // the long one has forty lines
    expect(rows.some((r) => r.body_plain.split('\n').length === SEED_POLISH.longLines)).toBe(true);
    // the Answer carries three citations, the thread six replies under one root
    const answers = rows.filter((r) => r.meta?.answer);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.meta.answer?.citations).toHaveLength(SEED_POLISH.citations);
    expect(rows.filter((r) => r.thread_root_id !== null)).toHaveLength(SEED_POLISH.threadReplies);

    // the bot has the same picture on every stack, so a plate can hold it
    expect(await sql(`SELECT avatar FROM app.bots WHERE slug = $1`, [SEED_POLISH.bot])).toEqual([{ avatar: `preset:${BOT_ANIMAL_AVATAR_PRESETS[0]!.id}` }]);

    const second = await seedPolish(server.db, { botWaitMs: 60_000 });
    expect(second.skipped).toBeNull();
    expect(await count()).toBe(total);
  }, 120_000);
});
