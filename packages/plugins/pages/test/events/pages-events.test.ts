import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../../repo-git/test/world.ts';

// Event contract tests (pnpm test:events): pages.write stores `pages.page.written` in the shape its registered schema accepts, as the acting person or bot,
// with the team, next to the repo's own `repo.repo.committed`; a refused, conflicting or no-op write emits neither.

const { nadia, priya } = personas;
const eng = TEAM_IDS.Engineering;

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const stored = (type: string): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      'SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = $1 AND team_id = $2 ORDER BY id',
      [type, eng],
    )).rows,
  );
const write = (who: Parameters<RepoWorld['call']>[0], mode: string, path: string, content: string, extra: Record<string, unknown> = {}) =>
  w.call<{ sha: string; blobSha: string }>(who, 'POST', '/api/teams/engineering/pages/write', { mode, path, content, ...extra });

describe('pages.page.written', () => {
  it('one event per write, as the author, in the registered shape, with the commit it belongs to', async () => {
    const res = await write(nadia, 'create', 'pages/e.md', 'hello\n');
    expect(res.status).toBe(201);
    const rows = await stored('pages.page.written');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(nadia.actorId);
    expect(parseEvent(eventToRaw(rows[0]!))).toMatchObject({
      type: 'pages.page.written',
      schemaVersion: 1,
      teamId: eng,
      path: 'pages/e.md',
      mode: 'create',
      sha: res.body.sha,
      blobSha: res.body.blobSha,
      size: 6,
      authorId: nadia.actorId,
      actorKind: 'person',
    });
    // the commit's own event names the same sha
    const committed = (await stored('repo.repo.committed')).map((r) => (r.payload as { sha: string }).sha);
    expect(committed).toContain(res.body.sha);
    for (const [mode, content] of [['append', 'more\n'], ['replace', 'new\n']] as const) expect((await write(priya, mode, 'pages/e.md', content)).status).toBe(201);
    const modes = (await stored('pages.page.written')).map((r) => (r.payload as { mode: string }).mode);
    expect(modes).toEqual(['create', 'append', 'replace']);
  });

  it('a bot’s write is stored with actorKind bot', async () => {
    const bot = await w.makeBot(eng, ['pages.write']);
    expect((await write(bot, 'create', 'pages/by-bot.md', 'x')).status).toBe(201);
    const last = (await stored('pages.page.written')).at(-1)!;
    expect(last.actor_id).toBe(bot.actorId);
    expect(parseEvent(eventToRaw(last))).toMatchObject({ authorId: bot.actorId, actorKind: 'bot', path: 'pages/by-bot.md' });
  });

  it('refused, conflicting and no-op writes emit nothing', async () => {
    const count = (await stored('pages.page.written')).length;
    expect((await write(priya, 'replace', 'TEAM.md', 'x')).status).toBe(403);
    expect((await write(nadia, 'create', 'pages/e.md', 'again')).status).toBe(409);
    expect((await write(nadia, 'replace', 'pages/e.md', 'x', { baseBlobSha: '0'.repeat(40) })).status).toBe(409);
    expect((await write(nadia, 'create', 'pages/bin.md', 'a\u0000b')).status).toBe(422);
    expect((await write(nadia, 'create', 'knowledge/x.md', 'x')).status).toBe(400);
    expect((await write(nadia, 'replace', 'pages/e.md', 'new\n')).status).toBe(200); // the same text: a no-op
    expect((await write(null, 'create', 'pages/anon.md', 'x')).status).toBe(401);
    expect((await stored('pages.page.written')).length).toBe(count);
  });
});
