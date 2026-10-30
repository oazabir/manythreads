import { HttpError, type PluginContext, type PluginTx, type RepoProvider, type TeamRow } from '@manythreads/sdk';
import {
  PROPOSAL_MAX_CHARS,
  isBotDefinitionPath,
  isGuardedRepoPath,
  parseRepoPath,
  toUnifiedDiff,
  ProposalCheck,
  ProposalDetail,
  type CreateProposalRequest,
  type ErrorCode,
} from '@manythreads/shared';
import { failedChecks, runChecks } from './checks.ts';
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from './rows.ts';

// The proposals service (PLAN P7-01): make a proposal, show it with what the caller may do, apply it (the one place a guarded file is committed),
// reject it, withdraw it. The rules about who may do what live in the database (migration 0001: proposals_why_not, proposals_decide); the repo
// writer checks the approver's rights a second time when it commits. This module adds the repository side: the base blob, the checks, the commit.

const forbidden = (message: string): HttpError => new HttpError(403, 'forbidden', message);
const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);
const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
const invalid = (message: string): HttpError => new HttpError(400, 'validation_failed', message);

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

/** What the repo writer rejects with (`RepoError`): a status and a code the client reads. */
function repoStatus(err: unknown): { status: number; code: string; message: string } | null {
  const e = err as { name?: string; status?: number; code?: string; message?: string };
  if (e?.name !== 'RepoError' || typeof e.status !== 'number') return null;
  return { status: e.status, code: e.code ?? 'validation_failed', message: e.message ?? 'The repository refused the change' };
}

/** A repo refusal as an HTTP error of the same status. */
function asHttp(err: unknown): never {
  const r = repoStatus(err);
  if (r && [400, 403, 404, 409, 413, 422].includes(r.status)) throw new HttpError(r.status, r.code as ErrorCode, r.message);
  throw err;
}

function repoOf(ctx: PluginContext): RepoProvider {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new HttpError(503, 'internal', 'The team repository is not available');
  return repo;
}

/** The file as the team repo holds it now: its text and blob (null when it does not exist), and the head commit. */
async function currentFile(tx: PluginTx, repo: RepoProvider, teamId: string, path: string): Promise<{ text: string | null; blobSha: string | null; head: string }> {
  const head = (await repo.tree(tx, teamId, '', 'HEAD').catch(asHttp)).commitSha;
  try {
    const blob = await repo.blob(tx, teamId, path, 'HEAD');
    return { text: new TextDecoder().decode(blob.content), blobSha: blob.sha, head };
  } catch (err) {
    if (repoStatus(err)?.status === 404) return { text: null, blobSha: null, head };
    return asHttp(err);
  }
}

const defaultTitle = (op: 'put' | 'delete', path: string, existed: boolean): string => (op === 'delete' ? `Remove ${path}` : existed ? `Change ${path}` : `Add ${path}`);

/**
 * One decision on a proposal at a time. The commit to the repo cannot be undone by a rollback, so two requests that decide the same proposal (a double
 * click, an apply racing a decline or a withdraw) must not run side by side: the second waits here until the first has ended its transaction, and then
 * reads the proposal as it is (`proposals_why_not` / `proposals_decide` see the new status and refuse).
 */
async function lockProposal(tx: PluginTx, id: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`proposals.decide:${id}`]);
}

