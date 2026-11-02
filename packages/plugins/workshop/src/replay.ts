import { createHash } from 'node:crypto';
import { conflict, forbidden, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  FullReplayEstimate,
  FullReplayRequest,
  FullReplayResponse,
  REPLAY_MAX_DECISIONS,
  REPLAY_MAX_QUESTIONS,
  REPLAY_MAX_RUNS,
  ReplayBotParams,
  ReplayQuery,
  ReplayResponse,
  ReplayResult,
  ReplayRunParams,
  WORKSHOP_MAX_STEPS,
  WORKSHOP_MESSAGE_MAX,
  fullReplayRoute,
  parseBotMd,
  replayBotRoute,
  type RunDecisionKind,
  type RunDecisionOutcome,
} from '@manythreads/shared';
import { askerRole } from './inventory.ts';
import { REPLAY_NOTES, evaluate, prepareGate, toolKey, type MessageNow, type RecordedDecision, type ToolNow } from './replay-eval.ts';
import { readFile } from './wtools.ts';
import { botOf, startSession, type BotRef } from './wroutes.ts';
import { toWorkshopSession } from './wrows.ts';

// Replay of a bot's earlier runs (PLAN P7-07, docs/plugins/workshop.md). Two routes:
//
//   GET  .../replay?days=      FREE. Reads what the bot's runs recorded at the gate, the guard and the tool door and asks today's rules the same questions (replay-eval.ts). No model is
//                              called and nothing is written: the server opens the transaction READ ONLY (route option `readOnly`; a write fails, and the SDK's statement filter refuses
//                              `SET` and statements that end the transaction), and the tool door is asked through a preview that leaves no trace. A lead or an admin sees every run of the bot they may read; anyone else only the runs they started themselves (the row-level policies of
//                              `bot_runs` and `run_decisions` do the rest).
//   POST .../replay/runs/:id/full   A full replay: the bot answering the same message again, in the Rehearse sandbox where every write is held back. Lead or admin only. It does
//                              nothing until the person has seen the cost estimate and sent back its `confirm.tokens` and `confirm.token`; the message is read by the server from the run's record,
//                              never taken from the request.

const READ_LIMIT = { limit: 30, windowMs: 60_000 } as const;
const WRITE_LIMIT = { limit: 10, windowMs: 60_000 } as const;
const DAY_MS = 86_400_000;

type RunRow = { id: string; trigger_type: string; started_at: Date; asker_id: string | null };
type DecisionRow = {
  run_id: string;
  seq: number;
  kind: RunDecisionKind;
  subject: string;
  outcome: RunDecisionOutcome;
  target: string | null;
  message_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
};
type MessageRow = { id: string; body: string; deleted_at: Date | null; edited_at: Date | null };

/** The text of each message the viewer may read now. Read through the viewer's own transaction: a message in a channel they cannot read is not there. */
async function messagesNow(tx: PluginTx, decisions: readonly DecisionRow[]): Promise<Map<string, MessageNow>> {
  // The earliest time any gate decision read the message: an edit after that moment means today's text is not the one the bot may have seen. (The rows come newest first, so the
  // first one met is the LATEST read; the earliest is the smallest time.)
  const firstSeen = new Map<string, Date>();
  for (const d of decisions) {
    if (d.kind !== 'gate' || !d.message_id) continue;
    const seen = firstSeen.get(d.message_id);
    if (!seen || d.created_at.getTime() < seen.getTime()) firstSeen.set(d.message_id, d.created_at);
  }
  const out = new Map<string, MessageNow>();
  if (firstSeen.size === 0) return out;
  const rows = (await tx.query<MessageRow>('SELECT id, body, deleted_at, edited_at FROM app.messages WHERE id = ANY ($1::uuid[])', [[...firstSeen.keys()]])).rows;
  for (const m of rows) {
    const at = firstSeen.get(m.id);
    if (m.deleted_at) out.set(m.id, { kind: 'unreadable' });
    else if (m.edited_at && at && m.edited_at.getTime() > at.getTime()) out.set(m.id, { kind: 'edited' });
    else out.set(m.id, { kind: 'text', text: m.body });
  }
  return out;
}

