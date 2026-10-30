import { createHash } from 'node:crypto';
import type { MessageProvider, PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import {
  BOT_TEST_INTERCEPTS_MAX,
  BotTestRequest,
  BotTestPathParams,
  BotTestResult,
  BotTestResultPathParams,
  BotTestStarted,
  botMdPath,
  botTestResultRoute,
  botTestRoute,
  parseBotMd,
  type BotTestKnowledge,
  type BotTestStatus,
} from '@manythreads/shared';
import { HttpError, conflict, json, notFound, requireManage, requireTeam, route } from './http.ts';

// The bot page's Test action (PLAN P7-11): one question, asked as the signed-in team lead or workspace admin in their own conversation with the bot, run
// for real except that every write the bot tries is held back at the MCP gateway and listed. Two routes:
//
//   POST …/bots/:botSlug/test            posts the question into the caller's own conversation channel as an ordinary message and files it in
//                                        `app.rehearsal_questions` in the same transaction. The router (runtime-hermes) finds the row when the message's
//                                        event arrives and queues the run as a rehearsal. The request carries the question and nothing else: there is no flag,
//                                        channel or asker to send, so there is nothing for a client to forge.
//   GET  …/bots/:botSlug/test/:messageId where the test stands: the run's state, the writes held back, and whether the answer had knowledge behind it.
//                                        The answer itself is the reply in the thread, read with the thread route.
//
// Who may: `manage` on the bot's team (the same rule that lets a lead edit the bot). The question never leaves the person's private conversation channel.

interface BotRow {
  id: string;
  name: string;
  slug: string;
  runtime: string;
  status: string;
  definition_sha: string;
  conversational: boolean;
  knowledge: unknown;
  [key: string]: unknown;
}

async function requireBot(tx: PluginTx, teamId: string, botSlug: string): Promise<BotRow> {
  const bot = (
    await tx.query<BotRow>(
      `SELECT id, name, slug, runtime, status, definition_sha, knowledge, jsonb_path_exists(triggers, '$[*] ? (@.type == "conversation")') AS conversational
         FROM app.bots WHERE team_id = $1 AND slug = $2`,
      [teamId, botSlug],
    )
  ).rows[0];
  if (!bot) throw notFound(`No bot "${botSlug}"`);
  return bot;
}

/**
 * The runtime tools (`capabilities.runtime`) the bot's definition grants its own process, read from the file the roster row was loaded from. A rehearsal
 * holds back what goes through the platform's tool door; a shell, files or a browser in the bot's own process do not, so the test is refused for such a bot.
 * Null when the definition could not be read as the loaded one: the caller then refuses too (it cannot say what the bot may do).
 */
async function runtimeGrantsOf(ctx: PluginContext, tx: PluginTx, bot: BotRow, teamId: string): Promise<readonly string[] | null> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return null;
  await tx.query('SAVEPOINT rehearsal_definition');
  try {
    const file = await repo.blob(tx, teamId, botMdPath(bot.slug), 'main');
    await tx.query('RELEASE SAVEPOINT rehearsal_definition');
    if (createHash('sha256').update(file.content).digest('hex') !== bot.definition_sha) return null;
    const parsed = parseBotMd(Buffer.from(file.content).toString('utf8'));
    return parsed.ok ? (parsed.frontmatter.capabilities?.runtime ?? []) : null;
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT rehearsal_definition');
    await tx.query('RELEASE SAVEPOINT rehearsal_definition');
    return null;
  }
}

/** The base names a bot lists (`knowledge:` of BOT.md as the loader projected it); empty means every base of its team. */
function listedBases(knowledge: unknown): string[] {
  if (!Array.isArray(knowledge)) return [];
  return knowledge.flatMap((e) => (typeof (e as { base?: unknown })?.base === 'string' ? [(e as { base: string }).base] : []));
}

