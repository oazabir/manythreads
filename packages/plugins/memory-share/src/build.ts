import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import {
  MEMORY_DIGEST_SEND_TOOL,
  SHARE_MAX_BUNDLE_BYTES,
  ShareSelect,
  approvalChangedPushType,
  ApprovalChangedPush,
  bundleAbsoluteLinks,
  checkOkfBundle,
  hasReferencesLink,
  parseConcept,
  shareHeadline,
  trustTier,
  type MemoryShareBuiltEvent,
  type ShareCounts,
  type ShareDestination,
  type ShareDiff,
  type ShareExclusionReason,
  type ShareMode,
  type SharePreview,
  type ShareRunState,
} from '@manythreads/shared';
import { buildDigest, copyOfConcept, oneLine, retiredName, stripReferenceLinks, type ConceptFile, type DigestItem } from './digest.ts';
import type { LinkRow, RunRow, ShareRow } from './rows.ts';
import { toDestinations } from './rows.ts';
import {
  excludedRefs,
  exclusionOf,
  refOf,
  relPath,
  selectConcepts,
  withdraw,
  withheldCounts,
  type SelectableConcept,
  type SelectionResult,
} from './selection.ts';
import { attempt, egressPreset, mayAutoApprove } from './util.ts';

// Building a digest (PLAN P8-22, P8-23). `gather` + `selectConcepts` answer "what would go" from the index alone (the preview); `buildRun` goes on from there as a
// job in the system transaction: read the chosen concepts from the team's repo, put every word through the workspace's data rules, build the bundle, check it is a
// well-formed OKF bundle, and either file the Approvals row or, for a share a lead set to `auto`, leave the run ready. Nothing here sends anything: delivery is the
// next task's. A run ends in exactly one of: empty, blocked, failed, awaiting_approval, ready.

const BLOB_MAX = 900_000;

interface ConceptDbRow extends Record<string, unknown> {
  path: string;
  type: string;
  title: string;
  description: string | null;
  tags: string[];
  status: 'draft' | 'stable' | 'deprecated';
  stale_after: Date | null;
  trust_tier: SelectableConcept['trustTier'];
  origin: string;
  from_team: string | null;
  share_never: boolean;
  blob_sha: string;
  generated_at: Date | null;
}

export async function loadConcepts(tx: PluginTx, teamId: string): Promise<SelectableConcept[]> {
  const rows = await tx.query<ConceptDbRow>(
    `SELECT path, type, title, description, tags, status, stale_after, trust_tier, origin, from_team, share_never, blob_sha, generated_at
       FROM app.memory_concepts WHERE team_id = $1 AND path LIKE 'memory/%' ORDER BY path LIMIT 50000`,
    [teamId],
  );
  return rows.rows.map((r) => ({
    path: r.path,
    type: r.type,
    title: r.title,
    description: r.description,
    tags: r.tags,
    status: r.status,
    staleAfter: r.stale_after,
    trustTier: r.trust_tier,
    origin: r.origin,
    fromTeam: r.from_team,
    shareNever: r.share_never,
    blobSha: r.blob_sha,
    generatedAt: r.generated_at,
  }));
}

export interface Baseline {
  runId: string;
  manifest: Record<string, string>;
  sentAt: Date;
}

/** What the last delivery carried, when it was of the same mode as the share has now (a copy and a summary are not comparable). */
export async function loadBaseline(tx: PluginTx, shareId: string, mode: ShareMode): Promise<Baseline | null> {
  const row = (
    await tx.query<{ id: string; mode: string; manifest: Record<string, string>; sent_at: Date }>(
      `SELECT id, mode, manifest, sent_at FROM app.memory_share_runs WHERE share_id = $1 AND state = 'sent' AND manifest IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT 1`,
      [shareId],
    )
  ).rows[0];
  if (!row || row.mode !== mode) return null;
  return { runId: row.id, manifest: row.manifest, sentAt: row.sent_at };
}

