import { createHash } from 'node:crypto';
import { eventToRaw } from '@manythreads/kernel';
import { BotsBotInvalidEvent, BotsBotLoadedEvent, BotsBotRemovedEvent, parseEvent } from '@manythreads/shared';
import { seedRepo } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// The BOT.md loader (PLAN P5-04): every change to `bots/<slug>/BOT.md` that lands a commit rebuilds the bot, or alerts and keeps the
// previous definition, or drops the row. The loader runs in the outbox consumer (half a second a poll at worst), so every assertion
// waits for it; the roster criterion gives the first one 5 seconds.

const { omar } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
  // seed v4: `createRepoWorld` seeds no repo content (repo-git's tests make their own commits), but the loader's first job is the real
  // fixture the seeder writes — `bots/coder/BOT.md` and its siblings, in one commit.
  await seedRepo(w.server.db, { attachments: false });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

/** Poll until `fn` returns something (a throw after `ms` is the failure: the loader did not get there in time). */
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the loader');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const ENG = TEAM_IDS.Engineering;

const botRow = (slug: string) =>
  w.system(async (tx) => (await tx.query<Record<string, string | Date | null>>(`SELECT * FROM app.bots WHERE team_id = $1 AND slug = $2`, [ENG, slug])).rows[0]);

/** Stored events of one type for the Engineering team, rebuilt and parsed (they were validated on the way in). */
const eventsOf = <T extends { type: string }>(type: string): Promise<T[]> =>
  w.system(async (tx) => {
    const res = await tx.query<{ type: string; schema_version: number; workspace_id: string; payload: Record<string, unknown> }>(
      'SELECT type, schema_version, workspace_id, payload FROM app.events WHERE type = $1 AND team_id = $2 ORDER BY id',
      [type, ENG],
    );
    return res.rows.map((row) => parseEvent(eventToRaw(row))) as unknown as T[];
  });

const invalidEventFor = (slug: string) =>
  until(async () => (await eventsOf<BotsBotInvalidEvent>('bots.bot.invalid')).find((event) => event.slug === slug) ?? null, 10_000);

// The loader reads whatever is in the repository, including a file no proposal would let in: these commits go straight through the writer.
const commit = (path: string, content: string, message: string) =>
  w.commitRaw(omar, 'engineering', [{ op: 'put', path, content }], message);

const validMd = (name: string, mayTag: readonly string[]): string => `---
schema: 1
name: ${name}
role: Answers questions in the loader tests
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post]
handover:
  mayTag: [${mayTag.join(', ')}]
---

# ${name}

Soul text. Everything below the fence is prose and never parsed.
`;

