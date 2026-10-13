import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { renderBundleIndex, renderBundleLog, serializeConcept } from '@manythreads/shared';
import { JOURNAL_MAX_LINKS } from './constants.ts';

// The two things this plugin writes into a team's repository, both through the ONE repo writer (`ctx.providers.get<RepoProvider>('repo')`) as the
// system actor, both idempotent, neither ever overwriting a file that exists:
//
//   * the bundle root, once, on first use of a team's memory: `memory/index.md` (`okf_version: "0.2"`) and `memory/log.md`. (P5-25 makes the
//     writer regenerate every directory's index and the log in the same commit as a change; this is the root they start from.)
//   * the day's journal, `memory/journal/<date>.md`, type `Journal`, `generated.by: process:journal`: counts and source links of what the team's
//     memory took in that day, from `memory_retain_log` — never the retained text, never a withheld source's link or reason.

export const INDEX_PATH = 'memory/index.md';
export const LOG_PATH = 'memory/log.md';
export const journalPath = (date: string): string => `memory/journal/${date}.md`;

interface TeamRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  workspace_id: string;
  archived_at: Date | null;
}

const teamOf = async (tx: PluginTx, teamId: string): Promise<TeamRow | null> =>
  (await tx.query<TeamRow>('SELECT id, slug, name, workspace_id, archived_at FROM app.teams WHERE id = $1::uuid', [teamId])).rows[0] ?? null;

