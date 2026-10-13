import { compileGate, matchGate, parseBotMd } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scan } from '../../plugins/guardrails-dlp/src/dlp.ts';
import { createTestDatabase, dropTestDatabase, ownerSql, SEED_GUARD, seedGateBotMd, seedWorld, startTestServer, KAHF_WORKSPACE_ID, type TestServer } from '../src/index.ts';

// Seed v5 (PLAN P5-21): the guard state of the workspace, and the strings a spec feeds the guardrails.

let server: TestServer;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);

beforeAll(async () => {
  server = await startTestServer();
}, 120_000);
afterAll(async () => {
  if (server) await server.close();
});

describe('seedWorld with guard (seed v5)', () => {
  it('writes the standard preset and binds the local alias to a provider on this machine; a second run writes nothing', async () => {
    const first = await seedWorld(server.db, { guard: true });
    expect(first.guard).toMatchObject({ skipped: null, written: 2 });
    expect(await sql(`SELECT preset, egress_allowlist, caching FROM app.llm_settings WHERE workspace_id = $1`, [KAHF_WORKSPACE_ID])).toEqual([
      { preset: 'standard', egress_allowlist: [], caching: true },
    ]);
    expect(
      await sql(
        `SELECT a.alias, a.model, p.name, p.kind, p.api_base FROM app.llm_aliases a JOIN app.llm_providers p ON p.id = a.provider_id WHERE a.workspace_id = $1`,
        [KAHF_WORKSPACE_ID],
      ),
    ).toEqual([{ alias: 'local', model: SEED_GUARD.localModel, name: SEED_GUARD.provider.name, kind: 'ollama', api_base: SEED_GUARD.provider.apiBase }]);

    const again = await seedWorld(server.db, { guard: true });
    expect(again.guard).toMatchObject({ skipped: null, written: 0 });
    expect(await sql(`SELECT count(*)::int AS n FROM app.llm_providers`)).toEqual([{ n: 1 }]);
  });

  it('never replaces what an admin configured: their preset and their own binding of local stay', async () => {
    await sql(`UPDATE app.llm_settings SET preset = 'air-gapped', egress_allowlist = ARRAY['api.example.org'] WHERE workspace_id = $1`, [KAHF_WORKSPACE_ID]);
    await sql(`UPDATE app.llm_aliases SET model = 'ollama/their-own' WHERE workspace_id = $1 AND alias = 'local'`, [KAHF_WORKSPACE_ID]);
    const result = await seedWorld(server.db, { guard: true });
    expect(result.guard).toMatchObject({ written: 0 });
    expect(await sql(`SELECT preset, egress_allowlist FROM app.llm_settings`)).toEqual([{ preset: 'air-gapped', egress_allowlist: ['api.example.org'] }]);
    expect(await sql(`SELECT model FROM app.llm_aliases WHERE alias = 'local'`)).toEqual([{ model: 'ollama/their-own' }]);
  });

  it('says why it wrote nothing when the gateway tables are not there yet', async () => {
    const bare = await createTestDatabase(); // the kernel's migrations only: no plugin tables
    try {
      const result = await seedWorld(bare, { guard: true });
      expect(result.guard?.skipped).toMatch(/gateway-llm tables/);
    } finally {
      await dropTestDatabase(bare);
    }
    // it makes and migrates a database of its own, like the file's `beforeAll` that starts a server: the same budget, not the 5 s default
  }, 120_000);
});

describe('the strings a spec feeds the guardrails', () => {
  it('trip the detectors they are named for, and the clean one trips none', () => {
    expect(scan(SEED_GUARD.samples.apiKey).map((f) => f.rule)).toEqual(['api-key']);
    expect(scan(SEED_GUARD.samples.card).map((f) => f.rule)).toEqual(['card-number']);
    expect(scan(SEED_GUARD.samples.bearer).map((f) => f.rule)).toEqual(['bearer-token']);
    expect(scan(SEED_GUARD.samples.clean)).toEqual([]);
  });

  it('the gate samples: the words are on the list, the paraphrase is for the classifier; the bot file parses with its gate', () => {
    const compiled = compileGate([...SEED_GUARD.gate]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(matchGate(compiled.gate, SEED_GUARD.samples.gateByWords)).toMatchObject({ entry: 'credential rotation', kind: 'exact' });
    expect(matchGate(compiled.gate, SEED_GUARD.samples.gateByMeaning)).toBeNull();
    expect(matchGate(compiled.gate, SEED_GUARD.samples.clean)).toBeNull();

    const parsed = parseBotMd(seedGateBotMd('Gatekeeper'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frontmatter.guard?.gate).toEqual([...SEED_GUARD.gate]);
      expect(parsed.frontmatter.approvals?.approvers).toEqual(['role:on-call']);
    }
  });
});
