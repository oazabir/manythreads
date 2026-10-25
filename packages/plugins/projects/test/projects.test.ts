import { CreateProjectRequest, ListProjectsResponse, Project, ProjectRepoUrl, UpdateProjectRequest } from '@manythreads/shared';
import { createWorld, personas, type World } from '../../teams/test/world.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, sameera } = personas;
const TEAM = 'engineering';
const URL1 = 'https://github.com/oazabir/manythreads';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: { status: number; body: unknown }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const channel = async (name: string, team = TEAM): Promise<string> =>
  ok<{ channel: { id: string } }>(await w.call(omar, 'POST', `/api/teams/${team}/channels`, { name }), 201).channel.id;
const create = (who: typeof omar, body: unknown) => w.call(who, 'POST', `/api/teams/${TEAM}/projects`, body);

describe('project request validation', () => {
  it('accepts a plain https repository address and refuses everything else', () => {
    const base = { name: 'manythreads', repoUrl: URL1 };
    expect(CreateProjectRequest.safeParse(base).success).toBe(true);
    for (const bad of [
      'http://github.com/a/b',
      'ssh://git@github.com/a/b',
      'git@github.com:a/b.git',
      'https://user:pw@github.com/a/b',
      'https://github.com/a/b?token=1',
      'https://github.com/a/b#x',
      'https://github.com/a/b c',
      'https://@github.com/a/b',
      'https://github.com/a/b?',
      'https://github.com/a/b#',
      'https://github.com/a/../b',
      'https://github.com/a/./b',
      'https://github.com/a/%2e%2E/b',
      'https://github.com//a/b',
      'https://github.com/a//b',
      'https://github.com/a@b/c',
      'file:///etc/passwd',
      'github.com/a/b',
    ])
      expect(CreateProjectRequest.safeParse({ ...base, repoUrl: bad }).success, bad).toBe(false);
  });

  it('keeps the name to what the pod accepts as a folder name', () => {
    for (const bad of ['', 'Upper', 'a b', '../x', 'a..b', '-lead', 'x'.repeat(62)])
      expect(CreateProjectRequest.safeParse({ name: bad, repoUrl: URL1 }).success, bad).toBe(false);
    expect(CreateProjectRequest.safeParse({ name: 'my.repo_1-x', repoUrl: URL1 }).success).toBe(true);
  });

  it('checks branch names and refuses unknown fields; an update cannot rename', () => {
    expect(CreateProjectRequest.safeParse({ name: 'a', repoUrl: URL1, defaultBranch: 'release/1.0' }).success).toBe(true);
    expect(CreateProjectRequest.safeParse({ name: 'a', repoUrl: URL1, defaultBranch: 'a..b' }).success).toBe(false);
    expect(CreateProjectRequest.safeParse({ name: 'a', repoUrl: URL1, defaultBranch: '-x' }).success).toBe(false);
    expect(CreateProjectRequest.safeParse({ name: 'a', repoUrl: URL1, extra: 1 }).success).toBe(false);
    expect(UpdateProjectRequest.safeParse({ name: 'b' }).success).toBe(false);
  });
});

