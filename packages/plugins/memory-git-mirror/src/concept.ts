import type { PluginTx } from '@manythreads/sdk';
import { isConceptPath, parseConcept } from '@manythreads/shared';
import type { Resolution } from './decide.ts';
import { renderConcept } from './render.ts';

// What a concept is, read as it is NOW (system transaction; the index of the team repo, `repo_entries`, is the source — no git process). An event
// only says "this path changed"; `resolveConcept` answers what the bank should hold for it today:
//
//   retain   a valid concept (parseable frontmatter with a `type`), not deprecated, not written by a run that read something narrower
//   forget   the file is gone, is no longer text, or is `deprecated` (git keeps the history; the bank keeps nothing)
//   withhold it is there but cannot be put in the bank: not valid OKF (`okf_invalid: <reason>`), or a bot wrote it in a run that read something
//            narrower than the team (`authoring run: <refusal>`: the same rule as a page, `app.memory_authored_verdict`)
//   defer    the bot's run has not closed yet: its source log can still grow
//   skip     not a concept path (index.md, log.md, an attachment-like file)
//
// `memory/` is the team's own repo: team-visible by definition. The privacy rule that remains is the feed's: what a bot wrote without being asked
// to retain it must not out-reach the run that wrote it. (The writer path for bots, `memory.write`, is P5-26; until then a bot reaches `memory/`
// only through a `files.write` grant, and is judged here exactly as for a page.)

interface ConceptRow extends Record<string, unknown> {
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

interface AuthoredVerdict extends Record<string, unknown> {
  run_open: boolean;
  retain_refusal: string | null;
  runs: number;
}

async function authoredVerdict(tx: PluginTx, botActorId: string, at: Date): Promise<AuthoredVerdict> {
  const res = await tx.query<AuthoredVerdict>('SELECT run_open, retain_refusal, runs FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [botActorId, at.toISOString()]);
  return res.rows[0] ?? { run_open: false, retain_refusal: null, runs: 0 };
}

const skip = (reason: string): Resolution => ({ action: 'skip', reason });
const forget = (reason: string): Resolution => ({ action: 'forget', reason });

export async function resolveConcept(tx: PluginTx, teamId: string, path: string): Promise<Resolution> {
  if (!isConceptPath(path)) return skip('not_a_concept');
  const p = (
    await tx.query<ConceptRow>(
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

  const at = {
    teamId: p.team_id,
    workspaceId: p.workspace_id,
    actorId: p.author_id,
    link: `/t/${p.team_slug}/files?open=${encodeURIComponent(p.path)}`,
  };

  const parsed = parseConcept(p.text_plain);
  if (!parsed.ok) return { action: 'withhold', at, reason: `okf_invalid: ${parsed.reason}`.slice(0, 200) };
  if (parsed.frontmatter.status === 'deprecated') return forget('deprecated');

  // A concept a bot wrote during a run is judged by that run, like a page it wrote. Two instants: the git author date (to the second, from whichever
  // clock made the commit) and when the index recorded it (the database's clock, the one the runs' times are on); either inside a run that read
  // something narrower is enough to refuse.
  if (p.author_kind === 'bot' && p.author_id !== null) {
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

  const item = renderConcept({
    path: p.path,
    teamSlug: p.team_slug,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    authorId: p.author_id,
    authorName: p.author_name,
    committedAt: p.committed_at.toISOString(),
  });
  return { action: 'retain', at, item };
}
