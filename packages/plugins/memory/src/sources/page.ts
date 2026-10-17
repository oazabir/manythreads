import type { PluginTx } from '@manythreads/sdk';
import { isUuid, metadataOf, renderPage } from '../render.ts';
import { authoredVerdict, forget, iso, type Provenance, type Resolution } from './common.ts';

// Page ----------------------------------------------------------------------------------------------------------------------

/** A page's source id: the team and the path (a path alone is not unique across teams). */
export const pageSourceId = (teamId: string, path: string): string => `${teamId}/${path}`;

interface PageRow extends Record<string, unknown> {
  team_id: string;
  workspace_id: string;
  team_slug: string;
  path: string;
  text_plain: string | null;
  committed_at: Date;
  indexed_at: Date;
  author_id: string | null;
  author_kind: string | null;
  author_name: string | null;
}

export async function resolvePage(tx: PluginTx, sourceId: string): Promise<Resolution> {
  const slash = sourceId.indexOf('/');
  const teamId = slash < 0 ? '' : sourceId.slice(0, slash);
  const path = slash < 0 ? '' : sourceId.slice(slash + 1);
  if (!isUuid(teamId) || !path.startsWith('pages/')) return forget('gone');
  const p = (
    await tx.query<PageRow>(
      `SELECT e.team_id, t.workspace_id, t.slug AS team_slug, e.path, e.text_plain, c.committed_at, coalesce(c.indexed_at, c.committed_at) AS indexed_at, c.author_id,
              a.kind AS author_kind,
              CASE a.kind
                WHEN 'person' THEN (SELECT pe.display_name FROM app.people pe WHERE pe.id = a.ref_id)
                WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
              END AS author_name
         FROM app.repo_entries e
         JOIN app.teams t ON t.id = e.team_id
         JOIN app.repo_commits c ON c.team_id = e.team_id AND c.sha = e.last_commit_sha
         LEFT JOIN app.actors a ON a.id = c.author_id
        WHERE e.team_id = $1::uuid AND e.path = $2`,
      [teamId, path],
    )
  ).rows[0];
  if (!p) return forget('deleted');
  if (p.text_plain === null || p.text_plain.trim() === '') return forget('no_text');
  const at: Provenance = {
    teamId: p.team_id,
    workspaceId: p.workspace_id,
    channelId: null,
    runId: null,
    actorId: p.author_id,
    scopes: [],
    link: `/t/${p.team_slug}/files?open=${encodeURIComponent(p.path)}`,
  };
  // A page a bot wrote during a run is judged by that run, like a message it posted.
  if (p.author_kind === 'bot' && p.author_id !== null) {
    // Two instants: the git author date (to the second, from whichever clock made the commit) and when the index recorded it (the database's
    // clock, the one the runs' times are on). A commit the index caught up with later has an `indexed_at` long after the run; its author date
    // is the one that matches then. Either instant inside a run that read something narrower is enough to refuse.
    const instants = [p.committed_at];
    if (Math.abs(p.indexed_at.getTime() - p.committed_at.getTime()) > 2_000) instants.push(p.indexed_at);
    let open = false;
    let refusal: string | null = null;
    for (const when of instants) {
      const v = await authoredVerdict(tx, p.author_id, when);
      open ||= v.run_open;
      refusal ??= v.retain_refusal;
    }
    if (open) return { action: 'defer', at, reason: 'run_open' };
    if (refusal !== null) return { action: 'withhold', at, reason: `authoring run: ${refusal}` };
  }
  const text = renderPage({ path: p.path, text: p.text_plain, authorName: p.author_name, at: iso(p.committed_at) });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(p.committed_at),
      tags: ['feed', 'kind:page'],
      metadata: metadataOf({ feed_kind: 'page', feed_id: p.path, actor: p.author_id, actor_name: p.author_name, occurred_at: iso(p.committed_at), link: at.link, path: p.path }),
    },
  };
}