/** Does any knowledge base this bot may search hold a document that was read? Reads the knowledge plugin's tables when it is installed; false when it is not. */
async function hasKnowledge(tx: PluginTx, teamId: string, bases: string[]): Promise<boolean> {
  const present = (await tx.query<{ ok: boolean }>("SELECT to_regclass('app.knowledge_documents') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (!present) return false;
  const res = await tx.query(
    `SELECT 1 FROM app.knowledge_documents d JOIN app.knowledge_bases b ON b.id = d.base_id
      WHERE d.team_id = $1::uuid AND d.status = 'indexed' AND ($2::text[] = '{}'::text[] OR b.slug = ANY ($2::text[])) LIMIT 1`,
    [teamId, bases],
  );
  return res.rows.length > 0;
}

/** How long a filed question counts as a test in progress while its run has not opened yet (it waits behind the bot's other runs); after that the next test may go. */
const UNSTARTED_TEST_SECONDS = 300;

export function registerRehearsalRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...botTestRoute,
    schema: { body: BotTestRequest, response: BotTestStarted },
    // a test costs a model call: the same ceiling as other model-starting actions of a lead, per client
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotTestPathParams.parse(req.params);
      const { question } = BotTestRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = await requireBot(tx, team.id, botSlug);
      if (bot.status !== 'active') {
        throw conflict(bot.status === 'disabled' ? 'This bot is turned off, so it cannot be tested.' : "This bot's BOT.md is invalid, so it cannot be tested until it is fixed.");
      }
      if (bot.runtime !== 'hermes') throw conflict('Only a bot that answers with a model can be tested here.');
      if (!bot.conversational) {
        throw new HttpError(409, 'bot_has_no_conversation_trigger', `${bot.name} does not take part in conversations: its definition has no conversation trigger.`);
      }
      const grants = await runtimeGrantsOf(ctx, tx, bot, team.id);
      if (grants === null) throw conflict('The definition could not be read just now, so the test cannot check what the bot may do. Try again in a moment.');
      if (grants.length > 0) {
        throw conflict(
          `${bot.name} is allowed to use ${grants.join(', ')} in its own process, and a test cannot hold those back (it only holds back what goes through the platform's tools). Test a copy without it.`,
        );
      }
      // One test at a time per person and bot: a model call is not something to queue up. A test is "running" from the moment its question is filed, not
      // from the moment the router opens its run (that comes later, behind the bot's queue), so a second press in between is caught too. The lock makes two
      // presses at the same instant take turns: the second reads the first's question once it commits.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('bots.rehearsal-test:' || $1::text || ':' || app.actor()::text, 0))", [bot.id]);
      const open = await tx.query(
        `SELECT 1 FROM app.bot_runs WHERE bot_id = $1::uuid AND asker_id = app.actor() AND rehearsal AND ended_at IS NULL
         UNION ALL
         SELECT 1 FROM app.rehearsal_questions q
          WHERE q.bot_id = $1::uuid AND q.asked_by = app.actor() AND q.created_at > now() - make_interval(secs => $2::int)
            AND NOT EXISTS (SELECT 1 FROM app.bot_runs r WHERE r.reply_root_id = q.message_id AND r.rehearsal)
         LIMIT 1`,
        [bot.id, UNSTARTED_TEST_SECONDS],
      );
      if (open.rows.length > 0) throw conflict('A test of this bot is still running. Wait for its answer first.');

      // the person's own conversation with the bot, made on first use: the one door every conversation goes through (a person off the bot's team is refused there)
      const opened = (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [bot.id])).rows[0];
      if (!opened) throw conflict('The conversation could not be opened.');
      if (opened.created) {
        await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: opened.channel_id, teamId: null, name: '', kind: 'bot_conversation', private: true });
      }
      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) throw new HttpError(503, 'internal', 'Messages are not available in this deployment');
      const posted = await messages.post(tx, { channelId: opened.channel_id, body: question });
      await tx.query(
        'INSERT INTO app.rehearsal_questions (message_id, workspace_id, team_id, bot_id, asked_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, app.actor())',
        [posted.id, team.workspace_id, team.id, bot.id],
      );
      return json(BotTestStarted.parse({ botName: bot.name, channelId: opened.channel_id, messageId: posted.id }), 201);
    }),
  });

  ctx.http.route({
    ...botTestResultRoute,
    schema: { response: BotTestResult },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, messageId } = BotTestResultPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      // the row is the asker's alone (row-level security): somebody else's test, a message that was never a test and another bot's all answer alike
      const question = (
        await tx.query<{ channel_id: string }>(
          `SELECT m.channel_id FROM app.rehearsal_questions q JOIN app.messages m ON m.id = q.message_id WHERE q.message_id = $1::uuid AND q.bot_id = $2::uuid`,
          [messageId, bot.id],
        )
      ).rows[0];
      if (!question) throw notFound('No such test');

      const run = (
        await tx.query<{ id: string; status: string }>(
          'SELECT id, status FROM app.bot_runs WHERE reply_root_id = $1::uuid AND bot_id = $2::uuid AND rehearsal ORDER BY id DESC LIMIT 1',
          [messageId, bot.id],
        )
      ).rows[0];

      let status: BotTestStatus = 'waiting';
      let intercepted: Array<{ seq: number; capability: string; target: string | null; would_wait: boolean; created_at: Date }> = [];
      let knowledge: BotTestKnowledge = (await hasKnowledge(tx, team.id, listedBases(bot.knowledge))) ? 'not_used' : 'none';
      if (run) {
        intercepted = (
          await tx.query<{ seq: number; capability: string; target: string | null; would_wait: boolean; created_at: Date }>(
            'SELECT seq, capability, target, would_wait, created_at FROM app.rehearsal_intercepts WHERE run_id = $1::uuid ORDER BY seq LIMIT $2',
            [run.id, BOT_TEST_INTERCEPTS_MAX + 1],
          )
        ).rows;
        if (run.status === 'failed') status = 'failed';
        else if (run.status === 'stopped') status = 'stopped';
        else if (run.status === 'done') {
          const replied = await tx.query(
            `SELECT 1 FROM app.messages m
              WHERE m.thread_root_id = $1::uuid AND m.author_id <> app.actor() AND m.deleted_at IS NULL LIMIT 1`,
            [messageId],
          );
          status = replied.rows.length > 0 ? 'answered' : 'stopped';
        }
        if (knowledge !== 'none') {
          const read = await tx.query("SELECT 1 FROM app.run_source_log WHERE run_id = $1::uuid AND source_type = 'knowledge' LIMIT 1", [run.id]);
          if (read.rows.length > 0) knowledge = 'used';
        }
      }
      return json(
        BotTestResult.parse({
          messageId,
          channelId: question.channel_id,
          status,
          intercepted: intercepted.slice(0, BOT_TEST_INTERCEPTS_MAX).map((r) => ({
            seq: r.seq,
            capability: r.capability,
            target: r.target,
            wouldWait: r.would_wait,
            at: r.created_at.toISOString(),
          })),
          interceptedMore: intercepted.length > BOT_TEST_INTERCEPTS_MAX,
          knowledge,
        }),
      );
    }),
  });
}
