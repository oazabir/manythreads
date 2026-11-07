import type { MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  CHAT_UNDO_SECONDS,
  ChatChooseVariantRequest,
  ChatDeleteResponse,
  ChatFeedbackPathParams,
  ChatFeedbackRequest,
  ChatFeedbackResponse,
  ChatModelsResponse,
  ChatPatchRequest,
  ChatPatchResponse,
  ChatPathParams,
  ChatRegenerateRequest,
  ChatRegenerateResponse,
  ChatRestoreResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatThreadPathParams,
  ChatThreadState,
  ChatTurnPathParams,
  chatChooseVariantRoute,
  chatDeleteRoute,
  chatFeedbackRoute,
  chatModelsRoute,
  chatPatchRoute,
  chatRegenerateRoute,
  chatRestoreRoute,
  chatSendRoute,
  chatThreadStateRoute,
  type ChatTurn,
} from '@manythreads/shared';
import { HttpError, conflict, json, notFound, requireTeam, route } from './http.ts';
import { boundAliases, definitionAliases, menuOf } from './models.ts';
import { assertBotCanTalk, callerPersonId, requireBot, type BotRow } from './routes.ts';

// The routes of the Chat screen (PLAN P20-16). Every one is the caller's own: a conversation is private to the person who asked, so each query names
// `person_id = app.person_id()` in addition to the row level security that already hides everybody else's rows.

interface OwnRow {
  thread_root_id: string;
  workspace_id: string;
  bot_id: string;
  channel_id: string;
  title: string | null;
  title_source: 'auto' | 'manual' | null;
  pinned_at: Date | null;
  deleted_at: Date | null;
  model_alias: string | null;
  [key: string]: unknown;
}

/** The caller's own live conversation with this bot, or 404 (somebody else's, a deleted one and a made-up id all answer alike). */
async function requireOwn(tx: PluginTx, bot: BotRow, threadRootId: string, me: string): Promise<OwnRow> {
  const row = (
    await tx.query<OwnRow>(
      `SELECT thread_root_id, workspace_id, bot_id, channel_id, title, title_source, pinned_at, deleted_at, model_alias
         FROM app.conversations WHERE thread_root_id = $1::uuid AND bot_id = $2::uuid AND person_id = $3::uuid`,
      [threadRootId, bot.id, me],
    )
  ).rows[0];
  if (!row || row.deleted_at !== null) throw notFound('No such conversation');
  return row;
}

/**
 * The alias a request picked, checked against the bot's own list; the bot's first alias (or none) when the request picked nothing.
 * One plain sentence and 422 for anything else: an alias the definition does not name, one with no model behind it, a definition that cannot be read right now.
 */
export async function checkedAlias(ctx: PluginContext, tx: PluginTx, bot: BotRow, team: { id: string; workspace_id: string }, picked: string | undefined): Promise<string | null> {
  if (picked === undefined) return null;
  const aliases = await definitionAliases(ctx, tx, { teamId: team.id, slug: bot.slug, definitionSha: bot.definition_sha });
  if (aliases === null) throw conflict('The bot\'s definition could not be read just now, so the model cannot be checked. Try again in a moment.');
  if (!aliases.includes(picked)) throw new HttpError(422, 'validation_failed', `${bot.name} cannot use that model. Pick one from the list.`);
  const bound = await boundAliases(ctx, team.workspace_id, [picked]);
  if (!bound.has(picked)) throw new HttpError(422, 'validation_failed', 'That model has no model behind it yet. Ask an admin to set it up on the LLM page.');
  return picked;
}

const iso = (d: Date): string => d.toISOString();

