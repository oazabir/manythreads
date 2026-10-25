import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelId, Project, ProjectId } from '@manythreads/shared';
import { createMockTransport } from '../src/api/mock';
import { setTransport } from '../src/api/client';
import { createProject, deleteProject, fetchProjects, updateProject } from '../src/screens/projects/api';
import { headerTopic, podPath, projectOfChannel, validateEdit, validateNew } from '../src/screens/projects/commands';

const C1 = '00000000-0000-4000-8000-000000000001' as ChannelId;
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', workspaceId: 'w', teamId: 't', name: 'manythreads', repoUrl: 'https://github.com/oazabir/manythreads', defaultBranch: 'main',
  channelId: null, createdBy: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
}) as unknown as Project;

describe('Projects page checks', () => {
  const ok = { name: 'manythreads', repoUrl: 'https://github.com/oazabir/manythreads', defaultBranch: '', channelId: '' };

  it('accepts a plain https address, leaves the branch to the server default and sends no channel as null', () => {
    const v = validateNew(ok);
    expect(v.ok && v.body).toEqual({ name: 'manythreads', repoUrl: ok.repoUrl, defaultBranch: undefined, channelId: null });
  });

  it('refuses addresses with a password, a query, or a scheme other than https, and says why in plain words', () => {
    for (const repoUrl of ['http://github.com/a/b', 'https://u:p@github.com/a/b', 'https://github.com/a/b?x=1', 'git@github.com:a/b.git', '']) {
      const v = validateNew({ ...ok, repoUrl });
      expect(v.ok, repoUrl).toBe(false);
      if (!v.ok) expect(v.errors.repoUrl).toMatch(/https address/);
    }
    const bad = validateNew({ ...ok, name: 'Has Space', defaultBranch: 'a..b' });
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['defaultBranch', 'name']);
  });

  it('sends only what changed on edit', () => {
    const p = project();
    expect(validateEdit(p, { repoUrl: p.repoUrl, defaultBranch: 'main', channelId: '' })).toMatchObject({ ok: true, changed: false, body: {} });
    const v = validateEdit(p, { repoUrl: p.repoUrl, defaultBranch: 'dev', channelId: C1 });
    expect(v.ok && v.body).toEqual({ defaultBranch: 'dev', channelId: C1 });
    const cleared = validateEdit(project({ channelId: C1 }), { repoUrl: p.repoUrl, defaultBranch: 'main', channelId: '' });
    expect(cleared.ok && cleared.body).toEqual({ channelId: null });
  });

  it('finds the project of a channel and words the header', () => {
    const list = [project({ channelId: C1 }), project({ id: 'p2' as ProjectId, name: 'other' })];
    expect(projectOfChannel(list, C1)?.name).toBe('manythreads');
    expect(projectOfChannel(list, 'c9')).toBeUndefined();
    expect(headerTopic(list[0], 'Ship it')).toBe('Project: manythreads · Ship it');
    expect(headerTopic(list[0], '')).toBe('Project: manythreads');
    expect(headerTopic(undefined, 'Ship it')).toBe('Ship it');
    expect(headerTopic(undefined, null)).toBeNull();
    expect(podPath('manythreads')).toBe('/workspace/repos/manythreads.git');
  });
});

describe('Projects over the mock transport', () => {
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0 })));

  it('adds, changes and removes a project, and refuses a second project on one channel', async () => {
    const { project: a } = await createProject('engineering', { name: 'manythreads', repoUrl: 'https://github.com/oazabir/manythreads', channelId: C1 });
    expect(a.defaultBranch).toBe('main');
    await expect(createProject('engineering', { name: 'two', repoUrl: 'https://github.com/oazabir/two', channelId: a.channelId })).rejects.toMatchObject({ status: 409 });
    const { project: b } = await updateProject('engineering', a.id, { defaultBranch: 'dev', channelId: null });
    expect(b).toMatchObject({ defaultBranch: 'dev', channelId: null });
    expect((await fetchProjects('engineering')).items).toHaveLength(1);
    await deleteProject('engineering', a.id);
    expect((await fetchProjects('engineering')).items).toEqual([]);
  });
});
