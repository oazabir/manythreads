import { createHash } from 'node:crypto';
import type { PluginContext, PluginEvent, PluginTx, RepoProvider } from '@manythreads/sdk';
import { RepoRepoCommittedEvent } from '@manythreads/shared';
import { parseBotMd } from './bot-md.ts';

// The loader (PLAN P5-04): a `repo.repo.committed` subscription that rebuilds a team's bot from `bots/<slug>/BOT.md`, in the outbox
// consumer's system transaction, once per commit. Valid → one row, its bot actor and its compiled `mayTag` grant, then bots.bot.loaded.
// Invalid → the previous row stays live as `status = 'invalid'` and bots.bot.invalid carries the reason (the event is the alert; the row
// keeps no error column). The file deleted → the row goes, grants with it, then bots.bot.removed. A failure throws, so the outbox rolls
// everything back and retries the event: every step is an upsert or a delete, so a retry changes nothing twice.

/** `bots/<slug>/BOT.md` exactly — one folder deep, the shape the viewer's `bots/*` folder glob names (never `bots/a/b/BOT.md`). */
const BOT_MD = /^bots\/([^/]+)\/BOT\.md$/;
/** The folder name, the row's own CHECK (a folder that fails it is an invalid definition, not a silent skip). */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

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
  if (botId) await tx.query(`UPDATE app.bots SET status = 'invalid', updated_at = now() WHERE id = $1`, [botId]);
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
      message: `folder "${slug}": a bot lives in a folder named with a lowercase slug (letters, digits, ".", "_", "-")`,
    });
    return;
  }
  const parsed = parseBotMd(Buffer.from(blob.content).toString('utf8'));
  if (!parsed.ok) {
    await invalidate(ctx, tx, commit, { slug, path, definitionSha, ...parsed.failure });
    return;
  }
  const fm = parsed.frontmatter;

  const row = await tx.query<{ id: string }>(
    `INSERT INTO app.bots AS b (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
     ON CONFLICT (team_id, slug) DO UPDATE SET
       kind           = EXCLUDED.kind,
       runtime        = EXCLUDED.runtime,
       visibility     = EXCLUDED.visibility,
       definition_sha = EXCLUDED.definition_sha,
       -- a bot a lead turned off by hand stays off when its BOT.md changes; every other row loads back to active
       status         = CASE WHEN b.status = 'disabled' THEN 'disabled' ELSE 'active' END,
       placement      = EXCLUDED.placement,
       updated_at     = now()
     RETURNING id`,
    [commit.workspaceId, commit.teamId, slug, fm.kind, fm.runtime, fm.visibility ?? 'team', definitionSha, fm.placement ?? null],
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

  // Compile `handover.mayTag` into the allowlist (PLAN P5-04): the loader owns this bot's `tasks.handoff` grant — upserted while the
  // key is there, deleted the moment it leaves the file, gone with the bot. `tasks.handoff` itself is registered when the tasks plugin lands;
  // the broker refuses unknown capabilities until then, which is the safe direction.
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

/** The file is gone: the row goes too (pairing tokens and runs cascade); the actor row stays, because messages reference it. */
async function removeBot(ctx: PluginContext, tx: PluginTx, commit: Commit, slug: string): Promise<void> {
  const existing = await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [commit.teamId, slug]);
  const botId = existing.rows[0]?.id;
  if (!botId) return; // never loaded: a delete of a file the loader never saw changes nothing
  await tx.query(
    `DELETE FROM app.capability_grants
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