export function registerChatRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...chatModelsRoute,
    schema: { response: ChatModelsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ChatPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const aliases = (await definitionAliases(ctx, tx, { teamId: team.id, slug: bot.slug, definitionSha: bot.definition_sha })) ?? [];
      const bound = await boundAliases(ctx, team.workspace_id, aliases);
      return json(ChatModelsResponse.parse({ models: menuOf(aliases, bound) }));
    }),
  });

  ctx.http.route({
    ...chatSendRoute,
    schema: { body: ChatSendRequest, response: ChatSendResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ChatPathParams.parse(req.params);
      const body = ChatSendRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      assertBotCanTalk(bot);
      const me = await callerPersonId(tx);
      // the person's own conversation channel with the bot, made on first use (a person off the bot's team is refused there)
      const opened = (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [bot.id])).rows[0];
      if (!opened) throw conflict('The conversation could not be opened.');
      if (opened.created) {
        await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: opened.channel_id, teamId: null, name: '', kind: 'bot_conversation', private: true });
      }
      if (body.threadRootId !== null) {
        const own = await requireOwn(tx, bot, body.threadRootId, me);
        if (own.channel_id !== opened.channel_id) throw notFound('No such conversation');
      }
      const alias = await checkedAlias(ctx, tx, bot, team, body.modelAlias);
      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) throw new HttpError(503, 'internal', 'Messages are not available in this deployment');
      const posted = await messages.post(tx, {
        channelId: opened.channel_id,
        body: body.body,
        threadRootId: body.threadRootId,
        ...(body.attachments !== undefined && body.attachments.length > 0 ? { attachmentIds: body.attachments } : {}),
      });
      if (alias !== null) {
        // filed in the transaction that posted the message, so the router finds it when the message's event arrives (as the Test action files its question)
        await tx.query(
          'INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, app.actor(), $5)',
          [posted.id, team.workspace_id, team.id, bot.id, alias],
        );
        if (body.threadRootId !== null) {
          await tx.query('UPDATE app.conversations SET model_alias = $2 WHERE thread_root_id = $1::uuid AND person_id = $3::uuid', [body.threadRootId, alias, me]);
        }
      }
      return json(ChatSendResponse.parse({ messageId: posted.id, channelId: posted.channelId, createdAt: posted.createdAt }), 201);
    }),
  });

  ctx.http.route({
    ...chatThreadStateRoute,
    schema: { response: ChatThreadState },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId } = ChatThreadPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      const own = await requireOwn(tx, bot, threadRootId, me);
      const root = (await tx.query<{ first: string }>('SELECT left(body_plain, 120) AS first FROM app.messages WHERE id = $1::uuid', [threadRootId])).rows[0];
      const variants = (
        await tx.query<{ turn_message_id: string; reply_message_id: string; variant_no: number; chosen: boolean; model_alias: string | null; stopped: boolean; run_id: string | null }>(
          `SELECT turn_message_id, reply_message_id, variant_no, chosen, model_alias, stopped, run_id
             FROM app.conversation_variants WHERE thread_root_id = $1::uuid AND person_id = $2::uuid ORDER BY turn_message_id, variant_no`,
          [threadRootId, me],
        )
      ).rows;
      const feedback = (
        await tx.query<{ message_id: string; vote: 'up' | 'down'; reason: string }>(
          `SELECT f.message_id, f.vote, f.reason FROM app.conversation_feedback f
             JOIN app.messages m ON m.id = f.message_id AND m.thread_root_id = $1::uuid
            WHERE f.person_id = $2::uuid`,
          [threadRootId, me],
        )
      ).rows;
      const live = (
        await tx.query<{ id: string }>(
          `SELECT id FROM app.bot_runs WHERE reply_root_id = $1::uuid AND bot_id = $2::uuid AND asker_id = app.actor() AND status = 'running' ORDER BY id DESC LIMIT 1`,
          [threadRootId, bot.id],
        )
      ).rows[0];
      const turns = new Map<string, ChatTurn['variants']>();
      for (const v of variants) {
        const list = turns.get(v.turn_message_id) ?? [];
        list.push({ messageId: v.reply_message_id, variantNo: v.variant_no, chosen: v.chosen, modelAlias: v.model_alias, stopped: v.stopped, runId: v.run_id } as ChatTurn['variants'][number]);
        turns.set(v.turn_message_id, list);
      }
      return json(
        ChatThreadState.parse({
          threadRootId,
          channelId: own.channel_id,
          botId: bot.id,
          title: own.title ?? root?.first ?? '',
          pinned: own.pinned_at !== null,
          modelAlias: own.model_alias,
          turns: [...turns].map(([turnMessageId, list]) => ({ turnMessageId, variants: list })),
          feedback: feedback.map((f) => ({ messageId: f.message_id, vote: f.vote, reason: f.reason })),
          liveRunId: live?.id ?? null,
        }),
      );
    }),
  });

  ctx.http.route({
    ...chatPatchRoute,
    schema: { body: ChatPatchRequest, response: ChatPatchResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId } = ChatThreadPathParams.parse(req.params);
      const patch = ChatPatchRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      const own = await requireOwn(tx, bot, threadRootId, me);
      const alias = await checkedAlias(ctx, tx, bot, team, patch.modelAlias);
      const updated = (
        await tx.query<OwnRow>(
          `UPDATE app.conversations SET
              title        = CASE WHEN $3::text IS NULL THEN title ELSE $3::text END,
              title_source = CASE WHEN $3::text IS NULL THEN title_source ELSE 'manual' END,
              pinned_at    = CASE WHEN $4::boolean IS NULL THEN pinned_at WHEN $4::boolean THEN coalesce(pinned_at, now()) ELSE NULL END,
              model_alias  = CASE WHEN $5::text IS NULL THEN model_alias ELSE $5::text END
            WHERE thread_root_id = $1::uuid AND person_id = $2::uuid AND deleted_at IS NULL
        RETURNING thread_root_id, workspace_id, bot_id, channel_id, title, title_source, pinned_at, deleted_at, model_alias`,
          [threadRootId, me, patch.title ?? null, patch.pinned ?? null, alias],
        )
      ).rows[0];
      if (!updated) throw notFound('No such conversation');
      if (patch.title !== undefined) {
        await ctx.audit.emit(tx, {
          type: 'conversations.conversation.renamed',
          botId: bot.id,
          personId: me,
          channelId: own.channel_id,
          threadRootId,
          source: 'manual',
        });
      }
      const first = (await tx.query<{ first: string }>('SELECT left(body_plain, 120) AS first FROM app.messages WHERE id = $1::uuid', [threadRootId])).rows[0];
      return json(
        ChatPatchResponse.parse({
          title: updated.title ?? first?.first ?? '',
          titleSource: updated.title_source,
          pinned: updated.pinned_at !== null,
          modelAlias: updated.model_alias,
        }),
      );
    }),
  });

  ctx.http.route({
    ...chatDeleteRoute,
    schema: { response: ChatDeleteResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId } = ChatThreadPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      const gone = (
        await tx.query<{ deleted_at: Date }>(
          `UPDATE app.conversations SET deleted_at = now()
            WHERE thread_root_id = $1::uuid AND bot_id = $2::uuid AND person_id = $3::uuid AND deleted_at IS NULL RETURNING deleted_at`,
          [threadRootId, bot.id, me],
        )
      ).rows[0];
      if (!gone) throw notFound('No such conversation');
      return json(ChatDeleteResponse.parse({ ok: true, undoUntil: iso(new Date(gone.deleted_at.getTime() + CHAT_UNDO_SECONDS * 1000)) }));
    }),
  });

  ctx.http.route({
    ...chatRestoreRoute,
    schema: { response: ChatRestoreResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId } = ChatThreadPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      const back = await tx.query(
        `UPDATE app.conversations SET deleted_at = NULL
          WHERE thread_root_id = $1::uuid AND bot_id = $2::uuid AND person_id = $3::uuid
            AND deleted_at IS NOT NULL AND deleted_at > now() - make_interval(secs => $4::int) RETURNING 1`,
        [threadRootId, bot.id, me, CHAT_UNDO_SECONDS],
      );
      if (back.rows.length === 0) throw new HttpError(410, 'gone', 'It is too late to undo. The conversation was deleted.');
      return json(ChatRestoreResponse.parse({ ok: true }));
    }),
  });

  ctx.http.route({
    ...chatRegenerateRoute,
    schema: { body: ChatRegenerateRequest, response: ChatRegenerateResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId, turnMessageId } = ChatTurnPathParams.parse(req.params);
      const body = ChatRegenerateRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      assertBotCanTalk(bot);
      const me = await callerPersonId(tx);
      const own = await requireOwn(tx, bot, threadRootId, me);
      // the turn is one of the person's own messages of this thread (the root counts)
      const turn = await tx.query(
        `SELECT 1 FROM app.messages m
          WHERE m.id = $1::uuid AND (m.id = $2::uuid OR m.thread_root_id = $2::uuid) AND m.author_id = app.actor() AND m.deleted_at IS NULL`,
        [turnMessageId, threadRootId],
      );
      if (turn.rows.length === 0) throw notFound('No such message in this conversation');
      const live = await tx.query(
        `SELECT 1 FROM app.bot_runs WHERE reply_root_id = $1::uuid AND bot_id = $2::uuid AND asker_id = app.actor() AND status = 'running' LIMIT 1`,
        [threadRootId, bot.id],
      );
      if (live.rows.length > 0) throw conflict('Wait for the answer to finish, or stop it first.');
      const alias = await checkedAlias(ctx, tx, bot, team, body.modelAlias);
      if (alias !== null) await tx.query('UPDATE app.conversations SET model_alias = $2 WHERE thread_root_id = $1::uuid AND person_id = $3::uuid', [threadRootId, alias, me]);
      await ctx.audit.emit(tx, {
        type: 'conversations.turn.regenerated',
        botId: bot.id,
        personId: me,
        channelId: own.channel_id,
        threadRootId,
        turnMessageId,
        modelAlias: alias,
      });
      return json(ChatRegenerateResponse.parse({ ok: true }), 202);
    }),
  });

  ctx.http.route({
    ...chatChooseVariantRoute,
    schema: { body: ChatChooseVariantRequest, response: ChatRestoreResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, threadRootId, turnMessageId } = ChatTurnPathParams.parse(req.params);
      const { messageId } = ChatChooseVariantRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      await requireOwn(tx, bot, threadRootId, me);
      const done = (await tx.query<{ ok: boolean }>('SELECT app.conversations_choose_variant($1::uuid, $2::uuid) AS ok', [turnMessageId, messageId])).rows[0];
      if (!done?.ok) throw notFound('No such answer');
      return json(ChatRestoreResponse.parse({ ok: true }));
    }),
  });

  ctx.http.route({
    ...chatFeedbackRoute,
    schema: { body: ChatFeedbackRequest, response: ChatFeedbackResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug, messageId } = ChatFeedbackPathParams.parse(req.params);
      const body = ChatFeedbackRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      // the answer is one of the caller's own recorded answers of a live conversation with this bot (so it is a bot's message by construction)
      const answer = (
        await tx.query<{ channel_id: string }>(
          `SELECT c.channel_id FROM app.conversation_variants v
             JOIN app.conversations c ON c.thread_root_id = v.thread_root_id AND c.person_id = $2::uuid AND c.bot_id = $3::uuid AND c.deleted_at IS NULL
            WHERE v.reply_message_id = $1::uuid AND v.person_id = $2::uuid`,
          [messageId, me, bot.id],
        )
      ).rows[0];
      if (!answer) throw notFound('No such answer');
      const vote = body.vote;
      let reason = body.reason ?? '';
      if (vote === null) {
        await tx.query('DELETE FROM app.conversation_feedback WHERE message_id = $1::uuid AND person_id = $2::uuid', [messageId, me]);
        reason = '';
      } else {
        await tx.query(
          `INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote, reason)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
           ON CONFLICT (message_id, person_id) DO UPDATE SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, updated_at = now()`,
          [messageId, me, team.workspace_id, vote, reason],
        );
      }
      await ctx.audit.emit(tx, {
        type: 'conversations.feedback.given',
        botId: bot.id,
        personId: me,
        channelId: answer.channel_id,
        messageId,
        vote: vote ?? 'none',
      });
      return json(ChatFeedbackResponse.parse({ messageId, vote, reason }));
    }),
  });
}
