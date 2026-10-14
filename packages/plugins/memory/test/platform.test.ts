import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { appendLesson, appendPersonNote, lessonPath, personNotePath, PLATFORM_ENTRY_MAX_CHARS } from '../src/platform.ts';

// Platform writes to a bot's private memory files (SPEC §7.2, PLAN P5-23 criterion 13): `bots/<slug>/lessons.md`
// and `bots/<slug>/people/<id>.md` go through the one writer as the system actor — never through a bot's file
// capability. Through the real server: the files land in git with a null author, and a bot-actor transaction
// is refused before anything is written.

const { nadia } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
let repo: RepoProvider;
let ctx: PluginContext;

const NOW = new Date('2026-10-14T09:00:00.000Z');

beforeAll(async () => {
  w = await createRepoWorld();
  const found = w.server.host.registries.providers.repo.values() as RepoProvider[];
  expect(found.length).toBeGreaterThan(0);
  repo = found[0]!;
  ctx = { providers: { get: (kind: string) => (kind === 'repo' ? repo : undefined) }, runtime: { now: () => NOW } } as unknown as PluginContext;
});

afterAll(async () => {
  await w?.close();
});

const blob = async (path: string): Promise<{ status: number; content?: string }> => {
  const res = await w.call(nadia, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=main`);
  return { status: res.status, content: res.status === 200 ? (res.body as { content: string }).content : undefined };
};

describe('platform file paths', () => {
  it('names the lessons file and the per-person note inside the bot folder', () => {
    expect(lessonPath('coder')).toBe('bots/coder/lessons.md');
    expect(personNotePath('brain', nadia.actorId)).toBe(`bots/brain/people/${nadia.actorId}.md`);
  });

  it('refuses a slug or person id that would name anything else', () => {
    for (const slug of ['../x', 'a/b', '', 'TEAM.md', 'a..b/../c']) {
      expect(() => lessonPath(slug), slug).toThrow();
    }
    expect(() => personNotePath('coder', 'not-a-uuid')).toThrow();
    expect(() => personNotePath('coder', '')).toThrow();
  });
});

describe('appendLesson through the real writer', () => {
  it('lands in git as a system commit the team can read', async () => {
    const res = await w.system((tx) => appendLesson(ctx, tx as unknown as PluginTx, ENG, 'coder', 'Batch per-tenant writes.'));
    expect(res.noop).toBe(false);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    const got = await blob('bots/coder/lessons.md');
    expect(got.status).toBe(200);
    expect(got.content).toContain('Batch per-tenant writes.');
    const row = await w.system(
      async (tx) => (await tx.query<{ author_id: string | null }>('SELECT author_id FROM app.repo_commits WHERE sha = $1', [res.sha])).rows[0],
    );
    expect(row?.author_id).toBeNull();
  });

  it('appends a second lesson without touching the first', async () => {
    await w.system((tx) => appendLesson(ctx, tx as unknown as PluginTx, ENG, 'coder', 'Second lesson.'));
    const got = await blob('bots/coder/lessons.md');
    expect(got.content).toContain('Batch per-tenant writes.');
    expect(got.content).toContain('Second lesson.');
  });

  it('refuses an empty or oversized lesson before writing', async () => {
    await expect(w.system((tx) => appendLesson(ctx, tx as unknown as PluginTx, ENG, 'coder', '  '))).rejects.toThrow(/must not be empty/);
    await expect(w.system((tx) => appendLesson(ctx, tx as unknown as PluginTx, ENG, 'coder', 'x'.repeat(PLATFORM_ENTRY_MAX_CHARS + 1)))).rejects.toThrow(/at most/);
  });

  it('refuses a bot-actor transaction: platform writes are the system actor only', async () => {
    const bot = await w.makeBot(ENG);
    await expect(w.as(bot, (tx) => appendLesson(ctx, tx, ENG, 'coder', 'A bot writing its own lessons.'))).rejects.toThrow(/system actor/);
    const got = await blob('bots/coder/lessons.md');
    expect(got.content).not.toContain('A bot writing its own lessons.');
  });
});

describe('appendPersonNote through the real writer', () => {
  it('lands in the bot folder under people/, as a system commit', async () => {
    const res = await w.system((tx) => appendPersonNote(ctx, tx as unknown as PluginTx, ENG, 'brain', nadia.actorId, 'Nadia likes short answers.'));
    expect(res.noop).toBe(false);
    const got = await blob(`bots/brain/people/${nadia.actorId}.md`);
    expect(got.status).toBe(200);
    expect(got.content).toContain('Nadia likes short answers.');
    const row = await w.system(
      async (tx) => (await tx.query<{ author_id: string | null }>('SELECT author_id FROM app.repo_commits WHERE sha = $1', [res.sha])).rows[0],
    );
    expect(row?.author_id).toBeNull();
  });

  it("one person's notes never touch another person's file", async () => {
    const other = '00000000-0000-7000-8000-0000000d0099';
    await w.system((tx) => appendPersonNote(ctx, tx as unknown as PluginTx, ENG, 'brain', other, 'Someone else.'));
    const mine = await blob(`bots/brain/people/${nadia.actorId}.md`);
    expect(mine.content).not.toContain('Someone else.');
  });
});
