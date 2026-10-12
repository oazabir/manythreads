import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  gatewayLlmMigrationSource,
  personaActor,
  personas,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-06: who may read or write the LLM config. The provider rows carry credentials (through app.secrets) and the alias rows
// are what every bot's calls resolve against, so both are workspace-admin territory — a plain member or a guest sees no row
// at all. The key rows are written by the system job; an admin may read the non-secret head.

const { omar, nadia, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = async (p: Persona, table: string): Promise<number> => {
  const rows = await as(p, (tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table}`));
  return Number(rows.rows[0]?.n ?? 0);
};

let providerId = '';

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, gatewayLlmMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  await sys(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Anthropic', 'anthropic') RETURNING id`,
      [omar.workspaceId],
    );
    providerId = inserted.rows[0]!.id;
    await tx.query(
      `INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'smart', $2, 'claude-sonnet-4', '{}')`,
      [omar.workspaceId, providerId],
    );
    await tx.query(
      `INSERT INTO app.llm_keys (bot_id, workspace_id, key_prefix) VALUES (gen_random_uuid(), $1, 'sk-test1234')`,
      [omar.workspaceId],
    );
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the LLM tables follow the RLS rules', () => {
  it('explains no violation and hoists its read policies', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['llm_providers', 'llm_aliases', 'llm_keys']) {
        expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });

  it('a workspace admin reads and writes both config tables', async () => {
    expect(await count(omar, 'llm_providers')).toBe(1);
    expect(await count(omar, 'llm_aliases')).toBe(1);
    await as(omar, async (tx) => {
      await tx.query(`INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Ollama', 'ollama')`, [omar.workspaceId]);
      await tx.query(
        `INSERT INTO app.llm_aliases (workspace_id, alias, model) VALUES ($1, 'local', 'llama3.3')`,
        [omar.workspaceId],
      );
    });
    expect(await count(omar, 'llm_providers')).toBe(2);
  });

  it('a member and a guest see nothing, and a member cannot write', async () => {
    for (const person of [nadia, lena]) {
      expect(await count(person, 'llm_providers'), person.name).toBe(0);
      expect(await count(person, 'llm_aliases'), person.name).toBe(0);
      expect(await count(person, 'llm_keys'), person.name).toBe(0);
    }
    // An insert is refused outright (the WITH CHECK); a delete silently removes no row — both are "no effect", and the
    // row is still there afterwards.
    const refused = await code(
      as(nadia, (tx) => tx.query(`INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Nope', 'openai')`, [omar.workspaceId])),
    );
    expect(refused).toBe('42501');
    const before = await count(omar, 'llm_providers');
    await as(nadia, (tx) => tx.query(`DELETE FROM app.llm_providers WHERE id = $1`, [providerId]));
    expect(await count(omar, 'llm_providers')).toBe(before);
    await as(nadia, (tx) => tx.query(`UPDATE app.llm_aliases SET model = 'hijacked'`));
    const model = await as(omar, async (tx) =>
      (await tx.query<{ model: string }>(`SELECT model FROM app.llm_aliases WHERE alias = 'smart'`)).rows[0]?.model,
    );
    expect(model).toBe('claude-sonnet-4');
  });

  it('the system role writes keys, which no request role may change', async () => {
    await sys(async (tx) => {
      await tx.query(
        `INSERT INTO app.llm_keys (bot_id, workspace_id, key_prefix) VALUES (gen_random_uuid(), $1, 'sk-sys1234')`,
        [omar.workspaceId],
      );
    });
    expect(await count(omar, 'llm_keys')).toBe(2);
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.llm_keys WHERE key_prefix = 'sk-test1234'`)))).toBe('42501');
  });

  it("an alias cannot fall back to itself, and fallbacks are one of the eight", async () => {
    expect(await code(pathAlias(nadia))).toBe('42501');
    expect(await code(smartFallsBackToItself())).toBe('23514');
    expect(await code(unknownFallback())).toBe('23514');
  });
});

const smartFallsBackToItself = (): Promise<unknown> =>
  sys((tx) => tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, model, fallbacks) VALUES ($1, 'code', 'm', '{code}')`, [omar.workspaceId]));

const unknownFallback = (): Promise<unknown> =>
  sys((tx) => tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, model, fallbacks) VALUES ($1, 'code', 'm', '{nonsense}')`, [omar.workspaceId]));

const pathAlias = (p: Persona): Promise<unknown> =>
  as(p, (tx) => tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, model) VALUES ($1, 'vision', 'm')`, [omar.workspaceId]));