/** The workspace's guard preset today (`standard` when it never chose one), or null when it cannot be read. */
async function presetNow(ctx: PluginContext, team: TeamRow): Promise<string | null> {
  try {
    const row = (await ctx.db.system((sys) => sys.query<{ preset: string }>('SELECT preset FROM app.llm_settings WHERE workspace_id = $1::uuid', [team.workspace_id]), { workspaceId: team.workspace_id })).rows[0];
    return row?.preset ?? 'standard';
  } catch {
    return null;
  }
}

/** The bot's gate list today, from the BOT.md at the head of the team's files. */
async function gateNow(ctx: PluginContext, tx: PluginTx, team: TeamRow, bot: BotRef): Promise<ReturnType<typeof prepareGate>> {
  try {
    const file = await readFile(ctx, tx, team.id, `bots/${bot.slug}/BOT.md`);
    const parsed = file ? parseBotMd(file.text) : null;
    if (!parsed?.ok) return prepareGate(null, false);
    return prepareGate(parsed.frontmatter.guard?.gate, true);
  } catch {
    return prepareGate(null, false);
  }
}

/** What the broker answers today for each distinct tool question. The bot's actor id is read through the viewer's access to the roster function; a bot that has none answers nothing. */
async function toolsNow(ctx: PluginContext, tx: PluginTx, team: TeamRow, bot: BotRef, decisions: readonly RecordedDecision[]): Promise<{ answers: Map<string, ToolNow>; capped: boolean }> {
  const out = new Map<string, ToolNow>();
  let asked = 0;
  let capped = false;
  // a call whose places were not all kept is never asked about (it would be asked in part)
  const tools = decisions.filter((d) => d.kind === 'tool' && d.detail['truncated'] !== true);
  if (tools.length === 0) return { answers: out, capped };
  const actor = (await tx.query<{ actor_id: string }>('SELECT actor_id FROM app.team_bot_actor_ids($1::uuid) WHERE bot_id = $2::uuid', [team.id, bot.id])).rows[0]?.actor_id;
  for (const d of tools) {
    const key = toolKey(d);
    if (out.has(key)) continue;
    if (asked >= REPLAY_MAX_QUESTIONS) {
      out.set(key, { tooMany: true });
      capped = true;
      continue;
    }
    asked += 1;
    if (!actor) {
      out.set(key, { unavailable: true });
      continue;
    }
    try {
      const path = typeof d.detail['path'] === 'string' ? d.detail['path'] : undefined;
      const paths = Array.isArray(d.detail['paths']) && d.detail['paths'].every((p): p is string => typeof p === 'string') ? (d.detail['paths'] as string[]) : undefined;
      const answer = await ctx.capabilities.preview(tx, actor, d.subject, { ...(path !== undefined ? { path } : {}), ...(paths !== undefined ? { paths } : {}), trigger: d.trigger });
      out.set(key, { allowed: answer.allowed, needsApproval: answer.needsApproval });
    } catch {
      out.set(key, { unavailable: true });
    }
  }
  return { answers: out, capped };
}