const isConflict = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409;

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Writes the team's bundle root if it is missing and records the team. Idempotent: a recorded team does nothing; a root that already exists
 * (written by an earlier run whose record was lost, by P5-25's writer, by a person) is recorded as it is; a concurrent writer's 409 is "present".
 * An archived team is left alone (its repository takes no write).
 */
export async function ensureBundle(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<'created' | 'present' | 'skipped'> {
  const team = await teamOf(tx, teamId);
  if (team === null || team.archived_at !== null) return 'skipped';
  const known = await tx.query('SELECT 1 FROM app.memory_mirror_teams WHERE team_id = $1::uuid', [teamId]);
  if (known.rows.length > 0) return 'present';
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return 'skipped';

  const have = new Set(
    (await tx.query<{ path: string }>('SELECT path FROM app.repo_entries WHERE team_id = $1::uuid AND path = ANY($2::text[])', [teamId, [INDEX_PATH, LOG_PATH]])).rows.map((r) => r.path),
  );
  const today = dayOf(ctx.runtime.now());
  const changes: Array<{ path: string; op: 'put'; content: string; baseBlobSha: null }> = [];
  if (!have.has(INDEX_PATH)) changes.push({ path: INDEX_PATH, op: 'put', content: renderBundleIndex(), baseBlobSha: null });
  if (!have.has(LOG_PATH)) {
    changes.push({ path: LOG_PATH, op: 'put', content: renderBundleLog([{ date: today, text: 'The memory bundle was created by the platform.' }]), baseBlobSha: null });
  }
  let outcome: 'created' | 'present' = 'present';
  if (changes.length > 0) {
    try {
      await repo.write(tx, teamId, { id: tx.actor.id, kind: 'system' }, changes, 'Create the team memory bundle');
      outcome = 'created';
    } catch (err) {
      // Somebody wrote the file between the look and the write: the writer refuses the whole change and writes nothing, so the root is there.
      if (!isConflict(err)) throw err;
    }
  }
  await tx.query('INSERT INTO app.memory_mirror_teams (team_id, workspace_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT (team_id) DO NOTHING', [teamId, team.workspace_id]);
  return outcome;
}

// The journal ----------------------------------------------------------------------------------------------------------------

export interface JournalCount {
  kind: string;
  retained: number;
  forgotten: number;
  withheld: number;
}

export interface JournalLink {
  kind: string;
  /** ISO time of the retain. */
  at: string;
  /** A path relative to the deployment (`/t/<team>/c/<channel>?message=<id>`). */
  link: string;
}

const KIND_LABEL: Record<string, string> = {
  message: 'message',
  thread: 'thread',
  run: 'bot run',
  approval: 'approval',
  page: 'page',
  run_tool: 'bot memory',
  concept: 'concept',
};
const labelOf = (kind: string): string => KIND_LABEL[kind] ?? kind;

/** The journal as a concept file. Pure: counts and links in, text out. */
export function renderJournal(input: { date: string; now: Date; counts: readonly JournalCount[]; links: readonly JournalLink[]; moreLinks: number }): string {
  const total = input.counts.reduce((n, c) => ({ retained: n.retained + c.retained, forgotten: n.forgotten + c.forgotten, withheld: n.withheld + c.withheld }), {
    retained: 0,
    forgotten: 0,
    withheld: 0,
  });
  const lines: string[] = [
    `# Journal ${input.date}`,
    '',
    `On ${input.date} (UTC) the team's memory took in ${total.retained} item${total.retained === 1 ? '' : 's'}, took out ${total.forgotten} and left out ${total.withheld}. ` +
      'This page holds counts and links only; the text itself stays in the sources.',
    '',
    '| Source | Taken in | Taken out | Left out |',
    '|---|---|---|---|',
  ];
  for (const c of [...input.counts].sort((a, b) => a.kind.localeCompare(b.kind))) lines.push(`| ${labelOf(c.kind)} | ${c.retained} | ${c.forgotten} | ${c.withheld} |`);
  if (input.links.length > 0) {
    lines.push('', '## Taken in', '');
    for (const l of input.links) lines.push(`- ${l.at.slice(11, 16)} [${labelOf(l.kind)}](<${l.link}>)`);
    if (input.moreLinks > 0) lines.push(`- and ${input.moreLinks} more`);
  }
  return serializeConcept(
    {
      type: 'Journal',
      title: `Journal ${input.date}`,
      description: `What the team's memory took in on ${input.date}.`,
      tags: ['journal'],
      status: 'stable',
      origin: 'journal',
      generated: { by: 'process:journal', at: input.now.toISOString() },
    },
    lines.join('\n'),
  );
}

interface CountRow extends Record<string, unknown> {
  kind: string;
  retained: number;
  forgotten: number;
  withheld: number;
}
interface LinkRow extends Record<string, unknown> {
  kind: string;
  at: Date;
  link: string;
}

/**
 * Writes `memory/journal/<date>.md` for a team and a past UTC day, once. Not written when the day left nothing in the log (no empty journals), when
 * the file already exists (a person's edit stays), or for an archived team. Returns what happened.
 */
export async function writeJournal(ctx: PluginContext, tx: PluginTx, input: { teamId: string; date: string }): Promise<'written' | 'exists' | 'empty' | 'skipped'> {
  const team = await teamOf(tx, input.teamId);
  if (team === null || team.archived_at !== null) return 'skipped';
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return 'skipped';
  const path = journalPath(input.date);
  const exists = await tx.query('SELECT 1 FROM app.repo_entries WHERE team_id = $1::uuid AND path = $2', [input.teamId, path]);
  if (exists.rows.length > 0) return 'exists';

  const from = `${input.date}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 24 * 3_600_000).toISOString();
  // The journal's own re-retain and every other concept under memory/journal/ are not "what the team's memory took in".
  const notJournal = `${input.teamId}/memory/journal/%`;
  const counts = (
    await tx.query<CountRow>(
      `SELECT source_kind AS kind,
              (count(*) FILTER (WHERE outcome = 'retained'))::int AS retained,
              (count(*) FILTER (WHERE outcome = 'forgotten'))::int AS forgotten,
              (count(*) FILTER (WHERE outcome = 'withheld'))::int AS withheld
         FROM app.memory_retain_log
        WHERE team_id = $1::uuid AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND outcome IN ('retained', 'forgotten', 'withheld') AND source_id NOT LIKE $4
        GROUP BY source_kind ORDER BY source_kind`,
      [input.teamId, from, to, notJournal],
    )
  ).rows;
  if (counts.length === 0) return 'empty';
  // Links of what was taken in that day and is still in the bank (no later `forgotten` line of the same source), oldest first, one per link.
  const links = (
    await tx.query<LinkRow>(
      `SELECT l.source_kind AS kind, min(l.created_at) AS at, l.link
         FROM app.memory_retain_log l
        WHERE l.team_id = $1::uuid AND l.created_at >= $2::timestamptz AND l.created_at < $3::timestamptz
          AND l.outcome = 'retained' AND l.link LIKE '/t/%' AND l.source_id NOT LIKE $4 AND l.source_kind <> 'run_tool'
          AND NOT EXISTS (SELECT 1 FROM app.memory_retain_log f
                           WHERE f.source_kind = l.source_kind AND f.source_id = l.source_id AND f.outcome = 'forgotten' AND f.id > l.id)
        GROUP BY l.source_kind, l.link
        ORDER BY min(l.created_at), l.link
        LIMIT $5`,
      [input.teamId, from, to, notJournal, JOURNAL_MAX_LINKS + 1],
    )
  ).rows;
  const shown = links.slice(0, JOURNAL_MAX_LINKS);
  const totalRetained = counts.reduce((n, c) => n + c.retained, 0);
  const text = renderJournal({
    date: input.date,
    now: ctx.runtime.now(),
    counts,
    links: shown.map((l) => ({ kind: l.kind, at: l.at.toISOString(), link: l.link })),
    moreLinks: links.length > JOURNAL_MAX_LINKS ? Math.max(1, totalRetained - JOURNAL_MAX_LINKS) : 0,
  });
  try {
    await repo.write(tx, input.teamId, { id: tx.actor.id, kind: 'system' }, [{ path, op: 'put', content: text, baseBlobSha: null }], `Journal ${input.date}`);
  } catch (err) {
    if (isConflict(err)) return 'exists';
    throw err;
  }
  return 'written';
}
