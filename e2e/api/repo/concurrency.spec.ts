import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { CommitRepoResponse, ErrorEnvelope, GetRepoTreeResponse, RepoConflictResponse, RepoRepoCommittedEvent } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes repositories: its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();

/**
 * The team repo's one writer over HTTP (PLAN P4 criteria 2, 3 and 4): twenty parallel commits to different files are one linear history with
 * every change, two commits to one file from the same base give the second a 409 that carries the current content and overwrite nothing,
 * and bytes that are not text are refused with 422 and leave no commit behind.
 */

const { omar, nadia } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const commit = (request: APIRequestContext, p: Persona, changes: unknown[], message: string) =>
  request.post('/api/teams/engineering/repo/commit', { headers: as(p), data: { changes, message } });
const put = (path: string, content: string, extra: Record<string, unknown> = {}) => ({ op: 'put', path, content, ...extra });

test('20 parallel writes to different files: a linear history with all 20 changes', async ({ request }) => {
  const stack = await iso.start();
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => commit(request, i % 2 ? nadia : omar, [put(`pages/p${i}.md`, `page ${i}\n`)], `Page ${i}`)));
  expect(res.map((r) => r.status())).toEqual(Array(20).fill(201));
  const shas = await Promise.all(res.map(async (r) => CommitRepoResponse.parse(await r.json()).sha));
  expect(new Set(shas).size).toBe(20);

  const tree = GetRepoTreeResponse.parse(await (await request.get('/api/teams/engineering/repo/tree?path=pages', { headers: as(nadia) })).json());
  expect(tree.entries.filter((e) => /^p\d+\.md$/.test(e.name)).map((e) => e.name).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}.md`).sort());

  // linear: the team's first commit plus twenty, every commit's parent used exactly once
  const rows = await stack.sql<{ n: number; parents: number; roots: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT parent_sha)::int AS parents, count(*) FILTER (WHERE parent_sha IS NULL)::int AS roots
       FROM app.repo_commits c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering'`,
  );
  expect(rows[0]).toEqual({ n: 21, parents: 20, roots: 1 });
  const head = await stack.sql<{ head_sha: string }>("SELECT r.head_sha FROM app.repos r JOIN app.teams t ON t.id = r.team_id WHERE t.slug = 'engineering'");
  expect(shas).toContain(head[0]?.head_sha);

  // one committed event per commit, each valid
  const events = await stack.sql<{ payload: Record<string, unknown>; workspace_id: string }>(
    "SELECT e.payload, e.workspace_id FROM app.events e JOIN app.teams t ON t.id = e.team_id WHERE e.type = 'repo.repo.committed' AND t.slug = 'engineering'",
  );
  expect(events).toHaveLength(21);
  for (const e of events) RepoRepoCommittedEvent.parse({ ...e.payload, type: 'repo.repo.committed', schemaVersion: 1, workspaceId: e.workspace_id });
});

test('two writes to one file from the same base: the second gets 409 with the current content; nothing is overwritten', async ({ request }) => {
  const base = CommitRepoResponse.parse(await (await commit(request, nadia, [put('pages/shared.md', 'v1\n')], 'Create shared')).json()).paths[0]!.blobSha!;
  const [a, b] = await Promise.all([
    commit(request, nadia, [put('pages/shared.md', 'nadia was here\n', { baseBlobSha: base })], 'Nadia'),
    commit(request, omar, [put('pages/shared.md', 'omar was here\n', { baseBlobSha: base })], 'Omar'),
  ]);
  expect([a.status(), b.status()].sort()).toEqual([201, 409]);
  const [winner, loser] = a.status() === 201 ? ['nadia was here\n', b] : ['omar was here\n', a];
  const conflict = RepoConflictResponse.parse(await loser.json());
  expect(conflict.conflicts[0]).toMatchObject({ path: 'pages/shared.md', reason: 'changed', currentContent: winner });
  const blob = (await (await request.get('/api/teams/engineering/repo/blob?path=pages/shared.md', { headers: as(omar) })).json()) as { content: string };
  expect(blob.content).toBe(winner);
});

test('a PNG to pages/ is 422 attachment_not_in_repo and nothing is committed', async ({ request }) => {
  const stack = await iso.start();
  const count = async (): Promise<number> =>
    (await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM app.repo_commits c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering'"))[0]!.n;
  const before = await count();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR')]);
  const res = await commit(request, nadia, [{ op: 'put', path: 'pages/logo.png', content: png.toString('base64'), encoding: 'base64' }], 'Add logo');
  expect(res.status()).toBe(422);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('attachment_not_in_repo');
  expect(ErrorEnvelope.safeParse(body).success).toBe(true);
  expect(await count()).toBe(before);
  const tree = GetRepoTreeResponse.parse(await (await request.get('/api/teams/engineering/repo/tree?path=pages', { headers: as(nadia) })).json());
  expect(tree.entries.map((e) => e.name)).not.toContain('logo.png');
  expect(randomUUID()).toBeTruthy();
});
