import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type APIResponse } from '@playwright/test';
import { CommitRepoResponse, KernelCapabilityDeniedEvent } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes repositories and audit events: its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();
// the third test reads what the first two wrote: same worker, same stack, in order
test.describe.configure({ mode: 'serial' });

/**
 * The OKF writer over HTTP (PLAN P5-25 criteria 6 and 18, P5-26 criterion 16's first half): every concept file under `memory/` is validated by the one
 * pure parser, so a file with no `type` or unreadable YAML is refused 422 `okf_invalid` and nothing is committed; a bot's `files.write` into `memory/`
 * or `inbox/` is denied by the broker with an audit event; `inbox/` and `channels/` are Files storage, never repo folders, for anybody; and
 * `index.md`/`log.md` are regenerated in the same commit as the concept — byte-identically, so a hand edit of them is replaced by the regenerated
 * bytes and a commit that would not change them does not happen at all.
 */

const { omar, nadia } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const asBot = (actorId: string): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: omar.workspaceId }),
});
const commit = (request: APIRequestContext, headers: Record<string, string>, path: string, content = 'x\n') =>
  request.post('/api/teams/engineering/repo/commit', { headers, data: { changes: [{ op: 'put', path, content }], message: `write ${path}` } });
const concept = (title: string, extra = ''): string => `---\ntype: fact\ntitle: ${title}\n${extra}---\n\n${title} body.\n`;
const blob = async (request: APIRequestContext, path: string): Promise<{ status: number; content: string | null }> => {
  const res = await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`, { headers: as(nadia) });
  return { status: res.status(), content: res.status() === 200 ? ((await res.json()) as { content: string }).content : null };
};
const text = async (request: APIRequestContext, path: string): Promise<string> => (await blob(request, path)).content ?? '';
const error = async (res: APIResponse): Promise<{ code: string; message: string }> =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

test('a concept with no `type`, or frontmatter that is not valid YAML, is refused 422 okf_invalid and nothing is committed', async ({ request }) => {
  const stack = await iso.start();
  const bad: [string, string][] = [
    // criterion 6: a file with no `type` is refused and nothing is committed
    ['memory/facts/e2e-no-type.md', '---\ntitle: no type\n---\n\nbody\n'],
    ['memory/facts/e2e-bad-yaml.md', '---\ntype: fact\nbad: [unclosed\n---\n\nbody\n'],
  ];
  const reasons: string[] = [];
  for (const [path, content] of bad) {
    const res = await commit(request, as(omar), path, content);
    expect(res.status(), path).toBe(422);
    const refusal = await error(res);
    expect(refusal.code, path).toBe('okf_invalid');
    expect(refusal.message, path).toContain(path);
    reasons.push(refusal.message);
    expect(await text(request, path), path).toBe('');
  }
  // the reason is the parser's own words, naming the file — the same sentence the editor's preview shows
  expect(reasons[0]).toMatch(/no `type`/);
  expect(reasons[1]).toMatch(/not valid YAML/);

  // …and no commit names them (the team's history holds no such path)
  const rows = await stack.sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.repo_commits WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND paths && $1::text[]",
    [bad.map(([path]) => path)],
  );
  expect(rows[0]!.n).toBe('0');
});

test('a bot may not files.write into memory/ or inbox/ (each denial audited); inbox/ and channels/ are never repo folders', async ({ request }) => {
  const stack = await iso.start();
  const [{ id: botId }] = (await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [
    omar.workspaceId,
    randomUUID(),
  ])) as [{ id: string }];
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT id, $1, workspace_id, 'member' FROM app.teams WHERE slug = 'engineering'", [botId]);
  await stack.sql("INSERT INTO app.capability_grants (team_id, actor_id, capability) SELECT id, $1, 'files.write' FROM app.teams WHERE slug = 'engineering'", [botId]);

  // criterion 16: the bot's own file write into the bundle and into the inbox is denied
  const denied = ['memory/facts/e2e-bot.md', 'memory/index.md', 'inbox/drop.md'];
  for (const path of denied) expect((await commit(request, asBot(botId), path, 'a bot writing memory\n')).status(), path).toBe(403);

  const denials = await stack.sql<{ payload: Record<string, unknown>; workspace_id: string }>(
    "SELECT payload, workspace_id FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 ORDER BY id",
    [botId],
  );
  const parsed = denials.map((d) => KernelCapabilityDeniedEvent.parse({ ...d.payload, type: 'kernel.capability.denied', schemaVersion: 1, workspaceId: d.workspace_id }));
  expect(parsed.map((p) => p.path)).toEqual(denied);
  expect(parsed.every((p) => p.capability === 'files.write' && p.actorKind === 'bot')).toBe(true);
  for (const path of denied) expect(await text(request, path), path).toBe('');

  // criterion 18: `inbox/` and `channels/` are Files storage (400 validation_failed), not repo folders — the same answer for a lead
  for (const path of ['inbox/notes.md', 'channels/general/notes.md']) {
    const res = await commit(request, as(omar), path);
    expect(res.status(), path).toBe(400);
    expect(await error(res), path).toMatchObject({ code: 'validation_failed' });
  }
});

test('index.md and log.md change in the same commit as the concept, and regenerate byte-identically', async ({ request }) => {
  await iso.start();
  const first = CommitRepoResponse.parse(await (await commit(request, as(omar), 'memory/facts/e2e-cache.md', concept('E2E Cache TTL'))).json());
  const shas = new Map(first.paths.map((p) => [p.path, p.blobSha]));
  // criterion 18: the concept, its folder index, the root index and the log are all in that one commit
  for (const path of ['memory/facts/e2e-cache.md', 'memory/facts/index.md', 'memory/index.md', 'memory/log.md']) {
    expect(shas.get(path), path).toMatch(/^[0-9a-f]{40}$/);
  }
  const index = await text(request, 'memory/facts/e2e-cache.md');
  expect(index).toContain('type: fact');
  expect(await text(request, 'memory/facts/index.md')).toContain('E2E Cache TTL');
  expect(await text(request, 'memory/log.md')).toContain('/facts/e2e-cache.md');

  // byte-identically: a hand edit of the platform's own files is replaced by the regenerated bytes, the tree does not change, and no commit happens
  for (const generated of ['memory/index.md', 'memory/log.md', 'memory/facts/index.md']) {
    const res = await commit(request, as(omar), generated, 'hand-written garbage\n');
    expect(res.status(), generated).toBe(200);
    const out = CommitRepoResponse.parse(await res.json());
    expect(out.noop, generated).toBe(true);
    expect(out.paths, generated).toEqual([]);
  }
  expect(await text(request, 'memory/facts/index.md')).toContain('E2E Cache TTL');
  expect(await text(request, 'memory/index.md')).not.toContain('garbage');

  // a second concept in the same folder moves both the index and the log, in its own single commit
  const second = CommitRepoResponse.parse(await (await commit(request, as(omar), 'memory/facts/e2e-window.md', concept('E2E Window', 'description: The rolling window.\n'))).json());
  const again = new Map(second.paths.map((p) => [p.path, p.blobSha]));
  expect(again.get('memory/facts/index.md')).not.toBe(shas.get('memory/facts/index.md'));
  expect(again.get('memory/log.md')).not.toBe(shas.get('memory/log.md'));
  const folder = await text(request, 'memory/facts/index.md');
  expect(folder).toContain('E2E Cache TTL');
  expect(folder).toContain('E2E Window');
  expect(await text(request, 'memory/log.md')).toContain('/facts/e2e-window.md');
});
