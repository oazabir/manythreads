import { createHash } from 'node:crypto';
import type { PluginContext, PluginEvent, PluginTx, RepoProvider } from '@manythreads/sdk';
import { RepoRepoCommittedEvent, SHARE_FILE_RE, ShareDefinition, nextCronRun, shareCronOf, type MemoryShareDefinedEvent } from '@manythreads/shared';
import { parseDocument } from 'yaml';
import { isWorkspaceAdmin, mayAutoApprove } from './util.ts';

// The loader for `routines/shares/<slug>.yaml` (PLAN P8-22), a `repo.repo.committed` subscription in the outbox consumer's system transaction, once per commit, the
// way the bots loader works. A valid file becomes (or updates) the share's row and its links; an invalid file keeps the previous row alive as `invalid` with the
// reason on it (a share that stopped loading never keeps running a definition nobody can read now, but it is not lost); a deleted file marks the share `removed`
// and revokes its links. Every step is an upsert or an update, so the outbox retrying an event changes nothing twice.

interface Commit {
  workspaceId: string;
  teamId: string;
  sha: string;
  authorId: string | null;
}

interface Problem {
  /** The field the problem is in, as a short code for the event (`to`, `select.paths`, `yaml`). */
  field: string;
  /** A sentence for the person who wrote the file. */
  message: string;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The YAML of the file as a plain value, or the problem. Aliases are refused (a billion-laughs file must cost nothing). */
function readYaml(text: string): { ok: true; value: unknown } | { ok: false; problem: Problem } {
  try {
    const doc = parseDocument(text, { uniqueKeys: true, version: '1.2', logLevel: 'silent' });
    if (doc.errors.length > 0) return { ok: false, problem: { field: 'yaml', message: `The file is not valid YAML: ${(doc.errors[0]?.message ?? '').split('\n')[0]?.slice(0, 160) ?? ''}` } };
    return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
  } catch {
    return { ok: false, problem: { field: 'yaml', message: 'The file could not be read as YAML (aliases are not allowed).' } };
  }
}

async function emitDefined(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string, fields: Pick<MemoryShareDefinedEvent, 'status' | 'problem' | 'destinations' | 'mode' | 'approval'>): Promise<void> {
  const event: MemoryShareDefinedEvent = {
    type: 'memory.share.defined',
    schemaVersion: 1,
    workspaceId: commit.workspaceId as MemoryShareDefinedEvent['workspaceId'],
    teamId: commit.teamId as MemoryShareDefinedEvent['teamId'],
    slug,
    definedBy: commit.authorId as MemoryShareDefinedEvent['definedBy'],
    at: ctx.runtime.now().toISOString(),
    ...fields,
  };
  await ctx.audit.emit(tx, event);
}

/** A file that cannot be accepted: the previous row (if any) stays, marked invalid; a new one is created so the page can say why. */
async function invalidate(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string, sha: string | null, problem: Problem): Promise<void> {
  const reason = cut(problem.message, 400);
  await tx.query(
    `INSERT INTO app.memory_shares AS s (workspace_id, team_id, slug, name, status, invalid_reason, definition_sha, commit_sha, defined_by)
     VALUES ($1, $2, $3, $4, 'invalid', $5, $6, $7, $8)
     ON CONFLICT (team_id, slug) DO UPDATE
        SET status = 'invalid', invalid_reason = EXCLUDED.invalid_reason, definition_sha = EXCLUDED.definition_sha, commit_sha = EXCLUDED.commit_sha, updated_at = now()`,
    [commit.workspaceId, commit.teamId, slug, slug, reason, sha, commit.sha, commit.authorId],
  );
  await emitDefined(ctx, tx, commit, slug, { status: 'invalid', problem: cut(problem.field, 200), destinations: 0, mode: null, approval: null });
}

async function loadShare(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string, path: string): Promise<void> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');
  let content: Uint8Array;
  try {
    content = (await repo.blob(tx, commit.teamId, path, commit.sha)).content;
  } catch (err) {
    // The file is gone at that commit (a later commit deleted it; its own event removes the share) or is too large to be a share definition.
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 404) return;
    if (status === 413) return invalidate(ctx, tx, commit, slug, null, { field: 'file', message: 'The file is larger than a share definition may be.' });
    throw err;
  }
  const text = Buffer.from(content).toString('utf8');
  const sha = createHash('sha256').update(content).digest('hex');

  const yaml = readYaml(text);
  if (!yaml.ok) return invalidate(ctx, tx, commit, slug, sha, yaml.problem);
  const parsed = ShareDefinition.safeParse(yaml.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') || 'file';
    return invalidate(ctx, tx, commit, slug, sha, { field, message: `${field}: ${issue?.message ?? 'the file is not a share definition'}` });
  }
  const def = parsed.data;

  const wanted = [...new Set(def.to)];
  // A destination is named only by a person who can see that team (a member, or a workspace admin): the file cannot be used to find out which teams exist or what they are
  // called. A team the author cannot see gets the same sentence as one that does not exist.
  const admin = await isWorkspaceAdmin(tx, commit.authorId);
  const teams = (
    await tx.query<{ id: string; slug: string; name: string }>(
      `SELECT t.id, t.slug, t.name FROM app.teams t
        WHERE t.workspace_id = $1 AND t.slug = ANY ($2::text[]) AND t.archived_at IS NULL
          AND ($3::boolean OR ($4::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = t.id AND tm.actor_id = $4::uuid)))`,
      [commit.workspaceId, wanted, admin, commit.authorId],
    )
  ).rows;
  const self = (await tx.query<{ slug: string }>('SELECT slug FROM app.teams WHERE id = $1', [commit.teamId])).rows[0];
  if (self !== undefined && wanted.includes(self.slug)) {
    return invalidate(ctx, tx, commit, slug, sha, { field: 'to', message: 'to: a share cannot go to the team that sends it.' });
  }
  const found = new Set(teams.map((t) => t.slug));
  const missing = wanted.filter((s) => !found.has(s));
  if (missing.length > 0) {
    return invalidate(ctx, tx, commit, slug, sha, { field: 'to', message: `to: no team here is called ${missing.slice(0, 5).join(', ')}.` });
  }

  const cron = shareCronOf(def.when);
  const autoAllowed = def.approval === 'auto' && (await mayAutoApprove(tx, commit.teamId, commit.authorId));
  const now = ctx.runtime.now();
  const first = cron === null ? null : nextCronRun(cron, now);
  const row = (
    await tx.query<{ id: string }>(
      `INSERT INTO app.memory_shares AS s (workspace_id, team_id, slug, name, status, invalid_reason, mode, approval, auto_allowed, cron, next_run_at, approvers, definition, definition_sha, defined_by, commit_sha)
       VALUES ($1, $2, $3, $4, 'active', NULL, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12, $13, $14)
       ON CONFLICT (team_id, slug) DO UPDATE
          SET name = EXCLUDED.name, status = 'active', invalid_reason = NULL, mode = EXCLUDED.mode, approval = EXCLUDED.approval, auto_allowed = EXCLUDED.auto_allowed,
              cron = EXCLUDED.cron,
              next_run_at = CASE WHEN EXCLUDED.cron IS NULL THEN NULL WHEN s.cron IS NOT DISTINCT FROM EXCLUDED.cron AND s.next_run_at IS NOT NULL AND s.status = 'active' THEN s.next_run_at ELSE EXCLUDED.next_run_at END,
              approvers = EXCLUDED.approvers, definition = EXCLUDED.definition, definition_sha = EXCLUDED.definition_sha, defined_by = EXCLUDED.defined_by,
              commit_sha = EXCLUDED.commit_sha, updated_at = now()
       RETURNING id`,
      [
        commit.workspaceId,
        commit.teamId,
        slug,
        def.name,
        def.mode,
        def.approval,
        autoAllowed,
        cron,
        first,
        def.approvers,
        JSON.stringify(def),
        sha,
        commit.authorId,
        commit.sha,
      ],
    )
  ).rows[0];
  if (!row) throw new Error('the share row was not written');

  // The links: one per destination. A destination that was taken out of the file earlier and is named again starts over as `requested`; one its own team ended stays ended.
  for (const team of teams) {
    await tx.query(
      `INSERT INTO app.memory_share_links AS l (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (share_id, dest_team_id) DO UPDATE
          SET dest_slug = EXCLUDED.dest_slug, dest_name = EXCLUDED.dest_name,
              state = CASE WHEN l.state = 'revoked' AND l.ended_reason = 'removed' THEN 'requested' ELSE l.state END,
              ended_reason = CASE WHEN l.state = 'revoked' AND l.ended_reason = 'removed' THEN NULL ELSE l.ended_reason END,
              requested_at = CASE WHEN l.state = 'revoked' AND l.ended_reason = 'removed' THEN now() ELSE l.requested_at END,
              accepted_at = CASE WHEN l.state = 'revoked' AND l.ended_reason = 'removed' THEN NULL ELSE l.accepted_at END,
              accepted_by = CASE WHEN l.state = 'revoked' AND l.ended_reason = 'removed' THEN NULL ELSE l.accepted_by END,
              updated_at = now()`,
      [commit.workspaceId, commit.teamId, row.id, team.id, team.slug, team.name.slice(0, 200)],
    );
  }
  await tx.query(
    `UPDATE app.memory_share_links SET state = 'revoked', ended_reason = 'removed', updated_at = now()
      WHERE share_id = $1 AND NOT (dest_team_id = ANY ($2::uuid[])) AND state <> 'revoked'`,
    [row.id, teams.map((t) => t.id)],
  );
  await emitDefined(ctx, tx, commit, slug, { status: 'active', problem: null, destinations: teams.length, mode: def.mode, approval: autoAllowed ? 'auto' : 'review' });
}