/** Reads a proposal the caller can see (row-level security decides), or null. */
export async function loadProposal(tx: PluginTx, id: string, teamId?: string): Promise<ProposalRow | null> {
  const res = await tx.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM app.proposals p WHERE p.id = $1::uuid${teamId ? ' AND p.team_id = $2::uuid' : ''}`, teamId ? [id, teamId] : [id]);
  return res.rows[0] ?? null;
}

async function requireProposal(tx: PluginTx, id: string, team: TeamRow): Promise<ProposalRow> {
  const row = await loadProposal(tx, id, team.id);
  if (!row) throw notFound('No such proposal');
  return row;
}

/** The proposal as the caller sees it: is it out of date, may they apply it and if not why not. */
export async function detailOf(ctx: PluginContext, tx: PluginTx, row: ProposalRow): Promise<ProposalDetail> {
  const proposal = toProposal(row);
  let stale = false;
  let staleReason: string | null = null;
  if (row.status === 'open') {
    const cur = await currentFile(tx, repoOf(ctx), row.team_id, row.path);
    const reason = movedReason(row, cur.blobSha);
    if (reason) {
      stale = true;
      staleReason = reason;
    }
  }
  const why = row.status === 'open' ? (await tx.query<{ why: string | null }>('SELECT app.proposals_why_not($1::uuid, false) AS why', [row.id])).rows[0]?.why ?? null : null;
  const blocked = failedChecks(proposal.checks);
  let cannotApplyReason: string | null = row.status === 'open' ? why : `This proposal is already ${row.status}.`;
  if (cannotApplyReason === null && stale) cannotApplyReason = staleReason;
  if (cannotApplyReason === null && blocked) cannotApplyReason = `A check failed, so it cannot be applied. ${blocked}`;
  const person = tx.actor.kind === 'person';
  const manage = person && row.status === 'open' && (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'manage') AS ok", [row.team_id])).rows[0]?.ok === true;
  return ProposalDetail.parse({
    proposal,
    stale,
    staleReason,
    canApply: cannotApplyReason === null,
    cannotApplyReason,
    canReject: manage && row.author_id !== tx.actor.id,
    canWithdraw: row.status === 'open' && row.author_id === tx.actor.id,
  });
}

/** Why the file no longer matches what the proposal was made against, in plain words; null while it still matches. */
function movedReason(row: ProposalRow, currentBlob: string | null): string | null {
  if (currentBlob === row.base_blob_sha) return null;
  if (row.base_blob_sha === null) return `${row.path} has been added since this proposal was made, so it would overwrite someone else's file. Set it aside and propose again from the current file.`;
  if (currentBlob === null) return `${row.path} has been removed since this proposal was made. Set it aside and propose again if the file should come back.`;
  return `${row.path} has changed since this proposal was made, so applying it would overwrite those changes. Set it aside and propose again from the current version.`;
}

const RESERVED = 'Only bots/, TEAM.md, skills/ and routines/ go through proposals. Other files are changed directly in Files.';

/** Make a proposal as the caller (a person or a bot). With `applyNow` it is applied in the same step by a lead or admin; any failure undoes both. */
export async function createProposal(ctx: PluginContext, tx: PluginTx, team: TeamRow, req: CreateProposalRequest): Promise<ProposalDetail> {
  const parsedPath = parseRepoPath(req.path);
  if (!parsedPath.ok) throw invalid(`path: ${parsedPath.reason}`);
  const path = parsedPath.path;
  if (!isGuardedRepoPath(path)) throw invalid(RESERVED);
  if (tx.actor.kind !== 'person' && tx.actor.kind !== 'bot') throw forbidden('Only a person or a bot makes a proposal');
  if (req.applyNow === true && tx.actor.kind !== 'person') throw forbidden('A bot can only propose. A lead or admin applies it.');
  if (team.archived_at) throw conflict('This team is archived, so nothing can be proposed for it');
  const op = req.op;
  let content: string | null = null;
  if (op === 'put') {
    if (req.content === undefined) throw invalid('content: the new text of the file is needed');
    if (req.content.includes('\0')) throw new HttpError(422, 'attachment_not_in_repo', 'The team repo holds text only; this file has a NUL byte');
    if (req.content.length > PROPOSAL_MAX_CHARS) throw new HttpError(413, 'validation_failed', `The file is longer than ${PROPOSAL_MAX_CHARS / 1024} KB`);
    content = req.content;
  } else if (req.content !== undefined) {
    throw invalid('content: a removal carries no text');
  }

  const cur = await currentFile(tx, repoOf(ctx), team.id, path);
  if (op === 'delete' && cur.blobSha === null) throw notFound(`${path} does not exist, so there is nothing to remove`);
  // A base the author names must still be current; left out, the proposal is based on the file as it is now (what a bot does).
  if (req.baseBlobSha !== undefined && req.baseBlobSha !== cur.blobSha) {
    throw conflict(
      cur.blobSha === null
        ? `${path} no longer exists. Reload and propose again.`
        : req.baseBlobSha === null
          ? `${path} already exists. Open it and propose a change to it instead.`
          : `${path} changed while you were working. Reload it to see the new version; nothing was proposed.`,
    );
  }
  if (op === 'put' && content === cur.text) throw invalid('This does not change the file, so there is nothing to propose.');

  const d = toUnifiedDiff(path, cur.text, content);
  const checks = runChecks(path, op, content);
  const needsAdmin = isBotDefinitionPath(path) && (op === 'delete' || cur.blobSha === null);
  const made = await tx.query<{ id: string }>('SELECT app.proposals_create($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) AS id', [
    team.id,
    path,
    op,
    req.title ?? defaultTitle(op, path, cur.blobSha !== null),
    req.note ?? '',
    content,
    cur.blobSha,
    cur.head,
    needsAdmin,
    d.text,
    d.additions,
    d.deletions,
    JSON.stringify(checks),
  ]);
  const id = made.rows[0]?.id;
  if (!id) throw new Error('the proposal make answered no row');
  const row = await loadProposal(tx, id);
  if (!row) throw new Error('the proposal that was just made cannot be read');
  await ctx.audit.emit(tx, {
    type: 'proposals.proposal.created',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    proposalId: row.id,
    path: row.path,
    op: row.op,
    authorId: row.author_id,
    authorKind: row.author_kind,
    checksOk: failedChecks(ProposalCheck.array().parse(row.checks)) === null,
    at: now(ctx),
  });
  if (req.applyNow === true) return applyProposal(ctx, tx, row, { self: true });
  return detailOf(ctx, tx, row);
}

