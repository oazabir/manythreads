import type { PluginTx } from '@manythreads/sdk';
import { KnowledgeHit } from '@manythreads/shared';

// Finding passages (PLAN P8-08). Word matching on the word index (`tsv`), ranked by how many of the question's words a passage holds and by the
// index's own rank; when no passage holds any of them, a spelling-tolerant pass over the trigram index. Semantic (embedding) search is not here: the
// `embedding` column stays empty until a workspace has an embedding model, and nothing in this file needs it. Only the current version of an indexed
// document is searched; an older passage is reachable by id (`getChunk`) and says the source has changed since.

const STOP = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have how i if in is it its me my of on or our so than that the their them ' +
    'then there these they this to us was we were what when where which who why will with would you your about tell please'
  ).split(' '),
);

/** The words of a question worth looking for: lower case, no filler, trailing plural / -ing / -ed cut, so "refunds" finds "refund". */
export function queryTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    let t = w;
    if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3);
    else if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    if (t.length >= 2 && !out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

type HitRow = {
  id: string;
  version: number;
  section: string | null;
  char_start: number;
  char_end: number;
  text: string;
  document_id: string;
  document_name: string;
  document_kind: string;
  current_version: number;
  repo_path: string | null;
  base_slug: string;
  rank: number;
}

const HIT_FROM = `
  FROM app.knowledge_chunks c
  JOIN app.knowledge_documents d ON d.id = c.document_id
  JOIN app.knowledge_bases b ON b.id = c.base_id`;
const HIT_COLUMNS = `c.id, c.version, c.section, c.char_start, c.char_end, c.text, d.id AS document_id, d.name AS document_name, d.kind AS document_kind,
  d.version AS current_version, d.repo_path, b.slug AS base_slug`;

function toHit(row: HitRow, score: number): KnowledgeHit {
  return KnowledgeHit.parse({
    chunkId: row.id,
    baseSlug: row.base_slug,
    documentId: row.document_id,
    documentName: row.document_name,
    documentKind: row.document_kind,
    version: row.version,
    currentVersion: row.current_version,
    sourceChanged: row.version < row.current_version,
    section: row.section,
    offsetStart: row.char_start,
    offsetEnd: row.char_end,
    text: row.text,
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    repoPath: row.repo_path,
  });
}

export interface SearchOptions {
  teamId: string;
  /** Only these bases (by slug); null for every base of the team. */
  baseSlugs: readonly string[] | null;
  query: string;
  limit: number;
}

/** Passages that answer `query`, best first, each with where it came from. Row-level security decides which team's passages the caller sees at all. */
export async function searchKnowledge(tx: PluginTx, options: SearchOptions): Promise<KnowledgeHit[]> {
  const terms = queryTerms(options.query);
  const slugs = options.baseSlugs === null ? null : [...options.baseSlugs];
  if (slugs !== null && slugs.length === 0) return [];

  if (terms.length > 0) {
    const tsquery = terms.map((t) => `${t}:*`).join(' | ');
    const res = await tx.query<HitRow>(
      `SELECT ${HIT_COLUMNS}, ts_rank_cd(c.tsv, q.tsq)::float8 AS rank ${HIT_FROM}
         CROSS JOIN (SELECT to_tsquery('simple', $1) AS tsq) q
        WHERE c.team_id = $2 AND d.status = 'indexed' AND c.version = d.version AND c.tsv @@ q.tsq
          AND ($3::text[] IS NULL OR b.slug = ANY ($3))
        ORDER BY rank DESC, c.id
        LIMIT $4`,
      [tsquery, options.teamId, slugs, Math.max(options.limit * 5, 20)],
    );
    const scored = res.rows
      .map((row) => {
        const words = new Set((row.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w));
        const wordList = [...words];
        const matched = terms.filter((t) => wordList.some((w) => w.startsWith(t))).length;
        const coverage = matched / terms.length;
        return { row, coverage, score: 0.7 * coverage + 0.3 * (row.rank / (row.rank + 1)) };
      })
      // a passage that holds only a stray word of a longer question is not an answer to it ("how long do refunds take" holds one of its three words
      // and is still the answer, so the line is a third, not a half)
      .filter((s) => s.coverage >= 0.3)
      .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
    if (scored.length > 0) return scored.slice(0, options.limit).map((s) => toHit(s.row, s.score));
  }

  // nothing holds the words: a tolerant pass for misspellings (a passage whose words are close to the question's)
  const query = options.query.trim().slice(0, 200);
  const tolerant = await tx.query<HitRow & { sim: number }>(
    `SELECT ${HIT_COLUMNS}, 0::float8 AS rank, word_similarity($1, c.text)::float8 AS sim ${HIT_FROM}
      WHERE c.team_id = $2 AND d.status = 'indexed' AND c.version = d.version AND $1 <% c.text
        AND ($3::text[] IS NULL OR b.slug = ANY ($3))
      ORDER BY sim DESC, c.id
      LIMIT $4`,
    [query, options.teamId, slugs, options.limit],
  );
  return tolerant.rows.map((row) => toHit(row, row.sim * 0.8));
}

/** One passage by id at the version it was made, readable under the caller's visibility; null when it is gone (its version was pruned) or hidden. */
export async function getChunk(tx: PluginTx, chunkId: string, teamId: string): Promise<KnowledgeHit | null> {
  const res = await tx.query<HitRow>(`SELECT ${HIT_COLUMNS}, 0::float8 AS rank ${HIT_FROM} WHERE c.id = $1 AND c.team_id = $2`, [chunkId, teamId]);
  const row = res.rows[0];
  return row ? toHit(row, 1) : null;
}
