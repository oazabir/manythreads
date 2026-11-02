import { json, notFound, forbidden, requireTeam, route, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import {
  BotRunnerAvailabilityChangedEvent,
  BotRunnerCreatedEvent,
  BotRunnerDeletedEvent,
  BotRunnerUpdatedEvent,
  BotRunnerDefaultChangedEvent,
  BotsEvalRunFinishedEvent,
  CloseReassessmentRequest,
  CloseReassessmentResponse,
  KnowledgeBaseCreatedEvent,
  KnowledgeBaseDeletedEvent,
  ReassessmentListResponse,
  ReassessmentParams,
  Reassessment,
  ReplayBotParams,
  closeReassessmentRoute,
  listReassessmentsRoute,
  type ReassessmentReason,
} from '@manythreads/shared';
import { askerRole } from './inventory.ts';
import { botOf } from './wroutes.ts';

// Re-assessment (PLAN P7-07): when something a bot depends on changes, the bot gets one notice that says what happened and what to look at again. Filed by subscribers of the
// platform's own events, as the system role, from fixed text: NO model is called, so a flapping runner costs nothing. A lead or an admin reads the open notices (the Workshop's Live
// mode) and closes each one. What counts as "a bot depends on it":
//   a knowledge base   the bot's BOT.md lists it (`knowledge:`), or lists none (then it searches every base of its team), created (it now exists) or deleted (it is gone);
//   a runner           the bot's BOT.md names it (`placement.runs_on`): created, deleted, switched off or limited to other teams, or changed (address, key, node, model, rule);
//   the default runner the bots that name no place at all run on it;
//   an eval score      the bot's latest test run is lower than the one before it of the same set and mode (a first run, or a run of another mode, files nothing);
//   a connection       to another app: there are none in this release (Phase 8), so nothing files these two reasons yet. The reasons and their texts exist so that the connection
//                      events plug in with one subscription.

/** Bots read per page when an event touches many bots. There is no cap: a page is read after the last one until none is left. */
const PAGE = 500;

/** `lists_bases` is false for a bot whose BOT.md lists no knowledge base: it searches every base of its team. */
type BotTarget = { id: string; workspace_id: string; team_id: string; slug: string; lists_bases?: boolean };

const quoted = (name: string): string => `“${name}”`;
const percent = (score: number): string => `${String(Math.round(score * 100))}%`;

/** The headline and the list of things to look at again, for a reason. Fixed text built from names and numbers; pure, so it is tested without a database. */
export function describeReassessment(
  reason: ReassessmentReason,
  subject: string,
  scores?: { now: number | null; before: number | null; min: number },
  searchesAll = false,
): { headline: string; checks: string[] } {
  switch (reason) {
    case 'knowledge_added':
      return {
        headline: searchesAll
          ? `A new knowledge base ${quoted(subject)} now exists in this team. This bot lists none, so it searches every base of its team, including this one.`
          : `The knowledge base ${quoted(subject)}, which this bot lists, now exists.`,
        checks: [
          'Ask the bot a question that base should answer and see that the answer uses it.',
          'Check the “answer only from” setting for this base in the bot’s settings.',
          'Run the bot’s tests again.',
        ],
      };
    case 'knowledge_removed':
      return {
        headline: searchesAll
          ? `The knowledge base ${quoted(subject)} was deleted. This bot lists none, so it searched every base of its team, including this one.`
          : `The knowledge base ${quoted(subject)}, which this bot lists, was deleted.`,
        checks: [
          'Ask the bot something that used to come from that base. It should say it does not know, not guess.',
          'Take the base out of the bot’s settings, or point the bot at another one.',
          'Run the bot’s tests again.',
        ],
      };
    case 'runner_added':
      return {
        headline: `The runner ${quoted(subject)}, which this bot is set to run on, now exists.`,
        checks: [
          'Send the bot a test message and see that it answers.',
          'Check that the model and the limits of that runner suit this bot.',
          'Rehearse a typical task in the Workshop.',
        ],
      };
    case 'runner_revoked':
      return {
        headline: `The runner ${quoted(subject)}, which this bot runs on, was removed, switched off or closed to this team.`,
        checks: [
          'Until the bot has a place to run, its runs are refused. Pick another place in its settings, or ask an admin to bring the runner back.',
          'Send the bot a test message once it has a place to run.',
          'Run the bot’s tests again.',
        ],
      };
    case 'runner_changed':
      return {
        headline: `The runner ${quoted(subject)}, which this bot runs on, was changed.`,
        checks: [
          'Send the bot a test message and see that it answers.',
          'Compare a few answers with earlier ones: a changed model can answer differently.',
          'Run the bot’s tests again.',
        ],
      };
    case 'connection_added':
      return {
        headline: `A connection to ${quoted(subject)}, which this bot uses, was added.`,
        checks: ['Check what the bot may now do through it.', 'Rehearse a task that uses it. Every write is held back in a rehearsal.', 'Run the bot’s tests again.'],
      };
    case 'connection_revoked':
      return {
        headline: `A connection to ${quoted(subject)}, which this bot uses, was taken away.`,
        checks: ['Find the tasks that needed it. They will fail or be refused now.', 'Change the bot’s instructions so it does not depend on it, or restore the connection.', 'Run the bot’s tests again.'],
      };
    case 'eval_dropped': {
      const now = scores?.now;
      const before = scores?.before;
      const headline =
        now !== null && now !== undefined && before !== null && before !== undefined
          ? `The bot’s test score dropped from ${percent(before)} to ${percent(now)}.`
          : 'The bot’s test score dropped.';
      return {
        headline,
        checks: [
          'Open the latest test run and read which cases failed.',
          'Look at what changed since the last good run: the bot’s settings, its lessons, a knowledge base or the runner.',
          'Rehearse a failing case in the Workshop and correct the reply.',
        ],
      };
    }
  }
}

/** Files one notice for each bot (skipping a bot that already has the same one open) and says so with an event. */
async function fileFor(ctx: PluginContext, tx: PluginTx, bots: readonly BotTarget[], reason: ReassessmentReason, subject: string, scores?: Parameters<typeof describeReassessment>[2]): Promise<number> {
  let filed = 0;
  for (const bot of bots) {
    const text = describeReassessment(reason, subject, scores, bot.lists_bases === false);
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_reassessments (workspace_id, team_id, bot_id, reason, subject, headline, checks)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)
         ON CONFLICT (bot_id, reason, subject) WHERE status = 'open' DO NOTHING
         RETURNING id`,
        [bot.workspace_id, bot.team_id, bot.id, reason, subject.slice(0, 100), text.headline.slice(0, 200), JSON.stringify(text.checks)],
      )
    ).rows[0];
    if (!row) continue;
    filed += 1;
    await ctx.audit.emit(tx, {
      type: 'workshop.reassessment.created',
      schemaVersion: 1,
      workspaceId: bot.workspace_id,
      teamId: bot.team_id,
      botId: bot.id,
      slug: bot.slug,
      reassessmentId: row.id,
      reason,
      subject: subject.slice(0, 100),
      at: ctx.runtime.now().toISOString(),
    });
  }
  return filed;
}

const ACTIVE = "status = 'active'";

/** Every bot a query matches, read a page at a time in id order (no bot is left out for being the 201st). `where` uses $1 and $2 of `params`; $3 is the last id seen. */
async function allBots(tx: PluginTx, where: string, params: readonly [string, string | null]): Promise<BotTarget[]> {
  const out: BotTarget[] = [];
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = (
      await tx.query<BotTarget>(
        `SELECT id, workspace_id, team_id, slug, (knowledge IS NOT NULL AND jsonb_array_length(knowledge) > 0) AS lists_bases FROM app.bots
          WHERE ${ACTIVE} AND (${where}) AND id > $3::uuid ORDER BY id LIMIT ${String(PAGE)}`,
        [params[0], params[1], last],
      )
    ).rows;
    out.push(...page);
    if (page.length < PAGE) return out;
    last = (page[page.length - 1] as BotTarget).id;
  }
}

/**
 * Bots of a team that search the knowledge base: the ones whose BOT.md lists it, and the ones that list none (a bot with no list searches every base of its
 * team, `runScope` in the knowledge plugin), so a base that appears or goes away changes what they can find.
 */
async function botsListing(tx: PluginTx, teamId: string, slug: string): Promise<BotTarget[]> {
  return allBots(tx, `team_id = $1::uuid AND (knowledge IS NULL OR jsonb_array_length(knowledge) = 0 OR knowledge @> jsonb_build_array(jsonb_build_object('base', $2::text)))`, [teamId, slug]);
}

/** Bots of a workspace whose BOT.md names the runner. */
async function botsOnRunner(tx: PluginTx, workspaceId: string, runner: string): Promise<BotTarget[]> {
  return allBots(tx, "workspace_id = $1::uuid AND placement ->> 'runs_on' = $2", [workspaceId, runner]);
}

/** Bots of a workspace that name no place to run at all: they follow the workspace's default runner. */
async function botsOnDefault(tx: PluginTx, workspaceId: string): Promise<BotTarget[]> {
  return allBots(
    tx,
    "workspace_id = $1::uuid AND $2::text IS NULL AND (placement IS NULL OR (placement ->> 'runs_on' IS NULL AND placement ->> 'gateway' IS NULL AND placement ->> 'node' IS NULL AND placement ->> 'runner' IS NULL))",
    [workspaceId, null],
  );
}

/** The changes of a runner that matter to a bot running on it. A new label alone does not. */
const RUNNER_CHANGES_THAT_MATTER = new Set(['address', 'key', 'profile_rule', 'node', 'model_alias', 'enabled']);

export function registerReassessmentSubscribers(ctx: PluginContext): void {
  ctx.events.subscribe('knowledge.base.created', async (raw: PluginEvent, tx: PluginTx) => {
    const e = KnowledgeBaseCreatedEvent.parse(raw);
    await fileFor(ctx, tx, await botsListing(tx, e.teamId, e.slug), 'knowledge_added', e.slug);
  });
  ctx.events.subscribe('knowledge.base.deleted', async (raw: PluginEvent, tx: PluginTx) => {
    const e = KnowledgeBaseDeletedEvent.parse(raw);
    await fileFor(ctx, tx, await botsListing(tx, e.teamId, e.slug), 'knowledge_removed', e.slug);
  });
  ctx.events.subscribe('bot_runner.runner.created', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotRunnerCreatedEvent.parse(raw);
    await fileFor(ctx, tx, await botsOnRunner(tx, e.workspaceId, e.name), 'runner_added', e.name);
  });
  ctx.events.subscribe('bot_runner.runner.deleted', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotRunnerDeletedEvent.parse(raw);
    await fileFor(ctx, tx, await botsOnRunner(tx, e.workspaceId, e.name), 'runner_revoked', e.name);
  });
  ctx.events.subscribe('bot_runner.runner.updated', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotRunnerUpdatedEvent.parse(raw);
    if (!e.changed.some((c) => RUNNER_CHANGES_THAT_MATTER.has(c))) return;
    await fileFor(ctx, tx, await botsOnRunner(tx, e.workspaceId, e.name), 'runner_changed', e.name);
  });
  ctx.events.subscribe('bot_runner.availability.changed', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotRunnerAvailabilityChangedEvent.parse(raw);
    // switched off, or limited to a list of teams (a bot of another team may have lost it: the notice says what to check): revoked. Opened to every team: changed.
    const narrowed = !e.enabled || !e.allTeams;
    await fileFor(ctx, tx, await botsOnRunner(tx, e.workspaceId, e.name), narrowed ? 'runner_revoked' : 'runner_changed', e.name);
  });
  ctx.events.subscribe('bot_runner.default.changed', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotRunnerDefaultChangedEvent.parse(raw);
    await fileFor(ctx, tx, await botsOnDefault(tx, e.workspaceId), 'runner_changed', 'default runner');
  });
  ctx.events.subscribe('bots.eval.run.finished', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotsEvalRunFinishedEvent.parse(raw);
    if (e.status !== 'finished' || e.score === null) return;
    // The run before this one of the SAME set in the SAME mode that reached a score (ids are time-ordered, so "before" is a smaller id). A free (static) score and a
    // model score measure different things, so a model run of 90% followed by a free run of 50% is not a drop. A bot's first run files nothing, whatever its score:
    // there is nothing to have dropped from (the Evals tab already shows a run that is under the minimum).
    const before = (
      await tx.query<{ score: number }>(
        "SELECT score FROM app.bot_eval_runs WHERE bot_id = $1::uuid AND set_name = $2 AND mode = $3 AND status = 'finished' AND score IS NOT NULL AND id < $4::uuid ORDER BY id DESC LIMIT 1",
        [e.botId, e.set, e.mode, e.runId],
      )
    ).rows[0];
    if (before === undefined || !(e.score < before.score - 1e-9)) return;
    const bot = (await tx.query<BotTarget>(`SELECT id, workspace_id, team_id, slug FROM app.bots WHERE id = $1::uuid AND ${ACTIVE}`, [e.botId])).rows[0];
    if (!bot) return;
    await fileFor(ctx, tx, [bot], 'eval_dropped', '', { now: e.score, before: before.score, min: e.minScore });
  });
}

type ReassessmentRow = {
  id: string;
  team_id: string;
  bot_slug: string;
  reason: string;
  subject: string;
  headline: string;
  checks: unknown;
  status: string;
  created_at: Date;
  closed_at: Date | null;
};

const COLUMNS = 'r.id, r.team_id, b.slug AS bot_slug, r.reason, r.subject, r.headline, r.checks, r.status, r.created_at, r.closed_at';

const toReassessment = (r: ReassessmentRow): Reassessment =>
  Reassessment.parse({
    id: r.id,
    teamId: r.team_id,
    botSlug: r.bot_slug,
    reason: r.reason,
    subject: r.subject,
    headline: r.headline,
    checks: Array.isArray(r.checks) ? r.checks.filter((c): c is string => typeof c === 'string') : [],
    status: r.status,
    createdAt: r.created_at.toISOString(),
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  });

export function registerReassessmentRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listReassessmentsRoute.method,
    path: listReassessmentsRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ReassessmentListResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ReplayBotParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await botOf(tx, team, botSlug);
      const rows = (
        await tx.query<ReassessmentRow>(
          `SELECT ${COLUMNS} FROM app.bot_reassessments r JOIN app.bots b ON b.id = r.bot_id WHERE r.bot_id = $1::uuid AND r.status = 'open' ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
          [bot.id],
        )
      ).rows;
      return json(ReassessmentListResponse.parse({ reassessments: rows.map(toReassessment) }));
    }),
  });

  ctx.http.route({
    method: closeReassessmentRoute.method,
    path: closeReassessmentRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: CloseReassessmentRequest, response: CloseReassessmentResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug, reassessmentId } = ReassessmentParams.parse(req.params);
      const body = CloseReassessmentRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await botOf(tx, team, botSlug);
      const who = await askerRole(tx, team.id);
      if (!who.onTeam || !who.canGrantDestructive) throw forbidden('Only a team lead or an admin can close this notice');
      const updated = (
        await tx.query<{ id: string }>(
          `UPDATE app.bot_reassessments SET status = $3, closed_at = now(), closed_by = (SELECT app.actor())
            WHERE id = $1::uuid AND bot_id = $2::uuid AND status = 'open' RETURNING id`,
          [reassessmentId, bot.id, body.answer],
        )
      ).rows[0];
      if (!updated) throw notFound('No such open notice');
      const row = (await tx.query<ReassessmentRow>(`SELECT ${COLUMNS} FROM app.bot_reassessments r JOIN app.bots b ON b.id = r.bot_id WHERE r.id = $1::uuid`, [reassessmentId])).rows[0];
      if (!row) throw notFound('No such open notice');
      await ctx.audit.emit(tx, {
        type: 'workshop.reassessment.closed',
        schemaVersion: 1,
        workspaceId: team.workspace_id,
        teamId: team.id,
        botId: bot.id,
        slug: bot.slug,
        reassessmentId,
        answer: body.answer,
        at: ctx.runtime.now().toISOString(),
      });
      return json(CloseReassessmentResponse.parse({ reassessment: toReassessment(row) }));
    }),
  });
}
