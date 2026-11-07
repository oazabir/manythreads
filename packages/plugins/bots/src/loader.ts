import { createHash } from 'node:crypto';
import { botPlacementProblem, type BotRunnersProvider, type PluginContext, type PluginEvent, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import { BOT_SLUG_RE, RepoRepoCommittedEvent, botSlugProblem, parseBotMd } from '@manythreads/shared';
import { newBotAvatar } from './avatar.ts';
import { modelAliasesOf } from './backfill.ts';
import { connectionEntries } from './connection-entries.ts';

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

/**
 * Where a definition lands: a team's bot (`teamId` set, the row is unique by (team, slug)) or the workspace bot (`teamId` null, unique by (workspace, slug)
 * among `scope = 'workspace'` rows; P20-07). The workspace bot has no team, so it emits none of the team-keyed bots events.
 */
interface Target {
  workspaceId: string;
  teamId: string | null;
}

const lookupBot = (target: Target, columns: string): { sql: string; params: string[] } =>
  target.teamId === null
    ? { sql: `SELECT ${columns} FROM app.bots WHERE workspace_id = $1 AND scope = 'workspace' AND slug = $2`, params: [target.workspaceId] }
    : { sql: `SELECT ${columns} FROM app.bots WHERE team_id = $1 AND slug = $2`, params: [target.teamId] };

interface InvalidInput {
  slug: string;
  path: string;
  definitionSha: string;
  fieldPath: string | null;
  message: string;
}

/** Alert on a definition that would not load; keep the previous row (as `invalid`) when there is one, make no row when there is not. */
async function invalidate(ctx: PluginContext, tx: PluginTx, commit: Target, input: InvalidInput): Promise<void> {
  const q = lookupBot(commit, 'id');
  const existing = await tx.query<{ id: string }>(q.sql, [...q.params, input.slug]);
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
  if (commit.teamId === null) return; // the workspace bot: the reason is on the row; the team-keyed alert event has no team to name
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
  await applyDefinition(ctx, tx, { workspaceId: commit.workspaceId, teamId: commit.teamId }, slug, path, blob.content);
  // A team made from a template still ships a Brain of its own; once the workspace Brain is active it is switched off the moment it loads (it stays, with its history).
  if (slug === WORKSPACE_BRAIN_SLUG) await retireTeamBrains(tx, commit.workspaceId);
}

/**
 * Parse one definition and write the bot it describes (the row, its actor, its memberships, its grants). Shared by the team loader (the file read at a commit) and the
 * workspace loader (the stored text): the steps are the same, only the lookup of the row, the memberships and the events differ with the target.
 */
async function applyDefinition(ctx: PluginContext, tx: PluginTx, target: Target, slug: string, path: string, content: Uint8Array): Promise<boolean> {
  const commit = target;
  const definitionSha = createHash('sha256').update(content).digest('hex');

  if (!SLUG.test(slug)) {
    await invalidate(ctx, tx, commit, {
      slug,
      path,
      definitionSha,
      fieldPath: 'slug',
      message: botSlugProblem(slug),
    });
    return false;
  }
  const parsed = parseBotMd(Buffer.from(content).toString('utf8'));
  if (!parsed.ok) {
    await invalidate(ctx, tx, commit, { slug, path, definitionSha, ...parsed.failure });
    return false;
  }
  const fm = parsed.frontmatter;
  // the workspace bot is read by the whole workspace: the table says so (bots_scope_visibility), the definition must too
  if (commit.teamId === null && fm.visibility !== 'workspace') {
    await invalidate(ctx, tx, commit, { slug, path, definitionSha, fieldPath: 'visibility', message: 'The workspace bot must say `visibility: workspace`.' });
    return false;
  }
  // `placement.runs_on` names a runner an admin set up (P19-03): it must exist and the team must be allowed to use it. A miss is an invalid definition with the reason on the bot,
  // never a half row. The question is asked on this transaction (a subscriber must not read on a connection of its own). A runner that is switched off is not a miss: that is judged when a run starts.
  // (The workspace bot belongs to no team: its runner is judged against the context team when a run starts.)
  const placementProblem = commit.teamId === null ? null : await botPlacementProblem(ctx.providers.get<BotRunnersProvider>('bot.runners'), tx, { teamId: commit.teamId, frontmatter: fm });
  if (placementProblem !== null) {
    await invalidate(ctx, tx, commit, { slug, path, definitionSha, fieldPath: 'placement.runs_on', message: placementProblem });
    return false;
  }
  const native = fm.capabilities?.native ?? [];
  const triggers = fm.triggers ?? [];
  // the bases the bot may search, and which of them it answers only from (the knowledge tool reads this projection)
  const knowledge = (fm.knowledge ?? []).map((k) => ({ base: k.base, answer_only_from: k.answer_only_from === true }));
  // the connections the definition asks for and the tools it wants from each: the connections plugin compiles them into grants (the column grants nothing by itself)
  // (`approvals.needsApproval` is applied here too: the tools of the entry that wait for a person)
  const connections = connectionEntries(fm);
  // What the previous load compiled: the grants this one has to resync. Read after the parse, so an invalid file changes nothing.
  const previousQuery = lookupBot(commit, 'native');
  const previous = (await tx.query<{ native: string[] }>(previousQuery.sql, [...previousQuery.params, slug])).rows[0];
  const previousNative = previous?.native ?? [];
  // The picture (P14-24) is chosen only for a row that does not exist yet and is not in the conflict's update list below: a reload never re-rolls it, and a
  // picture a person chose (or "use initials") stays as it is.
  const avatar = previous === undefined ? newBotAvatar(slug) : null;

  const row = await tx.query<{ id: string }>(
    `INSERT INTO app.bots AS b (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, may_tag, triggers, native, model_aliases, approvers, run_timeout_seconds, run_timeout_known, knowledge, avatar, connections, scope)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12::jsonb, $13::jsonb, $14::text[], $15::text[], $16, true, $17::jsonb, $18::text, $19::jsonb, $20)
     ON CONFLICT ${commit.teamId === null ? "(workspace_id, slug) WHERE scope = 'workspace'" : '(team_id, slug)'} DO UPDATE SET
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
       connections    = EXCLUDED.connections,
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
      avatar,
      JSON.stringify(connections),
      commit.teamId === null ? 'workspace' : 'team',
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
  if (commit.teamId === null) {
    await joinEveryTeam(tx, commit.workspaceId, actorId);
  } else {
    await ctx.db.getOneOrCreate<{ actor_id: string }>(tx, {
      table: 'app.team_members',
      values: { team_id: commit.teamId, actor_id: actorId, workspace_id: commit.workspaceId, role: 'member' },
      conflict: ['team_id', 'actor_id'],
      returning: ['actor_id'],
    });
  }
  // `capability_grants.team_id` is required: the workspace bot's grants carry the WORKSPACE id there (every reader of grants looks them up by actor and capability, as the system).
  const grantTeam = commit.teamId ?? commit.workspaceId;

  // The definition's own allowlist, then `handover.mayTag` — which owns `tasks.handoff` alone.
  await compileNative(tx, actorId, grantTeam, native, new Set(fm.approvals?.needsApproval ?? []), previousNative);

  // `tasks.handoff` is compiled from `handover`: `mayTag` (bots, by slug) and `toPerson` (people: `person:<id>` or `role:<tag>`, resolved by the tasks plugin
  // through the teams plugin's role groups, P14-03). Neither listed: no grant.
  const mayTag = fm.handover?.mayTag ?? [];
  const toPerson = fm.handover?.toPerson ?? [];
  if (mayTag.length > 0 || toPerson.length > 0) {
    await tx.query(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, constraints)
       VALUES ($1, $2, 'tasks.handoff', jsonb_build_object('mayTag', $3::jsonb, 'toPerson', $4::jsonb))
       ON CONFLICT (actor_id, capability) DO UPDATE SET team_id = EXCLUDED.team_id, constraints = EXCLUDED.constraints`,
      [grantTeam, actorId, JSON.stringify(mayTag), JSON.stringify(toPerson)],
    );
  } else {
    await tx.query(`DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = 'tasks.handoff'`, [actorId]);
  }

  if (commit.teamId === null) return true; // no team to name in the team-keyed event (the row, the actor and the grants are the record)
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
  return true;
}

