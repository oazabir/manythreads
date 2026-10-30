import { HttpError, type PluginContext } from '@manythreads/sdk';
import {
  LLM_TESTABLE_ALIASES,
  ListLlmAliasTestsResponse,
  LlmAliasName,
  LlmAliasPathParams,
  LlmAliasTest,
  TestLlmAliasResponse,
  listLlmAliasTestsRoute,
  testLlmAliasRoute,
} from '@manythreads/shared';
import { isTestableAlias, runAliasTest } from './alias-test.ts';
import { json, notFound, requireWorkspaceAdmin, route } from './http.ts';

// Workspace → LLM → test call per alias (PLAN P10-01 step 2): ask a model alias one small question and keep the plain-language result. See
// `alias-test.ts` for the call and `docs/plugins/gateway-llm.md` for what the result means.

type TestRow = {
  alias: string;
  outcome: string;
  cause: string | null;
  message: string;
  model: string | null;
  latency_ms: number;
  tested_at: Date;
  tested_by: string | null;
  current: boolean;
};

const TEST_COLUMNS = `t.alias, t.outcome, t.cause, t.message, t.model, t.latency_ms, t.tested_at, t.tested_by,
  (a.alias IS NOT NULL AND t.tested_at >= a.updated_at AND (p.id IS NULL OR t.tested_at >= p.updated_at)) AS current`;

const toTest = (r: TestRow): LlmAliasTest =>
  LlmAliasTest.parse({
    alias: r.alias,
    outcome: r.outcome,
    cause: r.cause,
    message: r.message,
    model: r.model,
    latencyMs: r.latency_ms,
    testedAt: r.tested_at.toISOString(),
    testedBy: r.tested_by,
    current: r.current,
  });

/**
 * A save is pushed to the model proxy by a background job a moment later. A test in that moment would reach the proxy's OLD settings (the old key, the
 * old model) and could pass or fail for a setup that is no longer the saved one, then read as current. So an alias or provider saved in the last
 * few seconds is not tested yet.
 */
export const SETTLE_SECONDS = 10;

export function registerAliasTestRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listLlmAliasTestsRoute.method,
    path: listLlmAliasTestsRoute.path,
    schema: { response: ListLlmAliasTestsResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const res = await tx.query<TestRow>(
        `SELECT ${TEST_COLUMNS}
           FROM app.llm_alias_tests t
           LEFT JOIN app.llm_aliases a ON a.workspace_id = t.workspace_id AND a.alias = t.alias
           LEFT JOIN app.llm_providers p ON p.id = a.provider_id
          ORDER BY t.alias`,
      );
      const untestable = LlmAliasName.options.filter((alias) => !(LLM_TESTABLE_ALIASES as readonly string[]).includes(alias));
      return json({ tests: res.rows.map(toTest), untestable });
    }),
  });

  ctx.http.route({
    method: testLlmAliasRoute.method,
    path: testLlmAliasRoute.path,
    schema: { response: TestLlmAliasResponse },
    // A test is a real model call: a click that repeats it many times a minute is a loop or a mistake.
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { alias } = LlmAliasPathParams.parse(req.params);
      if (!isTestableAlias(alias)) {
        throw new HttpError(409, 'conflict', `The ${alias} alias is not a chat model, so a text question cannot test it.`);
      }
      const bound = await tx.query<{ recent: boolean }>(
        `SELECT greatest(a.updated_at, p.updated_at) > now() - make_interval(secs => $2) AS recent
           FROM app.llm_aliases a LEFT JOIN app.llm_providers p ON p.id = a.provider_id
          WHERE a.alias = $1`,
        [alias, SETTLE_SECONDS],
      );
      if (bound.rows.length === 0) throw notFound(`The ${alias} alias is not bound to a model yet.`);
      if (bound.rows[0]?.recent === true) {
        throw new HttpError(409, 'conflict', `The ${alias} alias or its provider was saved a moment ago and the model proxy is still taking it in. Wait about ${SETTLE_SECONDS} seconds and test again.`);
      }
      const timeoutMs = Number(process.env['MANYTHREADS_LLM_TEST_TIMEOUT_MS'] ?? '') || undefined;
      const test = await runAliasTest(ctx, {
        workspaceId: tx.actor.workspaceId,
        alias,
        testedBy: tx.actor.id,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return json({ test });
    }),
  });
}
