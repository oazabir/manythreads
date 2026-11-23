import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { LlmAliasName } from '@manythreads/shared';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, preflight, recordSpend, type RateHit } from './limits.ts';

/*
 * The embedding door (P35-06; the knowledge plugin's `embedderOf` looks for it): texts in, one vector each, through the workspace's `embed` alias on the
 * LiteLLM proxy. Same promises as the other doors: the pre-call check (the workspace's limits and guardrails see the texts before they leave), the master
 * key stays here, a spend line is written, and it never throws for a model that is not there or does not answer. An unbound alias is `unbound`, so search
 * stays by words, as before.
 */

const ALIAS: LlmAliasName = 'embed';
const TIMEOUT_MS = 30_000;
const MAX_TEXTS = 64;
const MAX_CHARS = 2_000;
const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

export interface EmbedRequest {
  workspaceId: string;
  texts: string[];
  purpose: 'passage' | 'query';
}
export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; reason: 'unbound' | 'refused' | 'unavailable'; detail: string };

export interface EmbedDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** BGE models are trained to read a search question with this instruction in front of it (passages go as they are). */
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';

/*
 * The caller's transaction is never used: the aliases are for workspace admins and the spend ledger is the gateway's, so a member's search (P18-09) could
 * read neither, and a refused statement would abort the caller's transaction for everything after it (a 500 on the live site, 2026-11-23). The check and
 * the spend line run in short system transactions of their own, and no transaction is open while the model works.
 */
export async function embedTexts(ctx: PluginContext, _tx: PluginTx, request: EmbedRequest, deps: EmbedDeps = {}): Promise<EmbedResult> {
  const env = deps.env ?? process.env;
  if (request.texts.length === 0) return { ok: true, vectors: [] };
  if (request.texts.length > MAX_TEXTS || request.texts.some((t) => typeof t !== 'string')) return { ok: false, reason: 'refused', detail: `at most ${MAX_TEXTS} texts` };
  type Checked = { ok: true; model: string | null; texts: string[] } | { ok: false; result: EmbedResult };
  let checked: Checked;
  try {
    checked = await ctx.db.system(
      async (sys): Promise<Checked> => {
        const target = await loadEgress(sys, request.workspaceId, ALIAS);
        if (target === null) return { ok: false, result: { ok: false, reason: 'unbound', detail: 'The embed model is not bound in the Models page.' } };
        const model = (await sys.query<{ model: string }>('SELECT model FROM app.llm_aliases WHERE workspace_id = $1 AND alias = $2', [request.workspaceId, ALIAS])).rows[0]?.model ?? null;
        const texts = request.texts.map((t) => t.slice(0, MAX_CHARS)).map((t) => (request.purpose === 'query' && /bge/i.test(model ?? '') ? `${BGE_QUERY}${t}` : t));
        // the guardrails see what would leave (a model outside this deployment is held to the workspace's egress rules like any other call)
        const decision = await preflight(ctx, sys, allowRate, { workspaceId: request.workspaceId, botId: null, teamId: null, sessionId: `embed:${request.purpose}`, alias: ALIAS, text: texts.join('\n').slice(0, 20_000) });
        if (!decision.allowed) return { ok: false, result: { ok: false, reason: 'refused', detail: decision.message ?? "The workspace's model limits or guardrails did not allow the call." } };
        return { ok: true, model, texts };
      },
      { workspaceId: request.workspaceId },
    );
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'The check before the embedding model could not be made.' };
  }
  if (!checked.ok) return checked.result;
  const { model, texts } = checked;

  const base = (env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'unavailable', detail: 'No LLM gateway URL is configured.' };
  const masterKey = (env['MANYTHREADS_LITELLM_MASTER_KEY'] ?? '').trim();
  let vectors: number[][];
  let tokens = 0;
  try {
    const res = await (deps.fetch ?? fetch)(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(masterKey ? { authorization: `Bearer ${masterKey}` } : {}) },
      body: JSON.stringify({ model: ALIAS, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) {
      const detail = `The embedding model did not answer (${res.status}): ${scrubProxyDetail(raw).slice(0, 200)}`;
      return { ok: false, reason: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'refused' : 'unavailable', detail };
    }
    const body = JSON.parse(raw) as { data?: Array<{ index?: number; embedding?: unknown }>; usage?: { prompt_tokens?: number } };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    vectors = data.map((d) => (Array.isArray(d.embedding) ? (d.embedding as unknown[]).map(Number) : []));
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0 || v.some((n) => !Number.isFinite(n)))) {
      return { ok: false, reason: 'unavailable', detail: 'The embedding model answered with the wrong number of vectors.' };
    }
    tokens = typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : 0;
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: 'unavailable', detail: aborted ? 'The embedding model took too long to answer.' : 'The embedding model did not answer.' };
  }
  // the spend line (cost 0 for a model inside this deployment; the gateway's own price is not known here for another one, so 0 as well, with the tokens)
  try {
    await ctx.db.system((sys) => recordSpend(sys, { workspaceId: request.workspaceId, teamId: null, botId: null, sessionId: `embed:${request.purpose}`, runId: null, alias: ALIAS, model, promptTokens: tokens, completionTokens: 0, costUsd: 0, purpose: 'embed' }), { workspaceId: request.workspaceId });
  } catch {
    // the vectors are what the caller needs; the line is a record
  }
  return { ok: true, vectors };
}
