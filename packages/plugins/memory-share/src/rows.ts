import { ShareRun, ShareView, type ShareDestination, type ShareDiff, type ShareConceptRef, type ShareCounts, type ShareExcludedConcept, type ShareLinkState } from '@manythreads/shared';

// The rows of the three tables, and the shapes a client reads.

export interface ShareRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  slug: string;
  name: string;
  status: string;
  invalid_reason: string | null;
  mode: string;
  approval: string;
  auto_allowed: boolean;
  cron: string | null;
  next_run_at: Date | null;
  approvers: string[];
  definition: Record<string, unknown>;
  definition_sha: string | null;
  defined_by: string | null;
  commit_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LinkRow extends Record<string, unknown> {
  id: string;
  share_id: string;
  team_id: string;
  dest_team_id: string;
  state: string;
  ended_reason: string | null;
  dest_slug: string;
  dest_name: string;
}

/** The columns of a run the request role may read (everything but the files and the hash list). */
export const RUN_COLUMNS =
  'r.id, r.workspace_id, r.team_id, r.share_id, r.trigger_kind, r.state, r.state_reason, r.mode, r.requested_by, r.period, r.digest_sha, r.bundle_bytes, r.counts, r.included, r.excluded, r.diff, r.destinations, r.baseline_run_id, r.approval_id, r.settled_by, r.created_at, r.updated_at, r.built_at, r.settled_at, r.sent_at';

export interface RunRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  share_id: string;
  trigger_kind: string;
  state: string;
  state_reason: string | null;
  mode: string;
  requested_by: string | null;
  period: string | null;
  digest_sha: string | null;
  bundle_bytes: number;
  counts: ShareCounts | null;
  included: ShareConceptRef[];
  excluded: ShareExcludedConcept[];
  diff: ShareDiff | null;
  destinations: ShareDestination[];
  baseline_run_id: string | null;
  approval_id: string | null;
  settled_by: string | null;
  created_at: Date;
  updated_at: Date;
  built_at: Date | null;
  settled_at: Date | null;
  sent_at: Date | null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toDestinations(links: readonly LinkRow[]): ShareDestination[] {
  return links
    .filter((l) => l.state !== 'revoked')
    .map((l) => ({ teamId: l.dest_team_id, slug: l.dest_slug, name: l.dest_name, link: l.state as ShareLinkState }) as ShareDestination)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function toShareView(row: ShareRow, links: readonly LinkRow[], last: Pick<RunRow, 'id' | 'state' | 'created_at'> | undefined): ShareView {
  return ShareView.parse({
    id: row.id,
    teamId: row.team_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    invalidReason: row.invalid_reason,
    mode: row.mode,
    approval: row.approval,
    approvalEffective: row.approval === 'auto' && row.auto_allowed ? 'auto' : 'review',
    cron: row.cron,
    nextRunAt: iso(row.next_run_at),
    destinations: toDestinations(links),
    lastRun: last ? { id: last.id, state: last.state, at: last.created_at.toISOString() } : null,
    updatedAt: row.updated_at.toISOString(),
  });
}

export function toRun(row: RunRow): ShareRun {
  return ShareRun.parse({
    id: row.id,
    shareId: row.share_id,
    teamId: row.team_id,
    trigger: row.trigger_kind,
    state: row.state,
    reason: row.state_reason,
    mode: row.mode,
    period: row.period,
    digestSha: row.digest_sha,
    bundleBytes: row.bundle_bytes,
    counts: row.counts,
    included: row.included,
    excluded: row.excluded,
    diff: row.diff,
    destinations: row.destinations,
    approvalId: row.approval_id,
    requestedBy: row.requested_by,
    settledBy: row.settled_by,
    createdAt: row.created_at.toISOString(),
    builtAt: iso(row.built_at),
    settledAt: iso(row.settled_at),
    sentAt: iso(row.sent_at),
  });
}