// P5-07: budgets, rate limits, the guard settings and the append-only spend ledger. The limits and the settings are
// workspace-admin rows like the provider config; the ledger is written by the system role only and no role may change a
// line of it.

describe('the limits, settings and spend tables follow the RLS rules', () => {
  it('explains no violation and hoists the read policies', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['llm_limits', 'llm_settings', 'llm_spend']) {
        expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });

  it('a workspace admin sets the budget and the guard preset, and reads them back', async () => {
    await as(omar, async (tx) => {
      await tx.query(
        `INSERT INTO app.llm_limits (workspace_id, scope, limit_usd, requests_per_minute) VALUES ($1, 'workspace', 25, 120)`,
        [omar.workspaceId],
      );
      await tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'strict-egress')`, [omar.workspaceId]);
    });
    expect(await count(omar, 'llm_limits')).toBe(1);
    const preset = await as(omar, async (tx) =>
      (await tx.query<{ preset: string }>('SELECT preset FROM app.llm_settings')).rows[0]?.preset,
    );
    expect(preset).toBe('strict-egress');
  });

  it('a member and a guest see no limit and no spend, and cannot write either', async () => {
    await sys(async (tx) => {
      await tx.query(
        `INSERT INTO app.llm_spend (workspace_id, bot_id, alias, cost_usd, prompt_tokens, completion_tokens)
         VALUES ($1, gen_random_uuid(), 'smart', 0.25, 100, 50)`,
        [omar.workspaceId],
      );
    });
    for (const person of [nadia, lena]) {
      expect(await count(person, 'llm_limits'), person.name).toBe(0);
      expect(await count(person, 'llm_spend'), person.name).toBe(0);
      expect(await count(person, 'llm_settings'), person.name).toBe(0);
      expect(
        await code(
          as(person, (tx) =>
            tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]),
          ),
        ),
      ).toBe('42501');
    }
    // The admin sees the ledger line the system role wrote.
    expect(await count(omar, 'llm_spend')).toBe(1);
  });

  it('the spend ledger is append-only: no request role may change a line', async () => {
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.llm_spend SET cost_usd = 0`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.llm_spend`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 1)`, [omar.workspaceId])))).toBe(
      '42501',
    );
  });

  it('a limit must name its target, and must cap something', async () => {
    // team scope without a team id, and bot scope without a bot id
    expect(
      await code(sys((tx) => tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'team', 1)`, [omar.workspaceId]))),
    ).toBe('23514');
    expect(
      await code(
        sys((tx) =>
          tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'workspace', gen_random_uuid(), 1)`, [
            omar.workspaceId,
          ]),
        ),
      ),
    ).toBe('23514');
    // a row that caps nothing at all
    expect(
      await code(sys((tx) => tx.query(`INSERT INTO app.llm_limits (workspace_id, scope) VALUES ($1, 'workspace')`, [omar.workspaceId]))),
    ).toBe('23514');
  });

  it('a team limit that names a team of no workspace is refused by the same-workspace guard', async () => {
    expect(
      await code(
        sys((tx) =>
          tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, team_id, limit_usd) VALUES ($1, 'team', gen_random_uuid(), 1)`, [
            omar.workspaceId,
          ]),
        ),
      ),
    ).toBe('23514');
  });

  it('the guard preset is one of the four, and the settings row is one per workspace', async () => {
    expect(
      await code(sys((tx) => tx.query(`UPDATE app.llm_settings SET preset = 'loose'`))),
    ).toBe('23514');
    expect(
      await code(
        sys((tx) =>
          tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'air-gapped')`, [omar.workspaceId]),
        ),
      ),
      // one row per workspace: the primary key refuses a second
    ).toBe('23505');
  });
});