export async function loadLinks(tx: PluginTx, shareId: string): Promise<LinkRow[]> {
  return (await tx.query<LinkRow>('SELECT * FROM app.memory_share_links WHERE share_id = $1 ORDER BY dest_slug', [shareId])).rows;
}

/** The teams a digest of this share is built for: links the destination has accepted, to a team that is not archived. Everyone else is not told the digest exists. */
export async function receivingDestinations(tx: PluginTx, shareId: string): Promise<ShareDestination[]> {
  const rows = (
    await tx.query<LinkRow>(
      `SELECT l.* FROM app.memory_share_links l JOIN app.teams t ON t.id = l.dest_team_id
        WHERE l.share_id = $1 AND l.state = 'accepted' AND t.archived_at IS NULL ORDER BY l.dest_slug`,
      [shareId],
    )
  ).rows;
  return toDestinations(rows);
}

export interface Gathered {
  selection: SelectionResult;
  baseline: Baseline | null;
  destinations: ShareDestination[];
}

/** The selection for a share, now. Reads only the index and the last delivery; the same function serves the preview and the run. */
export async function gather(tx: PluginTx, share: ShareRow, now: Date): Promise<Gathered> {
  const mode = share.mode as ShareMode;
  const select = ShareSelect.parse((share.definition['select'] as unknown) ?? {});
  const [concepts, baseline, links] = await Promise.all([loadConcepts(tx, share.team_id), loadBaseline(tx, share.id, mode), loadLinks(tx, share.id)]);
  return { selection: selectConcepts({ concepts, select, baseline: baseline?.manifest ?? null, now }), baseline, destinations: toDestinations(links) };
}

export function diffOf(selection: SelectionResult): ShareDiff {
  return {
    added: selection.included.filter((i) => i.change === 'added').map((i) => refOf(i.concept)),
    changed: selection.included.filter((i) => i.change === 'changed').map((i) => refOf(i.concept)),
    retired: selection.retired.map(refOf),
    unchanged: selection.unchanged.length,
  };
}

export function countsOf(selection: SelectionResult, redacted = 0): ShareCounts {
  return {
    matched: selection.matched,
    included: selection.included.length,
    leftOut: selection.excluded.length,
    unchanged: selection.unchanged.length,
    retired: selection.retired.length,
    redacted,
  };
}

export function previewOf(share: ShareRow, gathered: Gathered): SharePreview {
  const { selection } = gathered;
  const counts = countsOf(selection);
  return {
    shareId: share.id as SharePreview['shareId'],
    counts,
    headline: shareHeadline(counts.matched, counts.leftOut),
    included: selection.included.map((i) => refOf(i.concept)),
    excluded: excludedRefs(selection),
    diff: diffOf(selection),
    destinations: gathered.destinations,
  };
}

// ---- data rules --------------------------------------------------------------------------------------------------------------------

type Guarded = { kind: 'ok'; text: string; redacted: boolean } | { kind: 'stop'; rules: string[] } | { kind: 'unguarded' };

interface Guard {
  check(text: string): Promise<Guarded>;
}

function guardFor(ctx: PluginContext, tx: PluginTx, run: Pick<RunRow, 'workspace_id' | 'team_id'>, setup: { preset: string; allowlist: string[] }): Guard {
  return {
    async check(text: string): Promise<Guarded> {
      if (text === '') return { kind: 'ok', text, redacted: false };
      const decision = await ctx.hooks.runPreEgress(tx, {
        destination: 'memory_share',
        workspaceId: run.workspace_id,
        teamId: run.team_id,
        text,
        preset: setup.preset,
        allowlist: setup.allowlist,
        mode: 'preset',
        recorded: false,
      });
      if (decision.hooks === 0) return { kind: 'unguarded' };
      if (decision.outcome === 'block' || decision.outcome === 'require_approval') return { kind: 'stop', rules: decision.rules };
      return { kind: 'ok', text: decision.outcome === 'redact' ? decision.text : text, redacted: decision.outcome === 'redact' };
    },
  };
}

// ---- the run -----------------------------------------------------------------------------------------------------------------------