/** The replay of one bot's runs of the last `days` days, for the person of `tx`. */
export async function replayBot(ctx: PluginContext, tx: PluginTx, team: TeamRow, bot: BotRef, days: number): Promise<ReplayResult> {
  const who = await askerRole(tx, team.id);
  const seesAll = who.canGrantDestructive;
  const now = ctx.runtime.now();
  const since = new Date(now.getTime() - days * DAY_MS);
  const runRows = (
    await tx.query<RunRow>(
      `SELECT r.id, r.trigger_type, r.started_at, r.asker_id
         FROM app.bot_runs r
        WHERE r.bot_id = $1::uuid AND r.team_id = $2::uuid AND r.rehearsal = false AND r.started_at >= $3::timestamptz
          AND ($4::boolean OR r.asker_id = (SELECT app.actor()))
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT $5::int`,
      [bot.id, team.id, since.toISOString(), seesAll, REPLAY_MAX_RUNS + 1],
    )
  ).rows;
  const runsCapped = runRows.length > REPLAY_MAX_RUNS;
  const runs = runRows.slice(0, REPLAY_MAX_RUNS);
  const triggerOf = new Map(runs.map((r) => [r.id, r.trigger_type]));
  const decisionRows: DecisionRow[] =
    runs.length === 0
      ? []
      : (
          await tx.query<DecisionRow>(
            `SELECT run_id, seq, kind, subject, outcome, target, message_id, detail, created_at
               FROM app.run_decisions WHERE run_id = ANY ($1::uuid[]) ORDER BY created_at DESC, run_id, seq LIMIT $2::int`,
            [runs.map((r) => r.id), REPLAY_MAX_DECISIONS + 1],
          )
        ).rows;
  const decisionsCapped = decisionRows.length > REPLAY_MAX_DECISIONS;
  if (decisionsCapped) decisionRows.length = REPLAY_MAX_DECISIONS;
  const decisions: RecordedDecision[] = decisionRows.map((d) => ({
    runId: d.run_id,
    at: d.created_at.toISOString(),
    kind: d.kind,
    subject: d.subject,
    outcome: d.outcome,
    target: d.target,
    messageId: d.message_id,
    detail: d.detail ?? {},
    trigger: triggerOf.get(d.run_id) ?? 'conversation',
  }));

  // one after the other: they share the person's transaction
  const messages = await messagesNow(tx, decisionRows);
  const gate = decisions.some((d) => d.kind === 'gate') ? await gateNow(ctx, tx, team, bot) : prepareGate(null, false);
  const preset = decisions.some((d) => d.kind === 'guard') ? await presetNow(ctx, team) : null;
  const asked = await toolsNow(ctx, tx, team, bot, decisions);
  const evaluated = evaluate({ decisions, messages, gate, preset, tools: asked.answers });
  const notes: string[] = [...REPLAY_NOTES];
  if (decisionsCapped) notes.unshift(`Only the newest ${String(REPLAY_MAX_DECISIONS)} decisions of these runs were read. Older ones are not in these numbers: choose a shorter window to see them.`);
  if (asked.capped) notes.unshift(`Not everything was checked: this replay asked about at most ${String(REPLAY_MAX_QUESTIONS)} different requests, and the rest are listed as not checked. Choose a shorter window to check them.`);

  // the runs a full replay may start from: a lead or an admin, a run that kept the message it read
  const withMessage = new Map<string, boolean>();
  for (const d of decisions) if (d.messageId) withMessage.set(d.runId, true);
  const fullReplayable = seesAll
    ? runs.filter((r) => withMessage.get(r.id) === true).slice(0, 20).map((r) => ({ runId: r.id, at: r.started_at.toISOString(), trigger: r.trigger_type, hasMessage: true }))
    : [];

  return ReplayResult.parse({
    days,
    since: since.toISOString(),
    model: 'none',
    runs: runs.length,
    runsCapped,
    ...evaluated,
    decisionsCapped: decisionsCapped || asked.capped,
    notes,
    fullReplayable,
  });
}

/** The recorded message id of a run, the first gate or guard line that has one. */
async function runMessageId(tx: PluginTx, runId: string): Promise<string | null> {
  return (await tx.query<{ message_id: string }>('SELECT message_id FROM app.run_decisions WHERE run_id = $1::uuid AND message_id IS NOT NULL ORDER BY seq LIMIT 1', [runId])).rows[0]?.message_id ?? null;
}

/** What the original run cost, from its lines in the spend ledger (read as the system role: the ledger is admin-only, and only these four totals leave this function). */
async function estimateOf(ctx: PluginContext, team: TeamRow, runId: string, actorId: string): Promise<FullReplayEstimate> {
  const row = (
    await ctx.db.system(
      (sys) =>
        sys.query<{ calls: string; prompt: string; completion: string; cost: string }>(
          `SELECT count(*) AS calls, coalesce(sum(prompt_tokens), 0) AS prompt, coalesce(sum(completion_tokens), 0) AS completion, coalesce(sum(cost_usd), 0) AS cost
             FROM app.llm_spend WHERE workspace_id = $1::uuid AND run_id = $2::uuid`,
          [team.workspace_id, runId],
        ),
      { workspaceId: team.workspace_id },
    )
  ).rows[0];
  const calls = Number(row?.calls ?? 0);
  const promptTokens = Number(row?.prompt ?? 0);
  const completionTokens = Number(row?.completion ?? 0);
  const cost = Number(row?.cost ?? 0);
  const priceKnown = cost > 0;
  const basis =
    calls === 0
      ? `No model call is recorded for the original run, so there is no number to estimate from. A replay stops after ${String(WORKSHOP_MAX_STEPS)} model calls whatever happens.`
      : `Counted from the ${String(calls)} model call${calls === 1 ? '' : 's'} the original run made.${priceKnown ? '' : ' No price is recorded for them (a local model, or no price set).'} A replay stops after ${String(WORKSHOP_MAX_STEPS)} model calls.`;
  return FullReplayEstimate.parse({
    runId,
    calls,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens,
    costUsd: priceKnown ? Math.round(cost * 1e6) / 1e6 : null,
    priceKnown,
    maxCalls: WORKSHOP_MAX_STEPS,
    basis,
    confirmToken: confirmTokenOf(runId, actorId, promptTokens + completionTokens),
  });
}

