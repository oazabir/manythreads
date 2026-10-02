import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { GetRepoHistoryResponse, KernelCapabilityDeniedEvent, PagesPageWrittenEvent, RepoRepoCommittedEvent, WritePageResponse, parseEvent } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes repositories and audit events: its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();
// the last test reads the events the first two wrote: same worker, same stack, in order
test.describe.configure({ mode: 'serial' });

/**
 * `pages.write` over HTTP (PLAN P4-07; criteria 3 and 5): create, replace and append are one commit each with the caller as author and a linear history;
 * the four guarded paths are 403 for a bot (each denial an audit event) and for people; the events are valid registry events.
 */

const { omar, nadia, priya } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const asBot = (actorId: string): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: omar.workspaceId }),
});
const write = (request: APIRequestContext, headers: Record<string, string>, mode: string, path: string, content: string, extra: Record<string, unknown> = {}) =>
  request.post('/api/teams/engineering/pages/write', { headers, data: { mode, path, content, ...extra } });
const GUARDED = ['bots/coder/BOT.md', 'TEAM.md', 'skills/triage/SKILL.md', 'routines/nightly.yaml'];

test('create, replace and append are one commit each, authored by the caller, in a linear history', async ({ request }) => {
  const P = 'pages/reports/week-37.md';
  const created = await write(request, as(nadia), 'create', P, '# Week 37\n');
  expect(created.status(), await created.text()).toBe(201);
  const c1 = WritePageResponse.parse(await created.json());
  expect(c1).toMatchObject({ mode: 'create', authorId: nadia.actorId, noop: false });

  const blob = (await (await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(P)}`, { headers: as(omar) })).json()) as { blobSha: string };
  const replaced = await write(request, as(priya), 'replace', P, '# Week 37\n\nall green\n', { baseBlobSha: blob.blobSha });
  expect(replaced.status(), await replaced.text()).toBe(201);
  const appended = await write(request, as(nadia), 'append', P, '\nNext week: ship.\n');
  expect(appended.status()).toBe(201);
  const again = await write(request, as(nadia), 'create', P, 'overwrite?');
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { conflicts: { currentContent: string }[] }).conflicts[0]?.currentContent).toBe('# Week 37\n\nall green\n\nNext week: ship.\n');

  const history = GetRepoHistoryResponse.parse(await (await request.get('/api/teams/engineering/repo/history?path=pages%2Freports%2Fweek-37.md', { headers: as(omar) })).json());
  expect(history.commits.map((c) => [c.authorId, c.change])).toEqual([
    [nadia.actorId, 'modified'],
    [priya.actorId, 'modified'],
    [nadia.actorId, 'added'],
  ]);
  const all = GetRepoHistoryResponse.parse(await (await request.get('/api/teams/engineering/repo/history?limit=100', { headers: as(omar) })).json()).commits;
  for (let i = 0; i < all.length - 1; i += 1) expect(all[i]!.parentSha).toBe(all[i + 1]!.sha);
  const content = await request.get(`/api/teams/engineering/repo/content?path=${encodeURIComponent(P)}`, { headers: as(omar) });
  expect(await content.text()).toBe('# Week 37\n\nall green\n\nNext week: ship.\n');
});

test('the four guarded paths are 403 for a bot (each denial audited) and for people; pages/x.md works for the bot with only pages.write', async ({ request }) => {
  const stack = await iso.start();
  const [{ id: botId }] = (await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, randomUUID()])) as [{ id: string }];
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT id, $1, workspace_id, 'member' FROM app.teams WHERE slug = 'engineering'", [botId]);
  await stack.sql("INSERT INTO app.capability_grants (team_id, actor_id, capability) SELECT id, $1, 'pages.write' FROM app.teams WHERE slug = 'engineering'", [botId]);

  for (const path of GUARDED) {
    expect((await write(request, asBot(botId), 'replace', path, 'x')).status(), `bot ${path}`).toBe(403);
    const person = await write(request, as(priya), 'replace', path, 'x');
    expect(person.status(), `priya ${path}`).toBe(403);
    expect(((await person.json()) as { error: { message: string } }).error.message).toMatch(/pull request/i);
  }
  const ok = await write(request, asBot(botId), 'create', 'pages/answers/saved.md', 'A saved answer.\n');
  expect(ok.status(), await ok.text()).toBe(201);
  expect(WritePageResponse.parse(await ok.json()).authorId).toBe(botId);

  const denials = await stack.sql<{ payload: Record<string, unknown>; workspace_id: string }>(
    "SELECT payload, workspace_id FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 ORDER BY id",
    [botId],
  );
  const parsed = denials.map((d) => KernelCapabilityDeniedEvent.parse({ ...d.payload, type: 'kernel.capability.denied', schemaVersion: 1, workspaceId: d.workspace_id }));
  expect(parsed.map((p) => p.path)).toEqual(GUARDED);
  expect(new Set(parsed.map((p) => p.capability))).toEqual(new Set(['pages.write']));
  expect(parsed.every((p) => p.actorKind === 'bot')).toBe(true);
  // none of the four reached git
  for (const path of GUARDED.filter((p) => p !== 'TEAM.md')) {
    expect((await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`, { headers: as(omar) })).status(), path).toBe(404);
  }
});

test('the events of a page write are valid: pages.page.written next to repo.repo.committed, with the author and the team', async () => {
  const stack = await iso.start();
  const rows = await stack.sql<{ type: string; payload: Record<string, unknown>; workspace_id: string; actor_id: string; schema_version: number }>(
    "SELECT type, payload, workspace_id, actor_id, schema_version FROM app.events WHERE type IN ('pages.page.written', 'repo.repo.committed') ORDER BY id",
  );
  const written = rows.filter((r) => r.type === 'pages.page.written').map((r) => PagesPageWrittenEvent.parse({ ...r.payload, type: r.type, schemaVersion: r.schema_version, workspaceId: r.workspace_id }));
  expect(written.length).toBeGreaterThanOrEqual(4);
  const committed = new Set(rows.filter((r) => r.type === 'repo.repo.committed').map((r) => RepoRepoCommittedEvent.parse({ ...r.payload, type: r.type, schemaVersion: r.schema_version, workspaceId: r.workspace_id }).sha));
  for (const e of written) {
    expect(committed.has(e.sha), e.path).toBe(true);
    expect(e.path.startsWith('pages/')).toBe(true);
  }
  expect(written.map((e) => e.mode).slice(0, 3)).toEqual(['create', 'replace', 'append']);
  expect(new Set(written.map((e) => e.actorKind))).toEqual(new Set(['person', 'bot']));
  // the generic registry parser accepts them too
  const raw = rows.find((r) => r.type === 'pages.page.written')!;
  expect(parseEvent({ ...raw.payload, type: raw.type, schemaVersion: raw.schema_version, workspaceId: raw.workspace_id })).toMatchObject({ type: 'pages.page.written' });
});
