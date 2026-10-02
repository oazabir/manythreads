import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../world.ts';

// Event contract tests (pnpm test:events): the writer stores `repo.repo.committed` in the shape its registered schema accepts, as the acting
// person, with the team; the first commit of a team is authored by the system; a refused, conflicting or no-op write emits nothing.

const { nadia, priya, omar } = personas;
const eng = TEAM_IDS.Engineering;

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const stored = (): Promise<EventRow[]> =>
  w.system(async (tx) =>
    (await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = 'repo.repo.committed' AND team_id = $1 ORDER BY id`,
      [eng],
    )).rows,
  );
const put = (path: string, content: string, extra: Record<string, unknown> = {}) => ({ op: 'put', path, content, ...extra });

describe('repo.repo.committed', () => {
  it('the first commit of a team is the system’s: no author, no parent, the layout paths', async () => {
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/repo/tree')).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    const parsed = parseEvent(eventToRaw(rows[0]!));
    expect(parsed).toMatchObject({ type: 'repo.repo.committed', schemaVersion: 1, teamId: eng, authorId: null, parentSha: null, coAuthorIds: [], subject: 'Create the team repository' });
    const paths = (parsed as unknown as { paths: { path: string; op: string }[] }).paths.map((p) => p.path);
    expect(paths).toContain('TEAM.md');
    expect(paths).toContain('memory/journal/.gitkeep');
  });

  it('a commit emits one event, as the author, with the team, the sha and the changed paths', async () => {
    const res = await w.commit(nadia, 'engineering', [put('pages/a.md', 'a\n'), { op: 'delete', path: 'pages/nothing.md' }], 'Add a');
    expect(res.status).toBe(201);
    const rows = await stored();
    expect(rows).toHaveLength(2);
    const row = rows[1]!;
    expect(row.actor_id).toBe(nadia.actorId);
    expect(row.team_id).toBe(eng);
    expect(parseEvent(eventToRaw(row))).toMatchObject({
      type: 'repo.repo.committed',
      sha: res.body.sha,
      parentSha: res.body.parentSha,
      authorId: nadia.actorId,
      subject: 'Add a',
      paths: [{ path: 'pages/a.md', op: 'put' }],
    });
  });

  it('refused, conflicting and no-op writes emit nothing', async () => {
    const count = (await stored()).length;
    expect((await w.commit(priya, 'engineering', [put('TEAM.md', 'x')], 'no')).status).toBe(403);
    expect((await w.commit(nadia, 'engineering', [put('pages/b.bin', 'a\u0000b')], 'binary')).status).toBe(422);
    expect((await w.commit(nadia, 'engineering', [put('pages/a.md', 'x', { baseBlobSha: '0'.repeat(40) })], 'stale')).status).toBe(409);
    expect((await w.commit(nadia, 'engineering', [put('../x', 'x')], 'path')).status).toBe(400);
    expect((await w.commit(nadia, 'engineering', [put('pages/a.md', 'a\n')], 'same')).status).toBe(200);
    expect((await w.commit(null, 'engineering', [put('pages/c.md', 'c')], 'anon')).status).toBe(401);
    expect((await stored()).length).toBe(count);
  });

  it('a bot’s refused write is audited as kernel.capability.denied and emits no commit event', async () => {
    const bot = await w.makeBot(eng, ['files.write']);
    const count = (await stored()).length;
    expect((await w.commit(bot, 'engineering', [put('bots/x/BOT.md', 'x')], 'bot')).status).toBe(403);
    expect((await stored()).length).toBe(count);
    const denied = await w.system(async (tx) =>
      (await tx.query<EventRow>(
        `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1`,
        [bot.actorId],
      )).rows,
    );
    expect(denied).toHaveLength(1);
    expect(parseEvent(eventToRaw(denied[0]!))).toMatchObject({ actorKind: 'bot', capability: 'files.write', path: 'bots/x/BOT.md' });
    expect(omar.workspaceId).toBeTruthy();
  });
});