/**
 * Apply a proposal: the change is committed to the team repo as the caller. The database decides whether the caller may (a lead or admin; an admin to add
 * or remove a bot; not the author unless nobody else could, or unless this is "propose and apply"); the checks are run again on the text; the file must
 * still be the blob the proposal was made against; then the repo writer commits it, under its own rules for the person. All in one transaction.
 */
export async function applyProposal(ctx: PluginContext, tx: PluginTx, row: ProposalRow, how: { self: boolean; note?: string }): Promise<ProposalDetail> {
  if (tx.actor.kind !== 'person') throw forbidden('Only a person applies a proposal. A bot can only propose.');
  await lockProposal(tx, row.id);
  const why = (await tx.query<{ why: string | null }>('SELECT app.proposals_why_not($1::uuid, $2) AS why', [row.id, how.self])).rows[0]?.why ?? null;
  if (why !== null) throw forbidden(why);
  const checks = runChecks(row.path, row.op, row.content);
  const failed = failedChecks(checks);
  if (failed !== null) throw new HttpError(422, 'validation_failed', `A check failed, so this cannot be applied. ${failed}`);
  const repo = repoOf(ctx);
  const cur = await currentFile(tx, repo, row.team_id, row.path);
  const moved = movedReason(row, cur.blobSha);
  if (moved) throw conflict(moved);

  const change =
    row.op === 'delete'
      ? { path: row.path, op: 'delete' as const, baseBlobSha: row.base_blob_sha }
      : { path: row.path, op: 'put' as const, content: row.content ?? '', baseBlobSha: row.base_blob_sha };
  const coAuthors = row.author_id === tx.actor.id ? [] : [{ actorId: row.author_id, name: row.author_name }];
  const result = await repo
    .write(tx, row.team_id, { id: tx.actor.id, kind: 'person' }, [change], `${row.title}\n\nProposal ${row.id}`, coAuthors, { proposalId: row.id })
    .catch((err: unknown) => {
      const r = repoStatus(err);
      // The writer's own check of the blob is the safety net of the one above (a commit slipped in between).
      if (r?.status === 409) throw conflict(`${row.path} changed while this was being applied. Reload the proposal and try again.`);
      return asHttp(err);
    });
  await tx.query('SELECT app.proposals_decide($1::uuid, $2, $3, $4, $5, $6::jsonb)', [row.id, 'applied', how.note ?? '', result.sha, how.self, JSON.stringify(checks)]);
  await ctx.audit.emit(tx, {
    type: 'proposals.proposal.applied',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    proposalId: row.id,
    path: row.path,
    op: row.op,
    authorId: row.author_id,
    actorId: tx.actor.id,
    selfApplied: how.self,
    commitSha: result.sha,
    at: now(ctx),
  });
  const after = await loadProposal(tx, row.id);
  if (!after) throw new Error('the applied proposal cannot be read');
  return detailOf(ctx, tx, after);
}

/** Reject (a lead or admin other than the author) or withdraw (the author). */
export async function closeProposal(ctx: PluginContext, tx: PluginTx, row: ProposalRow, how: { reason: 'rejected' | 'withdrawn'; note?: string }): Promise<ProposalDetail> {
  await lockProposal(tx, row.id);
  await tx.query('SELECT app.proposals_decide($1::uuid, $2, $3, NULL, false, NULL)', [row.id, how.reason, how.note ?? '']);
  await ctx.audit.emit(tx, {
    type: 'proposals.proposal.rejected',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    proposalId: row.id,
    path: row.path,
    authorId: row.author_id,
    actorId: tx.actor.id,
    reason: how.reason,
    at: now(ctx),
  });
  const after = await loadProposal(tx, row.id);
  if (!after) throw new Error('the closed proposal cannot be read');
  return detailOf(ctx, tx, after);
}

export { requireProposal };