/** What the person sends back with the estimate: a short hash of the run, the person and the number they read, so a bare number (a zero, a guess) never starts a replay. */
const confirmTokenOf = (runId: string, actorId: string, tokens: number): string =>
  createHash('sha256').update(`replay-confirm:${runId}:${actorId}:${String(tokens)}`).digest('hex').slice(0, 16);

export function registerReplayRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: replayBotRoute.method,
    path: replayBotRoute.path,
    rateLimit: READ_LIMIT,
    // the transaction is opened READ ONLY by the server: a write in it fails with the database's own refusal
    readOnly: true,
    schema: { query: ReplayQuery, response: ReplayResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ReplayBotParams.parse(req.params);
      const q = ReplayQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const bot = await botOf(tx, team, botSlug);
      return json(ReplayResponse.parse({ replay: await replayBot(ctx, tx, team, bot, q.days) }));
    }),
  });

  ctx.http.route({
    method: fullReplayRoute.method,
    path: fullReplayRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: FullReplayRequest, response: FullReplayResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug, runId } = ReplayRunParams.parse(req.params);
      const body = FullReplayRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const bot = await botOf(tx, team, botSlug);
      const who = await askerRole(tx, team.id);
      if (!who.onTeam || !who.canGrantDestructive) throw forbidden('Only a team lead or an admin can replay a run in full');
      // the run, through the person's own access: a run they may not read does not exist for them
      const run = (
        await tx.query<{ rehearsal: boolean; started_at: Date }>('SELECT rehearsal, started_at FROM app.bot_runs WHERE id = $1::uuid AND bot_id = $2::uuid AND team_id = $3::uuid', [runId, bot.id, team.id])
      ).rows[0];
      if (!run) throw notFound('No such run');
      if (run.rehearsal) throw conflict('A rehearsal cannot be replayed');
      const messageId = await runMessageId(tx, runId);
      if (!messageId) throw conflict('This run did not keep the message it read, so it cannot be asked again. Only runs made after replay was added can.');
      const message = (await tx.query<{ body: string; deleted_at: Date | null; edited_at: Date | null }>('SELECT body, deleted_at, edited_at FROM app.messages WHERE id = $1::uuid', [messageId])).rows[0];
      if (!message || message.deleted_at) throw conflict('The message is gone or you may not read it, so it cannot be asked again.');
      // the same rule as the free replay: today's text is not what the bot read, so asking the bot again would be asking it something else
      if (message.edited_at && message.edited_at.getTime() > run.started_at.getTime()) throw conflict('The message was edited after the bot read it, so asking the bot again would ask it something different.');
      if (message.body.length > WORKSHOP_MESSAGE_MAX) throw conflict(`The message is longer than ${String(WORKSHOP_MESSAGE_MAX)} characters, which is more than a rehearsal takes.`);
      const actorId = (await tx.query<{ actor: string }>('SELECT (SELECT app.actor())::text AS actor')).rows[0]?.actor ?? '';
      const estimate = await estimateOf(ctx, team, runId, actorId);
      if (!body.confirm) return json(FullReplayResponse.parse({ status: 'needs_confirmation', estimate }));
      if (body.confirm.tokens !== estimate.tokens || body.confirm.token !== estimate.confirmToken) {
        throw conflict('The estimate changed since you looked at it, or it was not the one you were shown. Read it again before you confirm.');
      }
      const row = await startSession(ctx, tx, team, bot, 'rehearse', message.body);
      await ctx.audit.emit(tx, {
        type: 'workshop.replay.started',
        schemaVersion: 1,
        workspaceId: team.workspace_id,
        teamId: team.id,
        botId: bot.id,
        slug: bot.slug,
        runId,
        sessionId: row.id,
        tokens: estimate.tokens,
        at: ctx.runtime.now().toISOString(),
      });
      return json(FullReplayResponse.parse({ status: 'started', estimate, session: toWorkshopSession(row) }), 201);
    }),
  });
}