interface Finish {
  state: ShareRunState;
  reason: string | null;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

async function lockRun(tx: PluginTx, runId: string): Promise<(RunRow & { requested_by: string | null }) | undefined> {
  return (await tx.query<RunRow>('SELECT * FROM app.memory_share_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
}

/** Moves a run to a final state that carries no digest, and tells the audit trail. */
async function settleWithout(ctx: PluginContext, tx: PluginTx, run: RunRow, share: ShareRow, finish: Finish, extra: { selection?: SelectionResult; destinations?: ShareDestination[] } = {}): Promise<void> {
  const { selection } = extra;
  const counts = selection ? countsOf(selection) : null;
  await tx.query(
    `UPDATE app.memory_share_runs
        SET state = $2, state_reason = $3, counts = $4::jsonb, included = '[]'::jsonb, excluded = $5::jsonb, diff = $6::jsonb, destinations = $7::jsonb,
            built_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      run.id,
      finish.state,
      finish.reason,
      counts === null ? null : JSON.stringify(counts),
      JSON.stringify(selection ? excludedRefs(selection) : []),
      selection ? JSON.stringify(diffOf(selection)) : null,
      JSON.stringify(extra.destinations ?? []),
    ],
  );
  await emitBuilt(ctx, tx, run, share, finish.state, counts, selection ? withheldCounts(selection) : {}, extra.destinations?.length ?? 0, null);
}

async function emitBuilt(
  ctx: PluginContext,
  tx: PluginTx,
  run: RunRow,
  share: ShareRow,
  state: ShareRunState,
  counts: ShareCounts | null,
  withheld: Partial<Record<ShareExclusionReason, number>>,
  destinations: number,
  approvalId: string | null,
): Promise<void> {
  const event: MemoryShareBuiltEvent = {
    type: 'memory.share.built',
    schemaVersion: 1,
    workspaceId: run.workspace_id as MemoryShareBuiltEvent['workspaceId'],
    teamId: run.team_id as MemoryShareBuiltEvent['teamId'],
    shareId: share.id as MemoryShareBuiltEvent['shareId'],
    slug: share.slug as MemoryShareBuiltEvent['slug'],
    runId: run.id as MemoryShareBuiltEvent['runId'],
    trigger: run.trigger_kind as MemoryShareBuiltEvent['trigger'],
    state,
    counts,
    withheld,
    destinations,
    approvalId: approvalId as MemoryShareBuiltEvent['approvalId'],
    requestedBy: run.requested_by as MemoryShareBuiltEvent['requestedBy'],
    at: ctx.runtime.now().toISOString(),
  };
  await ctx.audit.emit(tx, event);
}

/** The prepared form of one concept chosen for the digest, or the reason it cannot go. */
type Prepared = { ok: true; item: DigestItem; blobSha: string; redacted: boolean } | { ok: false; reason: ShareExclusionReason };

async function prepare(
  ctx: PluginContext,
  tx: PluginTx,
  run: RunRow,
  share: ShareRow,
  team: { id: string; slug: string; name: string },
  guard: Guard,
  entry: { concept: SelectableConcept; change: 'added' | 'changed' },
  select: ShareSelect,
  now: Date,
): Promise<Prepared | { unguarded: true }> {
  let concept = entry.concept;
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');
  // The file is the truth, the index may lag behind it by a commit (or be wrong): in both modes the concept is read and the rules are judged again on what is really there.
  let content: Uint8Array;
  let blobSha: string;
  try {
    const blob = await repo.blob(tx, run.team_id, concept.path, 'main', BLOB_MAX);
    content = blob.content;
    blobSha = blob.sha;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (relPath(concept.path) === 'digest.md') return { ok: false, reason: 'unreadable' };
  const parsed = parseConcept(Buffer.from(content).toString('utf8'));
  if (!parsed.ok) return { ok: false, reason: 'unreadable' };
  const fm = parsed.frontmatter;
  const from = fm['from'];
  concept = {
    ...concept,
    type: fm.type,
    title: fm.title ?? concept.title,
    description: fm.description ?? null,
    tags: fm.tags ?? [],
    status: fm.status ?? 'stable',
    staleAfter: fm.stale_after !== undefined && Number.isFinite(Date.parse(fm.stale_after)) ? new Date(fm.stale_after) : null,
    trustTier: trustTier(fm),
    origin: fm.origin ?? '',
    fromTeam: typeof from === 'string' && from !== '' ? from : null,
    shareNever: fm.share === 'never',
    blobSha,
  };
  const reason = exclusionOf(concept, select, now);
  if (reason !== null) return { ok: false, reason };

  let redacted = false;
  let file: ConceptFile | undefined;
  if (share.mode === 'full') {
    let body = parsed.body;
    // every piece of text that would leave goes through the data rules on its own, so a redaction cannot cut across a field boundary
    for (const field of ['title', 'description', 'body'] as const) {
      const text = field === 'title' ? (fm.title ?? '') : field === 'description' ? (fm.description ?? '') : body;
      const g = await guard.check(text);
      if (g.kind === 'unguarded') return { unguarded: true };
      if (g.kind === 'stop') return { ok: false, reason: 'dlp' };
      if (g.redacted) {
        redacted = true;
        if (field === 'title') fm.title = g.text;
        else if (field === 'description') fm.description = g.text;
        else body = g.text;
      }
    }
    // a link into the sender's references/ that the builder cannot take out cleanly: the concept stays home rather than carry a pointer to an original
    if (hasReferencesLink(stripReferenceLinks(bundleAbsoluteLinks(body, concept.path)))) return { ok: false, reason: 'original' };
    file = { frontmatter: fm, body };
    concept = { ...concept, title: fm.title ?? concept.title, description: fm.description ?? null };
    // the copy as a whole, header included (tags, resource, type and stale_after are copied too): anything the rules still find in it keeps the concept home
    const copy = await guard.check(copyOfConcept(team, concept, file));
    if (copy.kind === 'unguarded') return { unguarded: true };
    if (copy.kind === 'stop' || copy.redacted) return { ok: false, reason: 'dlp' };
  } else {
    // a summary carries the title and the description only
    for (const field of ['title', 'description'] as const) {
      const text = field === 'title' ? concept.title : (concept.description ?? '');
      const g = await guard.check(text);
      if (g.kind === 'unguarded') return { unguarded: true };
      if (g.kind === 'stop') return { ok: false, reason: 'dlp' };
      if (g.redacted) {
        redacted = true;
        concept = field === 'title' ? { ...concept, title: g.text } : { ...concept, description: g.text };
      }
    }
  }
  return { ok: true, item: { concept, change: entry.change, file }, blobSha, redacted };
}

const NOT_ACTIVE = 'This share is not active, so no digest was built. Fix or restore its file and run it again.';

/**
 * Builds the digest of a run in the `building` state, to the end of what this task does. Called by the build job in the system transaction. Idempotent: a run that
 * is no longer `building` is left alone.
 */
export async function buildRun(ctx: PluginContext, tx: PluginTx, runId: string): Promise<void> {
  const run = await lockRun(tx, runId);
  if (!run || run.state !== 'building') return;
  const share = (await tx.query<ShareRow>('SELECT * FROM app.memory_shares WHERE id = $1', [run.share_id])).rows[0];
  if (!share) return;
  const now = ctx.runtime.now();
  if (share.status !== 'active') return settleWithout(ctx, tx, run, share, { state: 'failed', reason: NOT_ACTIVE });

  const team = (await tx.query<{ id: string; slug: string; name: string; archived_at: Date | null }>('SELECT id, slug, name, archived_at FROM app.teams WHERE id = $1', [run.team_id])).rows[0];
  if (!team) return settleWithout(ctx, tx, run, share, { state: 'failed', reason: 'The sending team could not be found.' });
  if (team.archived_at !== null) return settleWithout(ctx, tx, run, share, { state: 'failed', reason: 'The sending team is archived, so nothing is shared from it.' });

  const gathered = await gather(tx, share, now);
  const { baseline } = gathered;
  // Only teams that accepted the share (and are not archived) are sent to: a digest is not built for a team that has not agreed to receive it.
  const destinations = await receivingDestinations(tx, share.id);
  if (destinations.length === 0) {
    const reason =
      gathered.destinations.length === 0
        ? 'The share names no destination team any more.'
        : 'No team has accepted this share yet (or the teams that did are archived), so there is nobody to send a digest to.';
    return settleWithout(ctx, tx, run, share, { state: 'empty', reason }, { selection: gathered.selection, destinations });
  }
  let selection = gathered.selection;
  if (selection.included.length === 0 && selection.retired.length === 0) {
    const reason = selection.matched === 0 ? 'Nothing in the team’s memory matches this share.' : 'Nothing has changed since the last digest, so there is nothing to send.';
    return settleWithout(ctx, tx, run, share, { state: 'empty', reason }, { selection, destinations });
  }

  // The data rules: the workspace preset decides, and nothing may leave unguarded.
  const setup = await egressPreset(tx, run.workspace_id);
  const guard = guardFor(ctx, tx, run, setup);
  const select = ShareSelect.parse((share.definition['select'] as unknown) ?? {});
  const dropped = new Map<string, ShareExclusionReason>();
  const items: DigestItem[] = [];
  const hashes: Record<string, string> = {};
  let redactedConcepts = 0;
  let budget = SHARE_MAX_BUNDLE_BYTES - 20_000;
  for (const entry of selection.included) {
    const prepared = await prepare(ctx, tx, run, share, team, guard, entry, select, now);
    if ('unguarded' in prepared) {
      return settleWithout(ctx, tx, run, share, { state: 'blocked', reason: 'No data-protection rule is switched on for this workspace, so nothing may leave the team. An admin can turn the data guard on.' }, { selection, destinations });
    }
    if (!prepared.ok) {
      dropped.set(entry.concept.path, prepared.reason);
      continue;
    }
    const size = Buffer.byteLength(prepared.item.file?.body ?? '') + 4_000;
    if (size > budget) {
      dropped.set(entry.concept.path, 'too_large');
      continue;
    }
    budget -= size;
    if (prepared.redacted) redactedConcepts += 1;
    hashes[prepared.item.concept.path] = prepared.blobSha;
    items.push(prepared.item);
  }
  selection = withdraw(selection, dropped);
  // the manifest records what was really read, not what the index said
  selection = { ...selection, manifest: { ...selection.manifest, ...hashes } };
  // A retired concept is named by its path only (what the earlier digest carried), never by its title today. The name goes through the rules too; one they touch is not announced.
  const retired: SelectableConcept[] = [];
  for (const c of selection.retired) {
    const g = await guard.check(retiredName(c));
    if (g.kind === 'unguarded') return settleWithout(ctx, tx, run, share, { state: 'blocked', reason: 'No data-protection rule is switched on for this workspace, so nothing may leave the team.' }, { selection, destinations });
    if (g.kind === 'ok' && !g.redacted) retired.push(c);
  }
  if (items.length === 0 && retired.length === 0) {
    return settleWithout(ctx, tx, run, share, { state: 'empty', reason: 'Every concept that changed was left out (see the list), so there is nothing to send.' }, { selection, destinations });
  }

  const sinceDay = baseline ? dayOf(baseline.sentAt) : null;
  const date = dayOf(now);
  const built = buildDigest({
    team,
    share: { slug: share.slug, name: share.name },
    mode: share.mode as ShareMode,
    period: date,
    since: sinceDay,
    included: items,
    retired,
  });

  // Every file of the digest as a whole is judged by the same rules (the summary, every copy with its header, the notices), and it must be a well-formed OKF bundle.
  for (const [filePath, text] of Object.entries(built.files)) {
    const whole = await guard.check(text);
    if (whole.kind === 'unguarded' || whole.kind === 'stop' || whole.redacted) {
      const what = filePath === 'digest.md' ? 'The summary of this digest' : 'A file of this digest';
      return settleWithout(ctx, tx, run, share, { state: 'blocked', reason: `${what} holds something the workspace’s data rules do not let leave the team.` }, { selection, destinations });
    }
  }
  if (built.bytes > SHARE_MAX_BUNDLE_BYTES) {
    return settleWithout(ctx, tx, run, share, { state: 'blocked', reason: 'The digest is larger than a digest may be. Narrow the share’s selection.' }, { selection, destinations });
  }
  const check = checkOkfBundle(built.files, { digest: true });
  if (!check.ok) {
    const first = check.problems[0];
    return settleWithout(
      ctx,
      tx,
      run,
      share,
      { state: 'blocked', reason: `The digest is not a well-formed OKF bundle: ${first?.path ? `${first.path}: ` : ''}${first?.message ?? 'a check failed'}`.slice(0, 590) },
      { selection, destinations },
    );
  }

  // The same digest already waits for a decision (or is ready): a second press of Run now does not file a second one.
  const twin = (
    await tx.query<{ id: string; state: string }>(
      `SELECT id, state FROM app.memory_share_runs WHERE share_id = $1 AND digest_sha = $2 AND id <> $3 AND state IN ('awaiting_approval', 'ready') ORDER BY id DESC LIMIT 1`,
      [share.id, built.sha, run.id],
    )
  ).rows[0];
  if (twin) {
    return settleWithout(ctx, tx, run, share, { state: 'empty', reason: `This digest is the same as the one already ${twin.state === 'ready' ? 'approved and waiting to be delivered' : 'waiting for a decision'}.` }, { selection, destinations });
  }

  const same = (
    await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.memory_share_runs WHERE share_id = $1 AND id <> $2 AND state IN ('awaiting_approval', 'ready', 'sent') AND period LIKE $3`,
      [share.id, run.id, `${date}%`],
    )
  ).rows[0]?.n ?? 0;
  const period = same === 0 ? date : `${date}-${same + 1}`;
  const counts = countsOf(selection, redactedConcepts);
  const diff = diffOf(selection);
  const excluded = excludedRefs(selection);
  const included = selection.included.map((i) => refOf(i.concept));

  // The digest is stored first (still `building`): the approval door wants a run that has one.
  await tx.query(
    `UPDATE app.memory_share_runs
        SET period = $2, digest_sha = $3, bundle = $4::jsonb, bundle_bytes = $5, manifest = $6::jsonb, counts = $7::jsonb, included = $8::jsonb, excluded = $9::jsonb, diff = $10::jsonb,
            destinations = $11::jsonb, baseline_run_id = $12, built_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      run.id,
      period,
      built.sha,
      JSON.stringify(built.files),
      built.bytes,
      JSON.stringify(selection.manifest),
      JSON.stringify(counts),
      JSON.stringify(included),
      JSON.stringify(excluded),
      JSON.stringify(diff),
      JSON.stringify(destinations),
      baseline?.runId ?? null,
    ],
  );

  // `auto` is decided when the file is read and asked again now: the person who wrote it must still be an active lead of this team or a workspace owner or admin.
  const auto = share.approval === 'auto' && share.auto_allowed && (await mayAutoApprove(tx, run.team_id, share.defined_by));
  if (auto) {
    await tx.query(`UPDATE app.memory_share_runs SET state = 'ready', state_reason = $2, settled_at = now(), updated_at = now() WHERE id = $1`, [
      run.id,
      'Ready to be delivered without a review: a team lead or workspace admin set this share to go automatically.',
    ]);
    await emitBuilt(ctx, tx, run, share, 'ready', counts, withheldCounts(selection), destinations.length, null);
    return;
  }

  const requester = run.requested_by ?? share.defined_by;
  if (requester === null) {
    await tx.query(`UPDATE app.memory_share_runs SET state = 'failed', state_reason = $2, updated_at = now() WHERE id = $1`, [
      run.id,
      'Nobody is on record to ask for this digest’s approval. Run it by hand once from the share’s page.',
    ]);
    await emitBuilt(ctx, tx, run, share, 'failed', counts, withheldCounts(selection), destinations.length, null);
    return;
  }
  const names = destinations.map((d) => d.name || d.slug);
  const preview = {
    share: share.name,
    from: team.name,
    to: destinations.map((d) => ({ team: d.name || d.slug, link: d.link })),
    mode: share.mode,
    period,
    counts,
    included: included.slice(0, 40),
    excluded: excluded.slice(0, 40).map((e) => ({ ...e, title: oneLine(e.title, 200) })),
    diff: { added: diff.added.slice(0, 40), changed: diff.changed.slice(0, 40), retired: diff.retired.slice(0, 40), unchanged: diff.unchanged },
    more: { included: Math.max(0, included.length - 40), excluded: Math.max(0, excluded.length - 40) },
  };
  const summary = `Send “${oneLine(share.name, 80)}” to ${oneLine(names.join(', '), 120)}: ${counts.included} new or updated, ${counts.leftOut} left out`;
  const approvalId = (
    await tx.query<{ id: string }>('SELECT app.memory_share_request_approval($1::uuid, $2::uuid, $3, $4::jsonb, $5::text[]) AS id', [run.id, requester, summary, JSON.stringify(preview), share.approvers])
  ).rows[0]?.id;
  if (!approvalId) throw new Error('the approval was not filed');
  await tx.query(`UPDATE app.memory_share_runs SET state = 'awaiting_approval', state_reason = $2, updated_at = now() WHERE id = $1`, [
    run.id,
    'Waiting for a team lead or workspace admin to approve it in Approvals.',
  ]);
  await pushApproval(ctx, tx, approvalId);
  await emitBuilt(ctx, tx, run, share, 'awaiting_approval', counts, withheldCounts(selection), destinations.length, approvalId);
}

/** Ends a run that is still `building` as failed, with a sentence (used by the tick for a build that never finished). */
export async function failBuilding(ctx: PluginContext, tx: PluginTx, runId: string, reason: string): Promise<void> {
  const run = await lockRun(tx, runId);
  if (!run || run.state !== 'building') return;
  const share = (await tx.query<ShareRow>('SELECT * FROM app.memory_shares WHERE id = $1', [run.share_id])).rows[0];
  if (!share) return;
  await settleWithout(ctx, tx, run, share, { state: 'failed', reason });
}

/** The open tabs of the people who can see the approval refetch it (the list is the truth, the push only says when). */
export async function pushApproval(ctx: PluginContext, tx: PluginTx, approvalId: string): Promise<void> {
  const row = (await tx.query<{ o_team_id: string; o_people: string[] }>('SELECT o_team_id, o_people FROM app.approvals_audience($1::uuid)', [approvalId])).rows[0];
  if (!row || row.o_people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, row.o_people, approvalChangedPushType, ApprovalChangedPush.parse({ teamId: row.o_team_id, approvalId }));
}

/**
 * Runs `buildRun` so that any failure ends in a `failed` run with a plain sentence instead of a stuck `building` one (a build that throws is rolled back to the
 * savepoint, the run is marked, and the job completes: a run is one try, and Run now starts another).
 */
export async function buildRunSafely(ctx: PluginContext, tx: PluginTx, runId: string, log?: { warn(message: string): void }): Promise<void> {
  const result = await attempt(tx, () => buildRun(ctx, tx, runId));
  if (result.ok) return;
  log?.warn(`memory-share: building the digest of run ${runId} failed: ${result.error instanceof Error ? result.error.message.slice(0, 200) : 'unknown'}`);
  const run = await lockRun(tx, runId);
  if (!run || run.state !== 'building') return;
  const share = (await tx.query<ShareRow>('SELECT * FROM app.memory_shares WHERE id = $1', [run.share_id])).rows[0];
  if (!share) return;
  await settleWithout(ctx, tx, run, share, { state: 'failed', reason: 'The digest could not be built. Run the share again; if it keeps failing, ask a workspace admin to look at the server log.' });
}

export { MEMORY_DIGEST_SEND_TOOL };