describe('the BOT.md loader', () => {
  it('the seeded BOT.md files load: coder is on the roster with its actor', async () => {
    const row = await until(() => botRow('coder'), 10_000);
    expect(row).toMatchObject({ slug: 'coder', kind: 'agent', runtime: 'hermes', status: 'active' });
    expect(String(row['definition_sha'])).toMatch(/^[0-9a-f]{64}$/);

    // definition_sha is the sha256 of the file, not of the git blob: read the file back over the API and hash the bytes.
    const blob = await w.call<{ content: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=bots%2Fcoder%2FBOT.md&ref=main');
    expect(blob.status).toBe(200);
    const expected = createHash('sha256').update(blob.body.content, 'utf8').digest('hex');
    expect(row['definition_sha']).toBe(expected);

    const actor = await w.system(async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND workspace_id = $1 AND ref_id = $2`, [personas.omar.workspaceId, row['id']])).rows[0],
    );
    expect(actor).toBeTruthy();

    const loaded = (await eventsOf<BotsBotLoadedEvent>('bots.bot.loaded')).find((event) => event.slug === 'coder');
    expect(loaded).toMatchObject({ botId: row['id'], definitionSha: row['definition_sha'], mayTag: [] });
  });

  it('a valid BOT.md appears in the roster in 5 s: row, actor, compiled mayTag grant, bots.bot.loaded', async () => {
    const content = validMd('Tester', ['reviewer']);
    const path = 'bots/p504-tester/BOT.md';
    const started = Date.now();
    const res = await commit(path, content, 'Add the test bot');
    expect(res.status).toBe(201);

    const row = await until(() => botRow('p504-tester'), 5_000); // the acceptance criterion's own clock
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(row).toMatchObject({ kind: 'agent', runtime: 'hermes', visibility: 'team', status: 'active' });
    expect(row['definition_sha']).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));

    const actor = await w.system(async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [row['id']])).rows[0],
    );
    expect(actor).toBeTruthy();

    // handover.mayTag compiled into the bot's allowlist: one grant, constraints naming the targets.
    const grant = await w.system(async (tx) =>
      (await tx.query<{ constraints: { mayTag?: string[] } }>(
        `SELECT constraints FROM app.capability_grants WHERE actor_id = $1 AND capability = 'tasks.handoff'`,
        [actor!.id],
      )).rows[0],
    );
    expect(grant?.constraints.mayTag).toEqual(['reviewer']);

    // P5-10: the definition's own projections are on the row — the triggers the router matches, and the allowlist it compiled
    // (`messages.post` is granted as written, needsApproval false because the file names no approval for it).
    expect(row['triggers']).toEqual([{ type: 'mention' }]);
    expect(row['native']).toEqual(['messages.post']);
    const native = await w.system(async (tx) =>
      (await tx.query<{ capability: string; needs_approval: boolean }>(
        `SELECT capability, needs_approval FROM app.capability_grants WHERE actor_id = $1 ORDER BY capability`,
        [actor!.id],
      )).rows,
    );
    // exactly two grants: the definition's own allowlist, and `tasks.handoff` from handover.mayTag
    expect(native).toEqual([
      { capability: 'messages.post', needs_approval: false },
      { capability: 'tasks.handoff', needs_approval: false },
    ]);

    // P5-10: the bot is a member of its team, which is what gives it the team's public channels (and nothing private).
    const membership = await w.system(async (tx) =>
      (await tx.query<{ team_id: string; role: string }>('SELECT team_id, role FROM app.team_members WHERE actor_id = $1', [actor!.id])).rows[0],
    );
    expect(membership).toEqual({ team_id: ENG, role: 'member' });

    const loaded = (await eventsOf<BotsBotLoadedEvent>('bots.bot.loaded')).find((event) => event.slug === 'p504-tester');
    expect(loaded).toMatchObject({ botId: row['id'], path, definitionSha: row['definition_sha'], mayTag: ['reviewer'] });
  });

  it('the knowledge list in BOT.md is projected onto the row, and dropping it clears the projection (P8-08)', async () => {
    const withList = validMd('Reader', []).replace('capabilities:', 'knowledge:\n  - base: manuals\n    answer_only_from: true\n  - base: faq\ncapabilities:');
    expect((await commit('bots/p808-reader/BOT.md', withList, 'A bot that reads the manuals')).status).toBe(201);
    const row = await until(() => botRow('p808-reader'), 10_000);
    expect(row['knowledge']).toEqual([
      { base: 'manuals', answer_only_from: true },
      { base: 'faq', answer_only_from: false },
    ]);
    expect((await commit('bots/p808-reader/BOT.md', validMd('Reader', []), 'No more lists')).status).toBe(201);
    const cleared = await until(async () => {
      const r = await botRow('p808-reader');
      return Array.isArray(r?.['knowledge']) && (r['knowledge'] as unknown[]).length === 0 ? r : null;
    }, 10_000);
    expect(cleared['knowledge']).toEqual([]);
  });

  it('an unknown key fails with the field path and creates no row', async () => {
    const content = '---\nname: Broken\nrole: Never loads\nkind: agent\nruntime: hermes\ncapabilties:\n  native: [messages.post]\n---\n\n# Broken\n';
    expect((await commit('bots/p504-broken/BOT.md', content, 'Add a broken bot')).status).toBe(201);

    const event = await invalidEventFor('p504-broken');
    expect(event.fieldPath).toBe('capabilties');
    expect(event.botId).toBeNull();
    expect(event.definitionSha).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
    expect(await botRow('p504-broken')).toBeUndefined();
  });

  it('a bad capability fails at its index; the previous definition stays live until the file is fixed', async () => {
    const previous = String((await botRow('p504-tester'))!['definition_sha']);
    const bad = validMd('Tester', ['reviewer']).replace('native: [messages.post]', 'native: [messages.post, files.write, tasks.own, NOT A CAPABILITY]');
    expect((await commit('bots/p504-tester/BOT.md', bad, 'Break the bot')).status).toBe(201);

    const event = await invalidEventFor('p504-tester');
    expect(event.fieldPath).toBe('capabilities.native[3]');
    const botId = String(event.botId);
    expect(botId).toBeTruthy();

    // the row keeps running: same definition as before, status invalid, the mayTag grant untouched
    const kept = await botRow('p504-tester');
    expect(kept).toMatchObject({ status: 'invalid', definition_sha: previous });
    const grant = await w.system(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.capability_grants WHERE actor_id = (SELECT id FROM app.actors WHERE ref_id = $1) AND capability = 'tasks.handoff'`, [botId])).rows[0],
    );
    expect(grant?.n).toBe(1);

    // fixing the file loads the row back to active, with the new sha and the new allowlist
    const fixed = validMd('Tester', ['reviewer', 'tester']);
    expect((await commit('bots/p504-tester/BOT.md', fixed, 'Fix the bot')).status).toBe(201);
    const reloaded = await until(async () => {
      const row = await botRow('p504-tester');
      return row && row['status'] === 'active' && row['definition_sha'] !== previous ? row : null;
    }, 10_000);
    expect(reloaded['definition_sha']).toBe(createHash('sha256').update(fixed, 'utf8').digest('hex'));
    const grant2 = await w.system(async (tx) =>
      (await tx.query<{ constraints: { mayTag?: string[] } }>(
        `SELECT constraints FROM app.capability_grants WHERE actor_id = (SELECT id FROM app.actors WHERE ref_id = $1) AND capability = 'tasks.handoff'`,
        [botId],
      )).rows[0],
    );
    expect(grant2?.constraints.mayTag).toEqual(['reviewer', 'tester']);
  });

  it('deleting BOT.md drops the row, the grants and the pairing tokens, and alerts', async () => {
    const row = (await botRow('p504-tester'))!;
    const botId = String(row['id']);
    // a live pairing token: it must cascade with the row (migration 0001)
    await w.system((tx) => tx.query('INSERT INTO app.bot_pairing_tokens (bot_id, token_hash) VALUES ($1, $2)', [botId, Buffer.alloc(32, 7)]));

    const res = await w.commit(omar, 'engineering', [{ op: 'delete', path: 'bots/p504-tester/BOT.md' }], 'Remove the test bot');
    expect(res.status).toBe(201);

    await until(async () => (await botRow('p504-tester')) === undefined, 10_000);
    const counts = await w.system(async (tx) =>
      (await tx.query<{ grants: number; tokens: number; members: number }>(
        `SELECT
           (SELECT count(*)::int FROM app.capability_grants WHERE actor_id = (SELECT id FROM app.actors WHERE ref_id = $1)) AS grants,
           (SELECT count(*)::int FROM app.bot_pairing_tokens WHERE bot_id = $1) AS tokens,
           -- the loader's own team membership row (P5-10) goes with the bot
           (SELECT count(*)::int FROM app.team_members WHERE actor_id = (SELECT id FROM app.actors WHERE ref_id = $1)) AS members`,
        [botId],
      )).rows[0],
    );
    expect(counts).toMatchObject({ grants: 0, tokens: 0, members: 0 });

    const [removed] = await eventsOf<BotsBotRemovedEvent>('bots.bot.removed');
    expect(removed).toMatchObject({ botId, slug: 'p504-tester' });
    // the actor row stays: messages it wrote reference it
    const actor = await w.system(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0],
    );
    expect(actor?.n).toBe(1);
  });

  it('a folder that is not a lowercase slug is an invalid definition, not a silent skip', async () => {
    expect((await commit('bots/NotASlug/BOT.md', validMd('Nope', []), 'Add a badly named bot')).status).toBe(201);
    const event = await invalidEventFor('NotASlug');
    expect(event.fieldPath).toBe('slug');
    expect(event.botId).toBeNull();
    expect(await botRow('NotASlug')).toBeUndefined();
  });

  it('a bot a lead turned off stays off through invalid and valid loads, and its reason is recorded and cleared', async () => {
    const slug = 'p504-paused';
    expect((await commit(`bots/${slug}/BOT.md`, validMd('Paused', []), 'Add paused')).status).toBe(201);
    await until(async () => ((await botRow(slug))?.['status'] === 'active' ? true : null), 10_000);
    await w.system((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE team_id = $1 AND slug = $2`, [ENG, slug]));

    // broken while disabled: still disabled, the reason is on the row
    const bad = validMd('Paused', []).replace('capabilities:', 'capabilties:');
    expect((await commit(`bots/${slug}/BOT.md`, bad, 'Break paused')).status).toBe(201);
    const broken = await until(async () => {
      const row = await botRow(slug);
      return row?.['invalid_reason'] ? row : null;
    }, 10_000);
    expect(broken['status']).toBe('disabled');
    expect(broken['invalid_reason']).toMatchObject({ fieldPath: 'capabilties' });

    // repaired: the new definition loads, the reason is cleared, and the bot is STILL disabled
    const before = String(broken['definition_sha']);
    expect((await commit(`bots/${slug}/BOT.md`, validMd('Paused again', []), 'Fix paused')).status).toBe(201);
    const fixed = await until(async () => {
      const row = await botRow(slug);
      return row && row['definition_sha'] !== before ? row : null;
    }, 10_000);
    expect(fixed['status']).toBe('disabled');
    expect(fixed['invalid_reason']).toBeNull();
    expect(fixed['name']).toBe('Paused again');
  });
});
