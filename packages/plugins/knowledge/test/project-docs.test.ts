import type { PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { docTree, flatName, isDocPath, mirrorProjectDocs } from '../src/project-docs.ts';

const REPO_URL = 'https://github.com/example/widget.git';
const PROJECT = {
  id: 'p1',
  workspace_id: 'w1',
  team_id: 't1',
  team_slug: 'eng',
  name: 'widget',
  repo_url: REPO_URL,
  provider: 'github',
  default_branch: 'main',
  created_by: 'a1',
};

/** A fake GitHub: the tree and the files of one branch. */
function github(files: Record<string, { sha: string; text: string }>) {
  const asked: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/git/trees/')) {
      return new Response(JSON.stringify({ tree: [...Object.entries(files).map(([path, v]) => ({ path, type: 'blob', sha: v.sha, size: v.text.length })), { path: 'src/a.ts', type: 'blob', sha: 'x', size: 3 }, { path: 'docs', type: 'tree', sha: 'y' }] }), { status: 200 });
    }
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    const path = m ? decodeURIComponent(m[1]!) : '';
    const file = files[path];
    return file ? new Response(file.text, { status: 200 }) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, asked };
}

/** A context with one project, a team repo in memory and a recorder of writes. */
function fakeCtx(existing: Array<{ name: string; blobSha: string }>, base = false) {
  const writes: Array<{ changes: Array<{ path: string; op: string }>; message: string }> = [];
  const bases: string[] = base ? ['widget-docs'] : [];
  const tx = {
    actor: { id: 'sys', kind: 'system', workspaceId: 'w1' },
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM app.projects')) return { rows: [PROJECT] };
      if (sql.startsWith('SELECT id FROM app.knowledge_bases')) return { rows: bases.includes(values[1] as string) ? [{ id: 'b1' }] : [] };
      if (sql.startsWith('INSERT INTO app.knowledge_bases')) {
        bases.push(values[2] as string);
        return { rows: [{ id: 'b1' }] };
      }
      return { rows: [] };
    },
  };
  const ctx = {
    db: { system: (fn: (t: typeof tx) => unknown) => fn(tx) },
    audit: { emit: async () => undefined },
    providers: {
      get: (id: string) =>
        id === 'project.credentials'
          ? { read: async () => ({ token: 'ghp_test', origin: REPO_URL, branch: 'main' }) }
          : id === 'repo'
            ? {
                list: async () => existing.map((e) => ({ ...e, path: `knowledge/widget-docs/${e.name}`, kind: 'file', size: 1, updatedAt: null, updatedBy: null })),
                write: async (_tx: unknown, _team: string, _actor: unknown, changes: Array<{ path: string; op: string }>, message: string) => {
                  writes.push({ changes, message });
                  return { sha: 'c', parentSha: null };
                },
              }
            : undefined,
    },
  } as unknown as PluginContext;
  return { ctx, writes, bases };
}

describe('project docs as knowledge (P35-06)', () => {
  it('takes Markdown at the root, under docs and in ADR folders, and nothing else', () => {
    expect(isDocPath('README.md')).toBe(true);
    expect(isDocPath('docs/deploy/preview.md')).toBe(true);
    expect(isDocPath('services/api/adr/0001-queue.md')).toBe(true);
    expect(isDocPath('src/notes.md')).toBe(false);
    expect(isDocPath('docs/logo.png')).toBe(false);
    expect(isDocPath('node_modules/x/README.md')).toBe(false);
    expect(flatName('docs/deploy/preview.md')).toBe('docs--deploy--preview.md');
  });

  it('reads the tree with the token and keeps only the doc files', async () => {
    const gh = github({ 'README.md': { sha: 'AA', text: '# Widget' } });
    const tree = await docTree({ host: 'github.com', owner: 'example', repo: 'widget', apiBase: 'https://api.github.com' } as never, 'ghp_test', 'main', gh.fetch);
    expect(tree).toEqual([{ path: 'README.md', sha: 'aa', size: 8 }]);
  });

  it('makes the base the first time, writes the changed files, skips the unchanged and removes the gone', async () => {
    process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/example/';
    const gh = github({ 'README.md': { sha: 'aa', text: '# Widget' }, 'docs/adr/0001-queue.md': { sha: 'bb', text: '# Use a queue' } });
    const { ctx, writes, bases } = fakeCtx([
      { name: 'README.md', blobSha: 'aa' },
      { name: 'docs--old.md', blobSha: 'cc' },
    ]);
    const lines: string[] = [];
    const r = await mirrorProjectDocs(ctx, (l) => lines.push(l), gh.fetch);
    expect(bases).toEqual(['widget-docs']);
    expect(r).toEqual({ projects: 1, written: 1, removed: 1 });
    expect(writes[0]!.changes).toEqual([
      expect.objectContaining({ path: 'knowledge/widget-docs/docs--adr--0001-queue.md', op: 'put' }),
      { path: 'knowledge/widget-docs/docs--old.md', op: 'delete' },
    ]);
    // the unchanged README was not fetched again
    expect(gh.asked.some((u) => u.includes('/contents/README.md'))).toBe(false);
    expect(gh.asked.every((u) => !u.includes('ghp_test'))).toBe(true);
  });

  it('writes nothing when every file is as it was', async () => {
    const gh = github({ 'README.md': { sha: 'aa', text: '# Widget' } });
    const { ctx, writes } = fakeCtx([{ name: 'README.md', blobSha: 'aa' }], true);
    expect(await mirrorProjectDocs(ctx, () => undefined, gh.fetch)).toEqual({ projects: 1, written: 0, removed: 0 });
    expect(writes).toEqual([]);
  });

  it('leaves a project outside the allowed origins alone', async () => {
    process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/someone-else/';
    const gh = github({ 'README.md': { sha: 'aa', text: '# Widget' } });
    const { ctx, writes } = fakeCtx([]);
    expect(await mirrorProjectDocs(ctx, () => undefined, gh.fetch)).toEqual({ projects: 0, written: 0, removed: 0 });
    expect(gh.asked).toEqual([]);
    expect(writes).toEqual([]);
    delete process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'];
  });
});
