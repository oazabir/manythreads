import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { CommitRepoResponse, KernelCapabilityDeniedEvent } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes repositories and audit events: its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();

/**
 * The writer rules over HTTP (PLAN P4 criteria 5 and 9): a bot's write to bots/, TEAM.md, skills/ and routines/ is denied by the kernel broker and
 * every denial is an audit event, while pages/x.md succeeds with the bot as author; Priya (a member, not a lead) gets 403 "change by pull request"
 * on the same paths, and Omar commits them as Omar.
 */

const { omar, priya, nadia } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const asBot = (actorId: string): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: omar.workspaceId }),
});
const commit = (request: APIRequestContext, headers: Record<string, string>, path: string, content = 'x\n') =>
  request.post('/api/teams/engineering/repo/commit', { headers, data: { changes: [{ op: 'put', path, content }], message: `write ${path}` } });
const GUARDED = ['bots/coder/BOT.md', 'TEAM.md', 'skills/triage/SKILL.md', 'routines/nightly.yaml'];

test('a bot is denied the four guarded paths (each denial audited) and may write pages/x.md', async ({ request }) => {
  const stack = await iso.start();
  const [{ id: botId }] = await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, randomUUID()]) as [{ id: string }];
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT id, $1, workspace_id, 'member' FROM app.teams WHERE slug = 'engineering'", [botId]);
  await stack.sql("INSERT INTO app.capability_grants (team_id, actor_id, capability) SELECT id, $1, 'files.write' FROM app.teams WHERE slug = 'engineering'", [botId]);

  for (const path of GUARDED) {
    const res = await commit(request, asBot(botId), path);
    expect(res.status(), path).toBe(403);
  }
  const ok = await commit(request, asBot(botId), 'pages/x.md', 'written by a bot\n');
  expect(ok.status()).toBe(201);
  expect(CommitRepoResponse.parse(await ok.json()).authorId).toBe(botId);

  const denials = await stack.sql<{ payload: Record<string, unknown>; workspace_id: string }>(
    "SELECT payload, workspace_id FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 ORDER BY id",
    [botId],
  );
  const parsed = denials.map((d) => KernelCapabilityDeniedEvent.parse({ ...d.payload, type: 'kernel.capability.denied', schemaVersion: 1, workspaceId: d.workspace_id }));
  expect(parsed.map((p) => p.path)).toEqual(GUARDED);
  expect(new Set(parsed.map((p) => p.capability))).toEqual(new Set(['files.write']));
  expect(parsed.every((p) => p.actorKind === 'bot')).toBe(true);

  // nothing of the four paths reached git; the page did
  const blob = await request.get('/api/teams/engineering/repo/blob?path=pages/x.md', { headers: as(nadia) });
  expect(((await blob.json()) as { content: string }).content).toBe('written by a bot\n');
  const botMd = await request.get('/api/teams/engineering/repo/blob?path=bots/coder/BOT.md', { headers: as(nadia) });
  expect(botMd.status()).toBe(404);
});

test('Priya (a member, not a lead) gets 403 "change by pull request"; Omar commits the same paths as Omar', async ({ request }) => {
  for (const path of GUARDED) {
    const res = await commit(request, as(priya), path);
    expect(res.status(), path).toBe(403);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/pull request/i) });
  }
  expect((await commit(request, as(priya), 'pages/priya.md', 'hello\n')).status()).toBe(201);
  for (const path of GUARDED) {
    const res = await commit(request, as(omar), path, `by omar: ${path}\n`);
    expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
    expect(CommitRepoResponse.parse(await res.json()).authorId).toBe(omar.actorId);
  }
  const stack = await iso.start();
  const authors = await stack.sql<{ author_id: string; paths: string[] }>(
    "SELECT c.author_id, c.paths FROM app.repo_commits c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.paths && $1::text[] AND c.author_id IS NOT NULL",
    [GUARDED],
  );
  expect(authors).toHaveLength(4);
  expect(new Set(authors.map((a) => a.author_id))).toEqual(new Set([omar.actorId]));
});
