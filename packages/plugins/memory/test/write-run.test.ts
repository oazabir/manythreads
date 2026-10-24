import { randomUUID } from 'node:crypto';
import {
  CapabilityBroker,
  CapabilityRegistry,
  createAppPool,
  createDbGrantSource,
  createRunService,
  createSystemPool,
} from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { GetRepoHistoryResponse } from '@manythreads/shared';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// `memory.write` (PLAN P5-26, criterion 16) through a real run: the handler the server registers, a live bot run with a person as its asker, the
// broker's grant and path guard, and the one repo writer. What a model may not claim is dropped; a concept a person wrote is never overwritten;
// a path that is not a concept of the bundle is refused and audited, and nothing is committed.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
let systemPool: ReturnType<typeof createSystemPool>;
let appPool: ReturnType<typeof createAppPool>;
let runs: ReturnType<typeof createRunService>;
let handler: (input: Record<string, unknown>, tx: PluginTx) => unknown | Promise<unknown>;
let bot: { botId: string; actorId: string };

const openRun = (): Promise<{ run: BotRunHandle; token: string }> =>
  runs.open({ botId: bot.botId, teamId: ENG, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });

const write = async (run: BotRunHandle, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await runs.asBot(run, async (tx) => await handler(input, tx))) as Record<string, unknown>;

const blob = async (path: string): Promise<{ status: number; content: string | null }> => {
  const res = await w.call(nadia, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=main`);
  return { status: res.status, content: res.status === 200 ? (res.body as { content: string }).content : null };
};

const history = async (path: string) =>
  GetRepoHistoryResponse.parse(
    (await w.call(nadia, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}&limit=10`)).body,
  ).commits;

beforeAll(async () => {
  w = await createRepoWorld();
  handler = w.server.host.registries.capabilityHandlers.get('memory.write')!.handler;
  // A bot of the team that may write memory: an `app.bots` row (a run needs one), its actor, the membership and the grant.
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'mem-writer', 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [
      omar.workspaceId,
      botId,
    ]);
    const actorId = actor.rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actorId, omar.workspaceId]);
    await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'memory.write', false, '{}')", [
      ENG,
      actorId,
    ]);
    return { botId, actorId };
  });
  appPool = createAppPool(w.server.db.appUrl);
  systemPool = createSystemPool(w.server.db.systemUrl, 2);
  const registry = new CapabilityRegistry();
  runs = createRunService({
    pool: appPool,
    systemPool,
    registry,
    broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }),
    handlers: w.server.host.registries.capabilityHandlers,
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
});

it('commits the concept as the bot, with the asking person as co-author, and drops what a model may not claim', async () => {
  const { run } = await openRun();
  const forged = `human:${randomUUID()}`;
  const answer = await write(run, {
    path: 'memory/facts/cache-ttl.md',
    type: 'decision',
    title: 'Cache TTL',
    description: 'How long a response may be cached.',
    body: 'Thirty seconds, decided in the October review. See [the note](../journal/2026-10-14.md).\n',
    verified: [{ by: forged }],
    origin: 'share',
    generated: { by: 'archivist/v9' },
    sources: [{ resource: 'https://example.com/x' }],
  });
  expect(answer).toMatchObject({
    ok: true,
    path: 'memory/facts/cache-ttl.md',
    draft: false,
    trustTier: 'unverified',
    committed: true,
    dropped: ['verified', 'origin', 'generated', 'sources'],
  });
  expect(answer['sha']).toMatch(/^[0-9a-f]{40}$/);

  const got = await blob('memory/facts/cache-ttl.md');
  expect(got.status).toBe(200);
  const text = got.content ?? '';
  expect(text).toContain('type: decision');
  expect(text).toContain('title: Cache TTL');
  // the platform's own provenance, not the model's: `generated.by` is the bot and its runtime, and nothing the caller sent
  expect(text).toContain('by: mem-writer/rules');
  expect(text).not.toContain('archivist/v9');
  expect(text).not.toContain(forged);
  expect(text).not.toContain('origin:');
  // a relative link into the bundle became a bundle-absolute one (OKF §6.1)
  expect(text).toContain('](/journal/2026-10-14.md)');

  const commits = await history('memory/facts/cache-ttl.md');
  expect(commits[0]).toMatchObject({
    authorId: bot.actorId,
    coAuthorIds: [nadia.actorId],
    subject: 'memory.write: memory/facts/cache-ttl.md',
  });
  // the asker is named on the git trailer too, so a `git log` outside manythreads shows who asked
  expect(commits[0]!.message).toContain('Co-authored-by: Nadia');
});

