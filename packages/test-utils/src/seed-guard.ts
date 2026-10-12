import { createSystemPool, withSystem } from '@manythreads/kernel';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID } from './personas.ts';

/**
 * What seed v5 puts in the world, and the strings a spec feeds it (PLAN P5-21). Plain data: a test, an e2e spec or a screenshot script names a
 * thing here instead of inventing its own secret. Every secret-shaped string is made up (repeated filler, the card is the published test number).
 */
export const SEED_GUARD = {
  /** The model provider the `local` alias is bound to: a model on this machine, which is what the gate's classifier (P5-11) calls. */
  provider: { name: 'Local (Ollama)', kind: 'ollama', apiBase: 'http://localhost:11434' },
  localModel: 'ollama/llama3.2',
  /** The guard preset of the workspace and its egress allowlist: `standard`, nothing allowlisted (the defaults a fresh workspace has, written down). */
  preset: 'standard',
  /** The example gate list of the spec (SPEC §7.1 `guard.gate`). */
  gate: ['credential rotation', 'licence change', 'delete production data'],
  samples: {
    /** Trips guardrails-dlp's `api-key`. */
    apiKey: `sk-proj-${'SeedFiller7'.repeat(8)}`,
    /** Trips `card-number`: the card networks' published test number. */
    card: '4111 1111 1111 1111',
    /** Trips `bearer-token`. */
    bearer: `Bearer ${'seedfiller.'.repeat(4)}token`,
    /** On the gate list by its words (stage one: exact). */
    gateByWords: 'Please start the credential rotation for the build servers today.',
    /** On a gate topic without using its words (stage two: the classifier). */
    gateByMeaning: 'Could we roll the keys on the deploy account this week?',
    /** Nothing a guard would object to. */
    clean: 'What changed in the deploy yesterday?',
  },
} as const;

/** A BOT.md whose gate list is the example one, for a spec that wants a bot the gate applies to. */
export function seedGateBotMd(name: string, approvers: readonly string[] = ['role:on-call']): string {
  return [
    '---',
    'schema: 1',
    `name: ${name}`,
    'role: Answers mentions, with a gate in front of the model',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    '  native: [messages.post]',
    'guard:',
    `  gate: [${SEED_GUARD.gate.map((g) => `'${g}'`).join(', ')}]`,
    'approvals:',
    `  approvers: [${approvers.map((a) => `"${a}"`).join(', ')}]`,
    '---',
    '',
    `# ${name}`,
    '',
    'Answers when mentioned.',
    '',
  ].join('\n');
}

export interface SeedGuardResult {
  /** Why nothing was written (the gateway-llm tables are not there yet), or null. */
  skipped: string | null;
  /** Rows this run wrote (a second run writes none). */
  written: number;
}

/**
 * Seed v5 (PLAN P5-21): the guard state a workspace has before anybody opens Workspace → LLM — the `standard` preset with an empty allowlist
 * and the `local` alias bound to a provider on this machine, which is what lets the gate's classifier and the air-gapped preset work in a
 * seeded world. Written only where nothing is: an admin's own preset, provider or `local` binding is never replaced, so seeding twice (or
 * after somebody configured the workspace) changes nothing. The bots' gate lists are not seeded: a bot is a file in a team repo, and
 * `seedGateBotMd` is what a spec commits when it wants one.
 */
export async function seedGuard(db: Pick<TestDatabase, 'systemUrl'>, options: { log?: (line: string) => void } = {}): Promise<SeedGuardResult> {
  const log = options.log ?? (() => undefined);
  const pool = createSystemPool(db.systemUrl, 2);
  try {
    return await withSystem(
      async (tx) => {
        const ready = (
          await tx.query<{ ok: boolean }>(
            `SELECT to_regclass('app.llm_providers') IS NOT NULL AND to_regclass('app.llm_aliases') IS NOT NULL AND to_regclass('app.llm_settings') IS NOT NULL AS ok`,
          )
        ).rows[0]?.ok;
        if (!ready) {
          const reason = 'the gateway-llm tables are not there yet (start the server once so its plugin migrations run)';
          log(`guard: skipped (${reason})`);
          return { skipped: reason, written: 0 };
        }
        let written = 0;
        written += (
          await tx.query(
            `INSERT INTO app.llm_settings (workspace_id, preset, egress_allowlist) VALUES ($1, $2, '{}') ON CONFLICT (workspace_id) DO NOTHING`,
            [KAHF_WORKSPACE_ID, SEED_GUARD.preset],
          )
        ).rowCount ?? 0;
        const bound = (await tx.query(`SELECT 1 FROM app.llm_aliases WHERE workspace_id = $1 AND alias = 'local'`, [KAHF_WORKSPACE_ID])).rows.length > 0;
        if (!bound) {
          const provider = (
            await tx.query<{ id: string }>(
              `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = app.llm_providers.name RETURNING id`,
              [KAHF_WORKSPACE_ID, SEED_GUARD.provider.name, SEED_GUARD.provider.kind, SEED_GUARD.provider.apiBase],
            )
          ).rows[0];
          if (provider) {
            written += (
              await tx.query(
                `INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model) VALUES ($1, 'local', $2, $3) ON CONFLICT (workspace_id, alias) DO NOTHING`,
                [KAHF_WORKSPACE_ID, provider.id, SEED_GUARD.localModel],
              )
            ).rowCount ?? 0;
          }
        }
        log(`guard: preset ${SEED_GUARD.preset}, the local alias bound to ${SEED_GUARD.provider.name} (${written} row${written === 1 ? '' : 's'} written)`);
        return { skipped: null, written };
      },
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
}