export const WORKSPACE_BRAIN_SLUG = 'brain';

/**
 * Switch off the team Brains the workspace Brain replaces. Only an `active` or `invalid` team bot named `brain` is touched, and only once the workspace Brain is active; the
 * row, its runs, conversations and memory stay. Returns how many were retired.
 */
export async function retireTeamBrains(tx: PluginTx, workspaceId: string): Promise<number> {
  const res = await tx.query(
    `UPDATE app.bots t SET status = 'disabled', retired_at = now(), updated_at = now()
      WHERE t.workspace_id = $1::uuid AND t.scope = 'team' AND t.slug = $2 AND t.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM app.bots w WHERE w.workspace_id = t.workspace_id AND w.scope = 'workspace' AND w.slug = $2 AND w.status = 'active')
      RETURNING t.id`,
    [workspaceId, WORKSPACE_BRAIN_SLUG],
  );
  return res.rows.length;
}

/** The workspace bot is a member of every live team of the workspace: that row is what lets it post where the team may (a bot's reply lands in the channel it was asked in). */
async function joinEveryTeam(tx: PluginTx, workspaceId: string, actorId: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role)
     SELECT t.id, $2::uuid, $1::uuid, 'member' FROM app.teams t WHERE t.workspace_id = $1::uuid AND t.archived_at IS NULL
     ON CONFLICT (team_id, actor_id) DO NOTHING`,
    [workspaceId, actorId],
  );
}

/**
 * Load the workspace bot (P20-07, `scope = 'workspace'`): store BOT.md text as the next version of `app.workspace_bot_definitions` (when it differs from the newest) and rebuild
 * the bot row, its actor, its membership in every team and its grants, exactly as the team loader does for a file. `slug` is the folder name a team would have used (`brain`).
 * Returns the bot's id, or null when the definition is invalid (the previous row stays, as `invalid`, with the reason on it).
 */
export async function loadWorkspaceBot(
  ctx: PluginContext,
  tx: PluginTx,
  input: { workspaceId: string; slug: string; content: string; authorActorId?: string | null },
): Promise<string | null> {
  const bytes = Buffer.from(input.content, 'utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const newest = (
    await tx.query<{ version: number; sha: string }>(
      'SELECT version, sha FROM app.workspace_bot_definitions WHERE workspace_id = $1 AND slug = $2 ORDER BY version DESC LIMIT 1',
      [input.workspaceId, input.slug],
    )
  ).rows[0];
  // A definition is kept as a version only once it has loaded (nothing runs from an invalid text); an invalid one leaves the previous bot as it was, with the reason on it.
  const loaded = await applyDefinition(ctx, tx, { workspaceId: input.workspaceId, teamId: null }, input.slug, `workspace:${input.slug}`, bytes);
  if (!loaded) return null;
  if (newest?.sha !== sha) {
    await tx.query(
      'INSERT INTO app.workspace_bot_definitions (workspace_id, slug, version, sha, content, author_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [input.workspaceId, input.slug, (newest?.version ?? 0) + 1, sha, input.content, input.authorActorId ?? null],
    );
  }
  const q = lookupBot({ workspaceId: input.workspaceId, teamId: null }, 'id');
  const row = (await tx.query<{ id: string }>(q.sql, [...q.params, input.slug])).rows[0];
  return row?.id ?? null;
}

/** A team was made (or a bot re-loaded): the workspace bots join it, so they can post in its channels. */
export async function joinNewTeam(tx: PluginTx, workspaceId: string, teamId: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role)
     SELECT $2::uuid, a.id, $1::uuid, 'member'
       FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
      WHERE b.workspace_id = $1::uuid AND b.scope = 'workspace' AND b.team_id IS NULL
     ON CONFLICT (team_id, actor_id) DO NOTHING`,
    [workspaceId, teamId],
  );
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