it('never overwrites a concept a person wrote: the proposal is filed as a draft sibling that links to it', async () => {
  const path = 'memory/facts/person-owned.md';
  const created = await w.commit(omar, 'engineering', [{ op: 'put', path, content: '---\ntype: fact\ntitle: A person’s fact\n---\n\nA person wrote this.\n' }], 'a person writes a concept');
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const { run } = await openRun();
  const answer = await write(run, { path, type: 'fact', title: 'A person’s fact', body: 'A bot would say something else.\n' });
  expect(answer).toMatchObject({ ok: true, draft: true, of: path, path: 'memory/facts/person-owned-draft-mem-writer.md' });

  const draft = await blob('memory/facts/person-owned-draft-mem-writer.md');
  expect(draft.status).toBe(200);
  expect(draft.content).toContain('status: draft');
  expect(draft.content).toContain('](/facts/person-owned.md)');
  expect(draft.content).toContain('A bot would say something else.');
  // the person's concept is untouched, and the draft is a machine write (the bot's own producer)
  expect((await blob(path)).content).toContain('A person wrote this.');
  expect((await blob(path)).content).not.toContain('A bot would say something else.');

  // the draft's name is stable per bot: trying again updates that one draft, it does not file a second
  const again = await write(run, { path, type: 'fact', body: 'The bot tried again.\n' });
  expect(again).toMatchObject({ ok: true, path: 'memory/facts/person-owned-draft-mem-writer.md' });
  expect((await blob('memory/facts/person-owned-draft-mem-writer.md')).content).toContain('The bot tried again.');
});

it('refuses a path that is not a concept of the bundle, audits each denial, and writes nothing', async () => {
  const { run } = await openRun();
  const refused = ['memory/shared/glossary.md', 'memory/index.md', 'memory/log.md', 'memory/facts/notes.txt', 'pages/x.md', 'inbox/drop.md'];
  const before = new Map<string, string | null>();
  for (const path of ['memory/index.md', 'memory/log.md']) before.set(path, (await blob(path)).content);
  for (const path of refused) {
    expect(await write(run, { path, type: 'fact', body: 'x\n' }), path).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
  }
  const denials = await w.system(async (tx) =>
    (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1", [bot.actorId])).rows,
  );
  expect(denials.map((d) => d.payload['path'])).toEqual(refused);
  expect(denials.every((d) => d.payload['capability'] === 'memory.write' && d.payload['actorKind'] === 'bot')).toBe(true);
  // nothing was written: the paths that did not exist still do not, and the platform's own files are byte-identical
  for (const path of ['memory/shared/glossary.md', 'memory/facts/notes.txt', 'pages/x.md']) expect((await blob(path)).status, path).toBe(404);
  for (const [path, content] of before) expect((await blob(path)).content, path).toBe(content);
});

it('refuses a proposal with no `type` in the parser’s own words, and commits nothing', async () => {
  const { run } = await openRun();
  const answer = await write(run, { path: 'memory/facts/no-type.md', body: 'a body but no type\n' });
  expect(answer).toMatchObject({ ok: false, status: 422, code: 'okf_invalid' });
  expect(String(answer['message'])).toContain('memory/facts/no-type.md');
  expect(String(answer['message'])).toMatch(/no `type`/);
  expect((await blob('memory/facts/no-type.md')).status).toBe(404);
});

it('refuses arguments that are not a proposal, and a transaction that is not a live bot run', async () => {
  const { run } = await openRun();
  expect(await write(run, { type: 'fact', body: 'no path\n' })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  expect(await write(run, { path: 'memory/facts/x.md', type: 42 })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  expect(await write(run, { path: 'memory/facts/x.md', type: 'fact', bogus: true })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  // a person's own transaction has no bot to commit as
  const asPerson = await w.as(omar, async (tx) => await handler({ path: 'memory/facts/x.md', type: 'fact', body: 'x\n' }, tx as PluginTx));
  expect(asPerson).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
});

it('does not hand a database error to the model: it is thrown for the gateway to word generically', async () => {
  const { run } = await openRun();
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "memory_run_context_pkey"'), { code: '23505' });
  await expect(
    runs.asBot(run, async (tx) => {
      const failing = { ...tx, actor: tx.actor, query: () => Promise.reject(pgError) } as unknown as PluginTx;
      return await handler({ path: 'memory/facts/pg.md', type: 'fact', body: 'x\n' }, failing);
    }),
  ).rejects.toBe(pgError);
});
