import { createHash } from 'node:crypto';
import { createAppPool, createMemoryKv, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginEvent, PluginTx, ProviderImpl } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bots from '../src/index.ts';
import { BACKFILL_QUEUE, backfillModelAliases } from '../src/backfill.ts';

// Review of P5-10, finding 2: migration 0008 added `bots.model_aliases` (default '{}') with nothing to fill it for the bots that
// were already loaded, so their LLM keys were never minted until somebody recommitted the BOT.md. The backfill re-reads the file
// at `main` for the rows with an empty projection and says `bots.bot.loaded` again (the gateway turns that into a key).

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let sysPool: pg.Pool;
let appPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let emitted: PluginEvent[];
/** What `main` holds, by path: the stand-in for the repo provider. */
const files = new Map<string, string>();
let registries: ExtensionRegistries;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const sha = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

const definition = (model: string): string => `---
schema: 1
name: Backfill probe
role: Answers in the backfill tests
kind: agent
runtime: hermes
${model}triggers:
  - type: mention
capabilities:
  native: [messages.post]
---

# Backfill probe
`;

/** A bot row as it stood before migration 0008: loaded, active, `model_aliases` empty — whatever the file says. */
async function legacyBot(slug: string, content: string, overrides: { runtime?: string; status?: string; definitionSha?: string } = {}): Promise<string> {
  files.set(`bots/${slug}/BOT.md`, content);
  return sys(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, may_tag, model_aliases)
       VALUES ($1, $2, $3, $3, 'a backfill probe', 'agent', $4, 'team', $5, $6, '{reviewer}', '{}') RETURNING id`,
      [omar.workspaceId, ENG, slug, overrides.runtime ?? 'hermes', overrides.definitionSha ?? sha(content), overrides.status ?? 'active'],
    );
    return res.rows[0]!.id;
  });
}

const aliasesOf = (botId: string): Promise<string[]> =>
  sys(async (tx) => (await tx.query<{ model_aliases: string[] }>('SELECT model_aliases FROM app.bots WHERE id = $1', [botId])).rows[0]!.model_aliases);

const run = (): Promise<number> => sys((tx) => backfillModelAliases(ctx, tx as unknown as PluginTx));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  appPool = createAppPool(db.appUrl, 2);
  emitted = [];
  registries = new ExtensionRegistries();
  ctx = createPluginContext(bots.manifest, {
    registries,
    storage: createMemoryKv(),
    mail: { send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: (_tx, event) => {
      emitted.push(event);
      return Promise.resolve();
    },
  });
  // The repo provider belongs to repo-git; this plugin only reads through it, so a map of paths is a faithful stand-in.
  registries.providers['repo'].add('test', {
    id: 'repo',
    blob: (_tx: PluginTx, _teamId: string, path: string) => {
      const content = files.get(path);
      if (content === undefined) return Promise.reject(new Error(`no ${path} at main`));
      return Promise.resolve({ commitSha: 'c'.repeat(40), sha: 'b'.repeat(40), size: content.length, content: new TextEncoder().encode(content) });
    },
  } as unknown as ProviderImpl);
  await bots.register(ctx);
}, 120_000);

afterAll(async () => {
  await sysPool?.end();
  await appPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(() => {
  emitted.length = 0;
});

describe('the model_aliases backfill', () => {
  it('registers its daily job under the plugin namespace', () => {
    const entry = registries.jobs.list().find((job) => job.value.queue === BACKFILL_QUEUE);
    expect(entry).toBeTruthy();
  });

  it('fills a bot loaded before migration 0008 from its BOT.md at main, and says bots.bot.loaded so the gateway mints its key', async () => {
    const content = definition('model:\n  aliases: [smart, fast]\n  fallbacks: [local, smart]\n');
    const botId = await legacyBot('legacy-bot', content);
    expect(await aliasesOf(botId)).toEqual([]);

    expect(await run()).toBe(1);
    expect(await aliasesOf(botId)).toEqual(['smart', 'fast', 'local']); // aliases, then fallbacks, without repeats: the loader's own list
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'bots.bot.loaded',
      botId,
      slug: 'legacy-bot',
      path: 'bots/legacy-bot/BOT.md',
      definitionSha: sha(content),
      mayTag: ['reviewer'],
    });

    // Repeating changes nothing and announces nothing: the row is no longer empty.
    emitted.length = 0;
    expect(await run()).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('leaves a bot whose file moved on to the loader, and one whose file names no model alone', async () => {
    const moved = await legacyBot('moved-bot', definition('model:\n  aliases: [smart]\n'), { definitionSha: 'f'.repeat(64) });
    const modelless = await legacyBot('modelless-bot', definition(''));
    const missing = await legacyBot('missing-bot', definition('model:\n  aliases: [smart]\n'));
    files.delete('bots/missing-bot/BOT.md');

    expect(await run()).toBe(0);
    expect(await aliasesOf(moved)).toEqual([]); // main is newer than the row: the loader's event is the one that rewrites it
    expect(await aliasesOf(modelless)).toEqual([]);
    expect(await aliasesOf(missing)).toEqual([]);
    expect(emitted).toHaveLength(0);
  });

  it('only touches active hermes bots', async () => {
    const model = 'model:\n  aliases: [smart]\n';
    const rules = await legacyBot('rules-bot', definition(model), { runtime: 'rules' });
    const disabled = await legacyBot('disabled-bot', definition(model), { status: 'disabled' });
    const invalid = await legacyBot('invalid-bot', definition(model), { status: 'invalid' });
    expect(await run()).toBe(0);
    for (const id of [rules, disabled, invalid]) expect(await aliasesOf(id)).toEqual([]);
  });
});
