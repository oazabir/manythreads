import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { KernelCapabilityDeniedEvent } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();

/**
 * PLAN P5-23 criterion 13 over HTTP: a bot's own `files.write` to `bots/<slug>/lessons.md` and
 * `bots/<slug>/people/<id>.md` is denied (each denial an audit event, nothing committed), while the same
 * files stay writable by a lead as a proposal she applies (P7-01: no direct commit), and by the platform's system-actor writes (proven end to end in `packages/plugins/memory/test/platform.test.ts`).
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

const PATHS = ['bots/coder/lessons.md', `bots/coder/people/${nadia.actorId}.md`, `bots/brain/people/${nadia.actorId}.md`];

test('a bot is denied its lessons and people files (each denial audited); a lead writes them as herself', async ({ request }) => {
  const stack = await iso.start();
  const [{ id: botId }] = (await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [
    omar.workspaceId,
    randomUUID(),
  ])) as [{ id: string }];
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT id, $1, workspace_id, 'member' FROM app.teams WHERE slug = 'engineering'", [botId]);
  await stack.sql("INSERT INTO app.capability_grants (team_id, actor_id, capability) SELECT id, $1, 'files.write' FROM app.teams WHERE slug = 'engineering'", [botId]);

  for (const path of PATHS) {
    const res = await commit(request, asBot(botId), path, 'a bot writing its own memory\n');
    expect(res.status(), path).toBe(403);
  }

  const denials = await stack.sql<{ payload: Record<string, unknown>; workspace_id: string }>(
    "SELECT payload, workspace_id FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 ORDER BY id",
    [botId],
  );
  const parsed = denials.map((d) => KernelCapabilityDeniedEvent.parse({ ...d.payload, type: 'kernel.capability.denied', schemaVersion: 1, workspaceId: d.workspace_id }));
  expect(parsed.map((p) => p.path)).toEqual(PATHS);
  expect(new Set(parsed.map((p) => p.capability))).toEqual(new Set(['files.write']));

  // nothing of the three paths reached git
  for (const path of PATHS) {
    const got = await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`, { headers: as(nadia) });
    expect(got.status(), path).toBe(404);
  }

  // since P7-01 a lead no longer commits bots/ directly (403); she applies the same files as a proposal, and the commit is hers. The platform's own
  // writes (the system actor) are not a person's commit and stay as they were.
  for (const path of PATHS) {
    const direct = await commit(request, as(omar), path, `platform note: ${path}\n`);
    expect(direct.status(), path).toBe(403);
    const res = await request.post('/api/teams/engineering/proposals', { headers: as(omar), data: { path, content: `platform note: ${path}\n`, title: `Note ${path}`, applyNow: true } });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
  }
  const got = await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(PATHS[0]!)}`, { headers: as(nadia) });
  expect(((await got.json()) as { content: string }).content).toContain('platform note');
});
