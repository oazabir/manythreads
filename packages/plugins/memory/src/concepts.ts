import type { PluginTx } from '@manythreads/sdk';
import {
  GitSha,
  MemoryConceptSummary,
  TeamId,
  conceptTitle,
  isConceptPath,
  parseConcept,
  trustTier,
  type OkfFrontmatter,
} from '@manythreads/shared';

// The frontmatter index of a team's OKF bundle (`memory_concepts`, PLAN A.5 / P5-25; SPEC §12.1). git is the truth: the table is rebuilt from
// `repo.committed`, in the same consumer transaction that also queues the git mirror, and is never written by a request. Only the frontmatter is
// kept — never the body — because every reader (the Memory screen, recall's filters, phase 8's share selection) lists and filters concepts and
// reads the bodies from git. docs/plugins/memory.md.

/** An ISO instant for a frontmatter date, or null when it is absent or unreadable (a bare `YYYY-MM-DD` becomes midnight UTC). */
function instant(value: string | undefined): string | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The team a received digest came from (the extension key `from`), when it names one; a value that is not a uuid is ignored. */
function fromTeamOf(frontmatter: OkfFrontmatter): string | null {
  const from = frontmatter['from'];
  if (typeof from !== 'string') return null;
  const parsed = TeamId.safeParse(from);
  return parsed.success ? parsed.data : null;
}

/**
 * One validated concept as a `memory_concepts` row (PLAN A.5): the shared `MemoryConceptSummary` shape, so the entity, the table and the fill
 * share one vocabulary. Derived here, never stored in git: the trust tier (from `verified`), the display title (from `title` or the filename),
 * the `share: never` flag and the two instants (`stale_after`, `generated.at`).
 */
export function toMemoryConceptSummary(path: string, frontmatter: OkfFrontmatter, blobSha: string): MemoryConceptSummary {
  return MemoryConceptSummary.parse({
    path,
    type: frontmatter.type,
    title: conceptTitle(path, frontmatter),
    description: frontmatter.description ?? null,
    tags: frontmatter.tags ?? [],
    status: frontmatter.status ?? 'stable',
    staleAfter: instant(frontmatter.stale_after),
    trustTier: trustTier(frontmatter),
    origin: frontmatter.origin ?? '',
    shareNever: frontmatter.share === 'never',
    fromTeam: fromTeamOf(frontmatter),
    blobSha: GitSha.parse(blobSha),
    generatedAt: instant(frontmatter.generated?.at),
  });
}

/**
 * Rebuilds the rows of the concepts a commit touched (PLAN P5-25), from the index of the team's tree as it is NOW (`app.repo_entries`): a put of a
 * valid concept upserts its row, and a delete, a concept that is gone, is no longer text, or that `parseConcept` refuses now takes its row out
 * (git keeps whatever history there was; the table holds no row for a concept the writer would refuse). Set-based: one read and one write for a
 * commit, however many paths it names. `paths` is the event's list, so a put that the fill cannot read is treated as a delete, never left stale.
 */
export async function syncConcepts(tx: PluginTx, teamId: string, paths: readonly { path: string; op: 'put' | 'delete' }[]): Promise<void> {
  const conceptPaths = [...new Set(paths.filter((p) => isConceptPath(p.path)).map((p) => p.path))];
  if (conceptPaths.length === 0) return;
  const deleted = new Set(paths.filter((p) => p.op === 'delete' && isConceptPath(p.path)).map((p) => p.path));

  const rows = (
    await tx.query<{ path: string; blob_sha: string; text_plain: string | null }>(
      'SELECT path, blob_sha, text_plain FROM app.repo_entries WHERE team_id = $1::uuid AND path = ANY($2::text[])',
      [teamId, conceptPaths],
    )
  ).rows;
  const byPath = new Map(rows.map((r) => [r.path, r]));

  const gone: string[] = [];
  const records: Record<string, unknown>[] = [];
  for (const path of conceptPaths) {
    const row = byPath.get(path);
    if (deleted.has(path) || row === undefined || row.text_plain === null) {
      gone.push(path);
      continue;
    }
    const parsed = parseConcept(row.text_plain);
    if (!parsed.ok) {
      gone.push(path);
      continue;
    }
    const s = toMemoryConceptSummary(path, parsed.frontmatter, row.blob_sha);
    records.push({
      path: s.path,
      type: s.type,
      title: s.title,
      description: s.description,
      tags: s.tags,
      status: s.status,
      stale_after: s.staleAfter,
      trust_tier: s.trustTier,
      origin: s.origin,
      share_never: s.shareNever,
      from_team: s.fromTeam,
      blob_sha: s.blobSha,
      generated_at: s.generatedAt,
    });
  }

  if (gone.length > 0) await tx.query('DELETE FROM app.memory_concepts WHERE team_id = $1::uuid AND path = ANY($2::text[])', [teamId, gone]);
  if (records.length === 0) return;
  await tx.query(
    `INSERT INTO app.memory_concepts
       (team_id, path, type, title, description, tags, status, stale_after, trust_tier, origin, share_never, from_team, blob_sha, generated_at)
     SELECT $1::uuid, r.path, r.type, r.title, r.description, r.tags, r.status, r.stale_after, r.trust_tier, r.origin, r.share_never, r.from_team, r.blob_sha, r.generated_at
       FROM jsonb_to_recordset($2::jsonb) AS r(
         path text, type text, title text, description text, tags text[], status text, stale_after timestamptz,
         trust_tier text, origin text, share_never boolean, from_team uuid, blob_sha text, generated_at timestamptz)
     ON CONFLICT (team_id, path) DO UPDATE SET
       type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description, tags = EXCLUDED.tags,
       status = EXCLUDED.status, stale_after = EXCLUDED.stale_after, trust_tier = EXCLUDED.trust_tier,
       origin = EXCLUDED.origin, share_never = EXCLUDED.share_never, from_team = EXCLUDED.from_team,
       blob_sha = EXCLUDED.blob_sha, generated_at = EXCLUDED.generated_at`,
    [teamId, JSON.stringify(records)],
  );
}