describe('projects API', () => {
  it('a lead adds a project tied to a channel; members read it; members cannot write', async () => {
    const dev = await channel('proj-dev');
    const made = Project.parse(ok<{ project: unknown }>(await create(omar, { name: 'manythreads', repoUrl: URL1, channelId: dev }), 201).project);
    expect(made).toMatchObject({ name: 'manythreads', repoUrl: URL1, defaultBranch: 'main', channelId: dev });

    const list = ListProjectsResponse.parse(ok(await w.call(nadia, 'GET', `/api/teams/${TEAM}/projects`)));
    expect(list.items.map((p) => p.name)).toEqual(['manythreads']);

    expect((await create(nadia, { name: 'other', repoUrl: URL1 })).status).toBe(403);
    expect((await w.call(nadia, 'PATCH', `/api/teams/${TEAM}/projects/${made.id}`, { defaultBranch: 'dev' })).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/teams/${TEAM}/projects/${made.id}`)).status).toBe(403);
    // someone outside the team neither reads nor writes
    expect((await w.call(sameera, 'GET', `/api/teams/${TEAM}/projects`)).status).toBe(403);
    expect((await create(sameera, { name: 'sneaky', repoUrl: URL1 })).status).toBe(403);
  });

  it('refuses a duplicate name, a second project on one channel, and a channel of another team', async () => {
    expect((await create(omar, { name: 'manythreads', repoUrl: URL1 })).status).toBe(409);
    const dev = await channel('proj-dev2');
    ok(await create(omar, { name: 'one', repoUrl: URL1, channelId: dev }), 201);
    expect((await create(omar, { name: 'two', repoUrl: URL1, channelId: dev })).status).toBe(409);
    const foreign = await channel('proj-foreign', 'marketing');
    expect((await create(omar, { name: 'three', repoUrl: URL1, channelId: foreign })).status).toBe(400);
  });

  it('updates the branch and moves or clears the channel, then removes the project', async () => {
    const a = await channel('proj-a');
    const made = Project.parse(ok<{ project: unknown }>(await create(omar, { name: 'movable', repoUrl: URL1 }), 201).project);
    const moved = Project.parse(ok<{ project: unknown }>(await w.call(omar, 'PATCH', `/api/teams/${TEAM}/projects/${made.id}`, { defaultBranch: 'dev', channelId: a })).project);
    expect(moved).toMatchObject({ defaultBranch: 'dev', channelId: a });
    const cleared = Project.parse(ok<{ project: unknown }>(await w.call(omar, 'PATCH', `/api/teams/${TEAM}/projects/${made.id}`, { channelId: null })).project);
    expect(cleared.channelId).toBeNull();
    expect((await w.call(omar, 'PATCH', `/api/teams/${TEAM}/projects/${made.id}`, {})).status).toBe(400);
    ok(await w.call(omar, 'DELETE', `/api/teams/${TEAM}/projects/${made.id}`));
    expect((await w.call(omar, 'DELETE', `/api/teams/${TEAM}/projects/${made.id}`)).status).toBe(404);
  });

  it('writes one event per change', async () => {
    const types = await w.system(async (tx) => (await tx.query<{ type: string }>("SELECT DISTINCT type FROM app.events WHERE type LIKE 'project.project.%' ORDER BY 1")).rows.map((r) => r.type));
    expect(types).toEqual(['project.project.created', 'project.project.deleted', 'project.project.updated']);
  });
});

describe('the database CHECK refuses the same addresses as the schema', () => {
  const good = ['https://github.com/a/b', 'https://github.com/a/b/', 'https://host:8443/x/y.git', 'https://github.com/a/...'];
  const bad = [
    'http://github.com/a/b',
    'https://user:pw@github.com/a/b',
    'https://@host/x',
    'https://host/x?',
    'https://host/x#',
    'https://host/a/../b',
    'https://host/a/./b',
    'https://host/a/%2e%2E/b',
    'https://host/a/.%2e',
    'https://host//x',
    'https://host/a//b',
    'https://host/a@b',
    'https://host/a b',
  ];
  const insert = (url: string): Promise<boolean> =>
    w
      .system(async (tx) => {
        const t = (await tx.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM app.teams WHERE slug = 'engineering'")).rows[0]!;
        await tx.query('SAVEPOINT s');
        try {
          await tx.query('INSERT INTO app.projects (workspace_id, team_id, name, repo_url) VALUES ($1::uuid, $2::uuid, $3, $4)', [
            t.workspace_id,
            t.id,
            `check-${Math.random().toString(36).slice(2, 10)}`,
            url,
          ]);
          await tx.query('ROLLBACK TO s');
          return true;
        } catch (err) {
          await tx.query('ROLLBACK TO s');
          if ((err as { code?: string }).code === '23514') return false;
          throw err;
        }
      });

  it('accepts and refuses exactly what the schema does', async () => {
    for (const g of good) {
      expect(ProjectRepoUrl.safeParse(g).success, g).toBe(true);
      expect(await insert(g), g).toBe(true);
    }
    for (const b of bad) {
      expect(ProjectRepoUrl.safeParse(b).success, b).toBe(false);
      expect(await insert(b), b).toBe(false);
    }
  });
});
