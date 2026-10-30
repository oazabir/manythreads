import { createHash } from 'node:crypto';
import type { PluginContext, PluginEvent, PluginTx, RepoProvider } from '@manythreads/sdk';
import { BOT_SLUG_RE, RepoRepoCommittedEvent, botSlugProblem, parseBotMd } from '@manythreads/shared';
import { modelAliasesOf } from './backfill.ts';

// The loader (PLAN P5-04, extended by P5-10): a `repo.repo.committed` subscription that rebuilds a team's bot from `bots/<slug>/BOT.md`, in the
// outbox consumer's system transaction, once per commit. Valid → one row carrying the definition's projections (display fields, `placement`,
// `triggers`, the compiled `capabilities.native`), the bot actor, the bot's team membership and its compiled allowlist of grants, then
// bots.bot.loaded; a good load clears `invalid_reason`. Invalid → the previous row stays live as `status = 'invalid'` (a disabled bot stays
// disabled) with the reason in `invalid_reason`, and bots.bot.invalid is the alert. The file deleted → the row goes, grants and membership with
// it, then bots.bot.removed. A failure throws, so the outbox rolls everything back and retries the event: every step is an upsert or a delete,
// so a retry changes nothing twice.

/** `bots/<slug>/BOT.md` exactly — one folder deep, the shape the viewer's `bots/*` folder glob names (never `bots/a/b/BOT.md`). */
const BOT_MD = /^bots\/([^/]+)\/BOT\.md$/;
/** The folder name, the row's own CHECK (a folder that fails it is an invalid definition, not a silent skip). */
const SLUG = BOT_SLUG_RE;

interface Commit {
  workspaceId: string;
  teamId: string;
  sha: string;
}

interface InvalidInput {
  slug: string;
  path: string;
  definitionSha: string;
  fieldPath: string | null;
  message: string;
}

/** Alert on a definition that would not load; keep the previous row (as `invalid`) when there is one, make no row when there is not. */
async function invalidate(ctx: PluginContext, tx: PluginTx, commit: Commit, input: InvalidInput): Promise<void> {
  const existing = await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [commit.teamId, input.slug]);
  const botId = existing.rows[0]?.id ?? null;
  // A bot a lead turned off stays off while its file is broken (and after it is repaired): only `active` becomes `invalid`. The reason is
  // stored either way, so the page can say why the last load failed; the next good load clears it.
  if (botId) {
    await tx.query(
      `UPDATE app.bots
          SET status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'invalid' END,
              invalid_reason = $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [botId, JSON.stringify({ fieldPath: input.fieldPath, message: input.message, at: new Date().toISOString(), definitionSha: input.definitionSha })],
    );
  }
  await ctx.audit.emit(tx, {
    type: 'bots.bot.invalid',
    workspaceId: commit.workspaceId,
    teamId: commit.teamId,
    botId,
    slug: input.slug,
    path: input.path,
    definitionSha: input.definitionSha,
    fieldPath: input.fieldPath,
    message: input.message,
  });
}

/**
 * Compile the definition's `capabilities.native` into the bot's `capability_grants` (PLAN P5-10). The list is written as it stands — `messages.*`
 * stays a namespace grant, which the broker's lookup understands — and `approvals.needsApproval` sets `needs_approval` on the grants it names, so a
 * bot author can say "this call waits for a person" in the file. Entries the previous load compiled and this one dropped are deleted; a capability
 * the file never mentioned is left alone (another plugin may own it). `tasks.handoff` is compiled by this loader too but from `handover.mayTag`,
 * after this, so `mayTag` stays its single source.
 */
async function compileNative(
  tx: PluginTx,
  actorId: string,
  teamId: string,
  native: readonly string[],
  needsApproval: ReadonlySet<string>,
  previousNative: readonly string[],
): Promise<void> {
  const desired = new Set(native);
  const dropped = previousNative.filter((c) => !desired.has(c));
  if (dropped.length > 0) {
    await tx.query('DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = ANY ($2::text[])', [actorId, dropped]);
  }
  for (const capability of desired) {
    await tx.query(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)
       ON CONFLICT (actor_id, capability) DO UPDATE SET team_id = EXCLUDED.team_id, needs_approval = EXCLUDED.needs_approval`,
      [teamId, actorId, capability, needsApproval.has(capability)],
    );
  }
}

