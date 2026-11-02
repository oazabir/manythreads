import type { PluginContext, PluginTx } from '@manythreads/sdk';

// Meaning-based search needs an embedding model (PLAN P8-07; docs/plans/support-email-journey.md D5: lexical first, embeddings never required).
// The model gateway's `embed` alias exists in its configuration, but the gateway offers plugins no way to call it yet. This file is the door the
// knowledge plugin will use the day it does: the LLM provider (`ctx.providers.get('llm')`) may carry an `embed` method with the shape below, and
// everything here (the backfill job, the query side of the search, the `hybrid` search mode) switches on by itself when it is there. Without it
// nothing is embedded, the `embedding` column stays empty and search is by words, which is how every workspace works today.

/** Passages are embedded in the 768 dimensions of `knowledge_chunks.embedding`. */
export const EMBEDDING_DIMENSIONS = 768;

export interface EmbedRequest {
  workspaceId: string;
  /** What to embed, at most 64 texts of at most 2,000 characters. */
  texts: string[];
  /** `passage` for what is stored, `query` for the question being asked (some models embed the two differently). */
  purpose: 'passage' | 'query';
}

export type EmbedResult =
  | { ok: true; vectors: number[][] }
  /** `unbound`: the workspace has no `embed` alias; `refused`: the guard, a budget or a limit said no; `unavailable`: the model did not answer. */
  | { ok: false; reason: 'unbound' | 'refused' | 'unavailable'; detail: string };

export type Embedder = (tx: PluginTx, request: EmbedRequest) => Promise<EmbedResult>;

/** The embedding door, when the model gateway has one. */
export function embedderOf(ctx: PluginContext): Embedder | null {
  const llm = ctx.providers.get('llm');
  const embed = llm?.['embed'];
  if (typeof embed !== 'function') return null;
  return (tx, request) => (embed as (this: unknown, tx: PluginTx, request: EmbedRequest) => Promise<EmbedResult>).call(llm, tx, request);
}

/** A vector as the text pgvector reads. Refuses anything that is not exactly the right number of finite numbers. */
export function vectorLiteral(vector: readonly number[]): string | null {
  if (vector.length !== EMBEDDING_DIMENSIONS) return null;
  for (const n of vector) if (!Number.isFinite(n)) return null;
  return `[${vector.join(',')}]`;
}

const BATCH = 32;

/**
 * Embeds up to `limit` passages that have no vector yet (only the current version of an indexed document; older versions are only reached by a
 * citation). One call serves one workspace, so a workspace's texts never share a call with another's. Returns how many it filled. A refusal or an
 * unavailable model stops the pass without an error: the passages stay empty and the next pass tries again.
 */
export async function backfillEmbeddings(ctx: PluginContext, tx: PluginTx, workspaceId: string, limit = 128): Promise<{ filled: number; stoppedBecause: string | null }> {
  const embed = embedderOf(ctx);
  if (!embed) return { filled: 0, stoppedBecause: 'no embedding model' };
  const rows = (
    await tx.query<{ id: string; text: string; workspace_id: string }>(
      `SELECT c.id, c.text, b.workspace_id
         FROM app.knowledge_chunks c
         JOIN app.knowledge_documents d ON d.id = c.document_id AND d.status = 'indexed' AND c.version = d.version
         JOIN app.knowledge_bases b ON b.id = c.base_id
        WHERE c.embedding IS NULL AND b.workspace_id = $2
        ORDER BY c.id
        LIMIT $1`,
      [limit, workspaceId],
    )
  ).rows;
  let filled = 0;
  const byWorkspace = new Map<string, typeof rows>();
  for (const row of rows) byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row]);
  for (const [workspaceId, all] of byWorkspace) {
    for (let i = 0; i < all.length; i += BATCH) {
      const group = all.slice(i, i + BATCH);
      const result = await embed(tx, { workspaceId, texts: group.map((g) => g.text), purpose: 'passage' });
      if (!result.ok) return { filled, stoppedBecause: result.reason };
      if (result.vectors.length !== group.length) return { filled, stoppedBecause: 'the model answered with the wrong number of vectors' };
      for (const [n, row] of group.entries()) {
        const literal = vectorLiteral(result.vectors[n] ?? []);
        if (literal === null) return { filled, stoppedBecause: `the model's vectors are not ${String(EMBEDDING_DIMENSIONS)} numbers long` };
        await tx.query('UPDATE app.knowledge_chunks SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL', [row.id, literal]);
        filled += 1;
      }
    }
  }
  return { filled, stoppedBecause: null };
}
