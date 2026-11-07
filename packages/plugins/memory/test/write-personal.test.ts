import { createAppPool, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// P20-05, through a real server and a real run: a person's own Memory over `/api/me/memory/*`, and `memory.write` with `target: 'personal'`. The bundle is rows,
// never a repo commit; only the person who asked (and only when they allowed the bot) is written to; a person's own file is never replaced by a bot.

const { omar, nadia, rafi, lena } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
let systemPool: ReturnType<typeof createSystemPool>;
let appPool: ReturnType<typeof createAppPool>;
let runs: ReturnType<typeof createRunService>;
let handler: (input: Record<string, unknown>, tx: PluginTx) => unknown | Promise<unknown>;
let bot: { botId: string; actorId: string };

const openRun = (trigger: 'conversation' | 'routine'): Promise<{ run: BotRunHandle; token: string }> =>
  runs.open({ botId: bot.botId, teamId: ENG, workspaceId: omar.workspaceId, trigger, ...(trigger === 'conversation' ? { askerActorId: nadia.actorId } : {}) });
const write = async (run: BotRunHandle, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await runs.asBot(run, async (tx) => await handler(input, tx))) as Record<string, unknown>;

const FACT = '---\ntype: Fact\ntitle: Tea\n---\nRafi likes tea.\n';
const mePut = (path: string, content: string, baseVersion?: number | null) =>
  w.call<{ file: { versionNo: number; content: string }; concept: { space: string; type: string } }>(nadia, 'PUT', '/api/me/memory/file', {
    path,
    content,
    ...(baseVersion === undefined ? {} : { baseVersion }),
  });

beforeAll(async () => {
  w = await createRepoWorld();
  handler = w.server.host.registries.capabilityHandlers.get('memory.write')!.handler;
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'personal-writer', 'Personal writer', 'Writes memory', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId]);
    const actorId = actor.rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actorId, omar.workspaceId]);
    for (const capability of ['memory.write', 'personal.read']) {
      await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')", [ENG, actorId, capability]);
    }
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

describe('a person\'s own Memory over the API', () => {
  it('saves, lists, reads, versions, restores and deletes a file, only for the signed-in person', async () => {
    const first = await mePut('people/rafi.md', FACT, null);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.file.versionNo).toBe(1);
    expect(first.body.concept).toMatchObject({ type: 'Fact', space: expect.stringMatching(/^person:/) });
    const second = await mePut('people/rafi.md', FACT.replace('tea', 'coffee'), 1);
    expect(second.body.file.versionNo).toBe(2);
    // an edit that started from an old version is refused
    expect((await mePut('people/rafi.md', FACT.replace('tea', 'juice'), 1)).status).toBe(409);
    // a file that is not a valid concept is refused with the validator's words
    const bad = await mePut('people/bad.md', 'no frontmatter here');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('people/bad.md');

    const listed = await w.call<{ items: Array<{ path: string }> }>(nadia, 'GET', '/api/me/memory/concepts');
    expect(listed.body.items.map((i) => i.path)).toEqual(['people/rafi.md']);
    const got = await w.call<{ file: { content: string } }>(nadia, 'GET', '/api/me/memory/file?path=people%2Frafi.md');
    expect(got.body.file.content).toContain('coffee');
    const versions = await w.call<{ items: Array<{ versionNo: number; authorKind: string }> }>(nadia, 'GET', '/api/me/memory/versions?path=people%2Frafi.md');
    expect(versions.body.items.map((v) => [v.versionNo, v.authorKind])).toEqual([[2, 'person'], [1, 'person']]);

    const restored = await w.call<{ file: { versionNo: number; content: string } }>(nadia, 'POST', '/api/me/memory/restore', { path: 'people/rafi.md', versionNo: 1 });
    expect(restored.body.file).toMatchObject({ versionNo: 3 });
    expect(restored.body.file.content).toContain('tea');

    // nobody else sees it, and a guest has no Personal space at all
    expect((await w.call<{ items: unknown[] }>(rafi, 'GET', '/api/me/memory/concepts')).body.items).toEqual([]);
    expect((await w.call(rafi, 'GET', '/api/me/memory/file?path=people%2Frafi.md')).status).toBe(404);
    expect((await w.call(lena, 'GET', '/api/me/memory/concepts')).status).toBe(403);
    expect((await w.call(lena, 'PUT', '/api/me/memory/file', { path: 'a.md', content: FACT })).status).toBe(403);
    // the team's own repo never saw it
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/repo/blob?path=memory%2Fpeople%2Frafi.md&ref=main')).status).toBe(404);
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/repo/blob?path=people%2Frafi.md&ref=main')).status).toBe(404);

    expect((await w.call(nadia, 'DELETE', '/api/me/memory/file?path=people%2Frafi.md')).status).toBe(200);
    expect((await w.call(nadia, 'GET', '/api/me/memory/file?path=people%2Frafi.md')).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', '/api/me/memory/file?path=people%2Frafi.md')).status).toBe(404);
  });
});