/** One file changed: read it at the commit, parse strictly, then upsert or alert. */
async function loadBot(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string, path: string): Promise<void> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');
  const blob = await repo.blob(tx, commit.teamId, path, commit.sha);
  const definitionSha = createHash('sha256').update(blob.content).digest('hex');

  if (!SLUG.test(slug)) {
    await invalidate(ctx, tx, commit, {
      slug,
      path,
      definitionSha,
      fieldPath: 'slug',
      message: botSlugProblem(slug),
    });
    return;
  }
  const parsed = parseBotMd(Buffer.from(blob.content).toString('utf8'));
  if (!parsed.ok) {
    await invalidate(ctx, tx, commit, { slug, path, definitionSha, ...parsed.failure });
    return;
  }
  const fm = parsed.frontmatter;
  const native = fm.capabilities?.native ?? [];
  const triggers = fm.triggers ?? [];
  // the bases the bot may search, and which of them it answers only from (the knowledge tool reads this projection)
  const knowledge = (fm.knowledge ?? []).map((k) => ({ base: k.base, answer_only_from: k.answer_only_from === true }));
  // What the previous load compiled: the grants this one has to resync. Read after the parse, so an invalid file changes nothing.
  const previousNative = (
    await tx.query<{ native: string[] }>('SELECT native FROM app.bots WHERE team_id = $1 AND slug = $2', [commit.teamId, slug])
  ).rows[0]?.native ?? [];

  const row = await tx.query<{ id: string }>(
    `INSERT INTO app.bots AS b (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, may_tag, triggers, native, model_aliases, approvers, run_timeout_seconds, run_timeout_known, knowledge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12::jsonb, $13::jsonb, $14::text[], $15::text[], $16, true, $17::jsonb)
     ON CONFLICT (team_id, slug) DO UPDATE SET
       -- the display fields follow the definition (PLAN P5-05): the roster draws the row, never the file
       name           = EXCLUDED.name,
       role           = EXCLUDED.role,
       may_tag        = EXCLUDED.may_tag,
       kind           = EXCLUDED.kind,
       runtime        = EXCLUDED.runtime,
       visibility     = EXCLUDED.visibility,
       definition_sha = EXCLUDED.definition_sha,
       -- a bot a lead turned off by hand stays off when its BOT.md changes; every other row loads back to active
       status         = CASE WHEN b.status = 'disabled' THEN 'disabled' ELSE 'active' END,
       invalid_reason = NULL,
       placement      = EXCLUDED.placement,
       triggers       = EXCLUDED.triggers,
       native         = EXCLUDED.native,
       model_aliases  = EXCLUDED.model_aliases,
       approvers      = EXCLUDED.approvers,
       run_timeout_seconds = EXCLUDED.run_timeout_seconds,
       run_timeout_known = true,
       knowledge      = EXCLUDED.knowledge,
       updated_at     = now()
     RETURNING id`,
    [
      commit.workspaceId,
      commit.teamId,
      slug,
      fm.name,
      fm.role,
      fm.kind,
      fm.runtime,
      fm.visibility ?? 'team',
      definitionSha,
      fm.placement ?? null,
      fm.handover?.mayTag ?? [],
      JSON.stringify(triggers),
      JSON.stringify(native),
      // The aliases the definition may ask for, then its own fallbacks: what the gateway limits the bot's key to.
      modelAliasesOf(fm.model),
      // who may decide this bot's approvals (`role:<tag>` / `person:<id>`); empty means the team's leads
      fm.approvals?.approvers ?? [],
      // BOT.md `limits.timeoutSeconds`: what the stale-run reaper measures a run against
      fm.limits?.timeoutSeconds === undefined ? null : Math.min(fm.limits.timeoutSeconds, 604_800),
      JSON.stringify(knowledge),
    ],
  );
  const botId = row.rows[0]!.id;

  // The bot's actor: one row per bots row, found or made (the unique (workspace, kind, ref) means races converge).
  const actor = await ctx.db.getOneOrCreate<{ id: string }>(tx, {
    table: 'app.actors',
    values: { kind: 'bot', workspace_id: commit.workspaceId, ref_id: botId },
    conflict: ['workspace_id', 'kind', 'ref_id'],
    returning: ['id'],
  });
  const actorId = actor.id;

  // The bot is a member of its team (`team_members` is the roster of people *and* bots, kernel 0006). That one row is what gives a bot its
  // team's public channels: `app.readable_team_ids` and `app.visible_channel_ids` speak of members, and a bot's reply lands in the thread
  // it was asked in because it may post where its team may. Never a private channel or a DM — those are membership rows per channel.
  await ctx.db.getOneOrCreate<{ actor_id: string }>(tx, {
    table: 'app.team_members',
    values: { team_id: commit.teamId, actor_id: actorId, workspace_id: commit.workspaceId, role: 'member' },
    conflict: ['team_id', 'actor_id'],
    returning: ['actor_id'],
  });

  // The definition's own allowlist, then `handover.mayTag` — which owns `tasks.handoff` alone.
  await compileNative(tx, actorId, commit.teamId, native, new Set(fm.approvals?.needsApproval ?? []), previousNative);

  const mayTag = fm.handover?.mayTag ?? [];
  if (mayTag.length > 0) {
    await tx.query(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, constraints)
       VALUES ($1, $2, 'tasks.handoff', jsonb_build_object('mayTag', $3::jsonb))
       ON CONFLICT (actor_id, capability) DO UPDATE SET team_id = EXCLUDED.team_id, constraints = EXCLUDED.constraints`,
      [commit.teamId, actorId, JSON.stringify(mayTag)],
    );
  } else {
    await tx.query(`DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = 'tasks.handoff'`, [actorId]);
  }

  await ctx.audit.emit(tx, {
    type: 'bots.bot.loaded',
    workspaceId: commit.workspaceId,
    teamId: commit.teamId,
    botId,
    slug,
    path,
    definitionSha,
    mayTag,
  });
}

/** The file is gone: the row goes too (pairing tokens, runs and the team membership cascade); the actor row stays, because messages reference it. */
async function removeBot(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string): Promise<void> {
  const existing = await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [commit.teamId, slug]);
  const botId = existing.rows[0]?.id;
  if (!botId) return; // never loaded: a delete of a file the loader never saw changes nothing
  await tx.query(
    `DELETE FROM app.capability_grants
      WHERE actor_id IN (SELECT id FROM app.actors WHERE kind = 'bot' AND workspace_id = $1 AND ref_id = $2)`,
    [commit.workspaceId, botId],
  );
  // The membership is the loader's own row (the bots table cascades, team_members does not reference it).
  await tx.query(
    `DELETE FROM app.team_members
      WHERE actor_id IN (SELECT id FROM app.actors WHERE kind = 'bot' AND workspace_id = $1 AND ref_id = $2)`,
    [commit.workspaceId, botId],
  );
  await tx.query('DELETE FROM app.bots WHERE id = $1', [botId]);
  await ctx.audit.emit(tx, { type: 'bots.bot.removed', workspaceId: commit.workspaceId, teamId: commit.teamId, botId, slug });
}

/** Wire the one subscription. Runs as the system actor in the outbox consumer (docs/plugins/README.md "Event subscribers"). */
export function registerBotLoader(ctx: PluginContext): void {
  ctx.events.subscribe('repo.repo.committed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = RepoRepoCommittedEvent.parse(raw);
    for (const change of event.paths) {
      const match = BOT_MD.exec(change.path);
      if (!match) continue;
      const commit: Commit = { workspaceId: event.workspaceId, teamId: event.teamId, sha: event.sha };
      if (change.op === 'delete') await removeBot(ctx, tx, commit, match[1]!);
      else await loadBot(ctx, tx, commit, match[1]!, change.path);
    }
  });
}
