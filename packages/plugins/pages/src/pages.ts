import type { PluginContext, PluginTx, RepoProvider, RepoWriteChange, RepoWriteResult } from '@manythreads/sdk';
import { PAGES_DIR, WritePageRequest, isGuardedRepoPath, type PageWriteMode, type RepoConflict } from '@manythreads/shared';

// `pages.write` (SPEC section 6.4, PLAN P4-07): create, replace or append a page, which is a text file under `pages/` of the team repo. Plain file write plus
// commit through the repo writer (one commit per call, the caller as author); live editing with Yjs replaces the writer in phase 6.
//
// Who may: a person who may post in the team (the writer checks the team role); a bot only with a `pages.write` grant, and never on `bots/`, `TEAM.md`,
// `skills/` or `routines/` (the broker's path guard, audited as `kernel.capability.denied`). Those four paths are refused for everybody here: pages.write
// writes pages, and a change to the team's configuration goes through the commit route (leads and admins) or a pull request.

export type PageRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 422 | 503;
  code: string;
  message: string;
  conflicts?: RepoConflict[];
};
export type PageWritten = { ok: true; created: boolean; mode: PageWriteMode; result: RepoWriteResult; blobSha: string | null; size: number | null };
export type PageOutcome = PageWritten | PageRefusal;

export const refuse = (status: PageRefusal['status'], code: string, message: string, conflicts?: RepoConflict[]): PageRefusal => ({
  ok: false,
  status,
  code,
  message,
  ...(conflicts ? { conflicts } : {}),
});

const defaultMessage = (mode: PageWriteMode, path: string): string =>
  mode === 'create' ? `Create page ${path}` : mode === 'replace' ? `Replace page ${path}` : `Append to page ${path}`;

/** The team the caller can see, by slug or id. 403 for one they cannot see (an admin sees every team, so for them a missing one is 404). */
async function findTeam(tx: PluginTx, team: string): Promise<{ id: string } | PageRefusal> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(team);
  const res = await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE ${byId ? 'id' : 'slug'} = $1`, [team]);
  const row = res.rows[0];
  if (row) return row;
  const admin = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
  return admin.rows[0]?.admin === true ? refuse(404, 'not_found', 'Team not found') : refuse(403, 'forbidden', 'You are not a member of this team');
}

/** What the repo writer rejects with (`RepoError`): a status, a code and, on a 409, the current content of each path. */
function refusalOf(err: unknown): PageRefusal | null {
  const e = err as { name?: string; status?: number; code?: string; message?: string; conflicts?: RepoConflict[] };
  if (e?.name !== 'RepoError' || typeof e.status !== 'number') return null;
  if (![400, 403, 404, 409, 413, 422].includes(e.status)) return null;
  return refuse(e.status as PageRefusal['status'], e.code ?? 'validation_failed', e.message ?? 'Refused', e.conflicts && e.conflicts.length > 0 ? [...e.conflicts] : undefined);
}

export interface WritePageInput {
  /** The team's slug or id. */
  team: string;
  request: WritePageRequest;
}

/**
 * Writes the page as the actor of `tx`. Refusals are returned (not thrown) so the caller can answer with them without rolling the transaction back: a
 * refused request wrote nothing, and what the broker logged for a denied bot is in its own transaction anyway.
 */
export async function writePage(ctx: PluginContext, tx: PluginTx, input: WritePageInput): Promise<PageOutcome> {
  const { mode, path, content, baseBlobSha, message } = input.request;
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return refuse(503, 'internal', 'The team repository is not available');
  const team = await findTeam(tx, input.team);
  if ('ok' in team) return team;

  // The broker first: a bot's denial (path guard, no grant, needs approval) is logged there.
  const decision = await ctx.capabilities.authorize(tx, 'pages.write', { path });
  if (!decision.allowed) return refuse(403, 'forbidden', decision.reason);
  if (decision.needsApproval) return refuse(403, 'forbidden', `Writing "${path}" needs a person's approval`);
  if (isGuardedRepoPath(path)) {
    return refuse(403, 'forbidden', 'Change by pull request: pages.write does not change bots/, TEAM.md, skills/ or routines/');
  }
  if (!path.startsWith(`${PAGES_DIR}/`)) return refuse(400, 'validation_failed', `pages.write writes under ${PAGES_DIR}/ (for example pages/reports/week-37.md)`);

  const change: RepoWriteChange =
    mode === 'append'
      ? { path, op: 'append', content }
      : mode === 'create'
        ? { path, op: 'put', content, baseBlobSha: null }
        : { path, op: 'put', content, ...(baseBlobSha ? { baseBlobSha } : {}) };
  try {
    const result = await repo.write(
      tx,
      team.id,
      { id: tx.actor.id, kind: tx.actor.kind },
      [change],
      message ?? defaultMessage(mode, path),
      [],
      { capability: 'pages.write' },
    );
    const written = result.paths.find((p) => p.path === path);
    const outcome: PageWritten = { ok: true, created: mode === 'create', mode, result, blobSha: written?.blobSha ?? null, size: written?.size ?? null };
    if (!result.noop && written?.blobSha) {
      await ctx.audit.emit(tx, {
        type: 'pages.page.written',
        teamId: team.id,
        path,
        mode,
        sha: result.sha,
        blobSha: written.blobSha,
        size: written.size ?? 0,
        authorId: tx.actor.id,
        actorKind: tx.actor.kind,
      });
    }
    return outcome;
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return refusal;
    throw err;
  }
}