describe('memory.write with target personal', () => {
  const personalWrite = { target: 'personal', path: 'memory/facts/coffee.md', type: 'fact', title: 'Coffee', body: 'Nadia drinks coffee.\n', verified: [{ by: 'human:x' }] };

  it('is refused until the person allows the bot, and says why', async () => {
    const { run } = await openRun('conversation');
    expect(await write(run, personalWrite)).toMatchObject({ ok: false, code: 'personal_not_open', message: expect.stringContaining('not allowed') });
  });

  it('writes to the asking person\'s Memory once allowed, as a bot version, with the platform\'s stamp and not in the team repo', async () => {
    const consent = await w.call(nadia, 'PUT', `/api/me/bot-consents/${bot.botId}`, { allowed: true });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    const { run } = await openRun('conversation');
    const answer = await write(run, personalWrite);
    expect(answer).toMatchObject({ ok: true, space: expect.stringMatching(/^person:/), path: 'facts/coffee.md', draft: false, committed: true, version: 1, dropped: ['verified'] });
    const file = await w.call<{ file: { content: string } }>(nadia, 'GET', '/api/me/memory/file?path=facts%2Fcoffee.md');
    expect(file.body.file.content).toContain('generated:');
    expect(file.body.file.content).toContain('personal-writer/');
    expect(file.body.file.content).not.toContain('human:x');
    const versions = await w.call<{ items: Array<{ authorKind: string }> }>(nadia, 'GET', '/api/me/memory/versions?path=facts%2Fcoffee.md');
    expect(versions.body.items.map((v) => v.authorKind)).toEqual(['bot']);
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/repo/blob?path=memory%2Ffacts%2Fcoffee.md&ref=main')).status).toBe(404);
    // a concept with no type is refused by the shared validator, nothing is written
    expect(await write(run, { target: 'personal', path: 'facts/untyped.md', body: 'no type' })).toMatchObject({ ok: false, code: 'okf_invalid' });
  });

  it('files a draft beside a file the person wrote, and never replaces it', async () => {
    await mePut('facts/mine.md', '---\ntype: Fact\ntitle: Mine\n---\nMy own words.\n', null);
    const { run } = await openRun('conversation');
    const answer = await write(run, { target: 'personal', path: 'facts/mine.md', type: 'fact', title: 'Mine', body: 'A bot rewrite.\n' });
    expect(answer).toMatchObject({ ok: true, draft: true, of: 'facts/mine.md', path: 'facts/mine-draft-personal-writer.md' });
    const mine = await w.call<{ file: { content: string } }>(nadia, 'GET', '/api/me/memory/file?path=facts%2Fmine.md');
    expect(mine.body.file.content).toContain('My own words.');
  });

  it('has no Personal space in a run with no asking person, and the default target is still the team', async () => {
    const { run } = await openRun('routine');
    expect(await write(run, personalWrite)).toMatchObject({ ok: false, code: 'personal_not_open' });
    const team = await write(run, { path: 'memory/facts/team-note.md', type: 'fact', title: 'Team', body: 'For the team.\n' });
    expect(team).toMatchObject({ ok: true, path: 'memory/facts/team-note.md', committed: true });
    expect(await write(run, { ...personalWrite, target: 'elsewhere' })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('stops at the next call when the person withdraws their yes', async () => {
    await w.call(nadia, 'PUT', `/api/me/bot-consents/${bot.botId}`, { allowed: false });
    const { run } = await openRun('conversation');
    expect(await write(run, { ...personalWrite, path: 'facts/after.md' })).toMatchObject({ ok: false, code: 'personal_not_open' });
  });
});
