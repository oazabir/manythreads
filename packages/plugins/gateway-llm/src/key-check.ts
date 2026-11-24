import type { PluginContext } from '@manythreads/sdk';
import { LLM_TESTABLE_ALIASES, type LlmAliasName } from '@manythreads/shared';
import { runAliasTest } from './alias-test.ts';
import { gatewayFromEnv } from './gateway.ts';

// The regular key check (owner request 2026-11-24: tell the admins when a model key has expired). Once an hour, for each provider in use, one of its text aliases is asked the
// same small question as the Test button, unless it was tested in the last 50 minutes; the result is stored like any test, so a key the provider refuses (`auth`) shows in the
// attention bar (ops-health) until the key or the alias is changed. One alias per provider: they share the key. The question waits on a model, so each runs in a detached job.

export const KEY_CHECK_QUEUE = 'gateway-llm.key-check';
export const KEY_CHECK_ONE_QUEUE = 'gateway-llm.key-check-one';

export function registerKeyCheckJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    KEY_CHECK_QUEUE,
    async (_payload, tx) => {
      if (!gatewayFromEnv().enabled) return;
      const due = await tx.query<{ workspace_id: string; alias: LlmAliasName }>(
        `SELECT DISTINCT ON (a.workspace_id, a.provider_id) a.workspace_id::text, a.alias
           FROM app.llm_aliases a
           JOIN app.llm_providers p ON p.id = a.provider_id
           LEFT JOIN app.llm_alias_tests t ON t.workspace_id = a.workspace_id AND t.alias = a.alias
          WHERE a.alias = ANY($1::text[]) AND greatest(a.updated_at, p.updated_at) < now() - interval '1 minute'
          ORDER BY a.workspace_id, a.provider_id, t.tested_at DESC NULLS LAST, a.alias`,
        [LLM_TESTABLE_ALIASES],
      );
      const recent = await tx.query<{ workspace_id: string; alias: string }>(
        `SELECT workspace_id::text, alias FROM app.llm_alias_tests WHERE tested_at > now() - interval '50 minutes'`,
      );
      const fresh = new Set(recent.rows.map((r) => `${r.workspace_id}:${r.alias}`));
      for (const d of due.rows) {
        if (fresh.has(`${d.workspace_id}:${d.alias}`)) continue;
        await ctx.jobs.enqueue(tx, KEY_CHECK_ONE_QUEUE, { workspaceId: d.workspace_id, alias: d.alias }, { dedupeKey: `${d.workspace_id}:${d.alias}` });
      }
    },
    { cron: '41 * * * *', maxAttempts: 1, concurrency: 1 },
  );
  ctx.jobs.register(
    KEY_CHECK_ONE_QUEUE,
    async (payload) => {
      const workspaceId = String(payload['workspaceId'] ?? '');
      const alias = String(payload['alias'] ?? '') as LlmAliasName;
      if (workspaceId === '' || !(LLM_TESTABLE_ALIASES as readonly string[]).includes(alias)) return;
      await runAliasTest(ctx, { workspaceId, alias, testedBy: null });
    },
    { detached: true, maxAttempts: 1, concurrency: 2 },
  );
}