async function removeShare(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string): Promise<void> {
  const row = (
    await tx.query<{ id: string }>(
      `UPDATE app.memory_shares SET status = 'removed', next_run_at = NULL, invalid_reason = NULL, commit_sha = $3, updated_at = now()
        WHERE team_id = $1 AND slug = $2 AND status <> 'removed' RETURNING id`,
      [commit.teamId, slug, commit.sha],
    )
  ).rows[0];
  if (!row) return;
  await tx.query(`UPDATE app.memory_share_links SET state = 'revoked', ended_reason = 'removed', updated_at = now() WHERE share_id = $1 AND state <> 'revoked'`, [row.id]);
  await emitDefined(ctx, tx, commit, slug, { status: 'removed', problem: null, destinations: 0, mode: null, approval: null });
}

/** Wires the one subscription. Runs as the system actor in the outbox consumer. */
export function registerShareLoader(ctx: PluginContext): void {
  ctx.events.subscribe('repo.repo.committed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = RepoRepoCommittedEvent.parse(raw);
    for (const change of event.paths) {
      const match = SHARE_FILE_RE.exec(change.path);
      if (!match) continue;
      const commit: Commit = { workspaceId: event.workspaceId, teamId: event.teamId, sha: event.sha, authorId: event.authorId };
      if (change.op === 'delete') await removeShare(ctx, tx, commit, match[1]!);
      else await loadShare(ctx, tx, commit, match[1]!, change.path);
    }
  });
}
