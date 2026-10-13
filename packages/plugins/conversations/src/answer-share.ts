import { createHash } from 'node:crypto';
import {
  buildCopy,
  checkRemove,
  loadShareView,
  shareDigest,
  storedAnswer,
  type AnswerShareView,
  type MessageProvider,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  type AnswerPayload,
  AnswerPreviewRequest,
  AnswerSharePathParams,
  AnswerSharePreview,
  AnswerShareTargetsResponse,
  HandoffAnswerRequest,
  HandoffAnswerResponse,
  ShareAnswerRequest,
  ShareAnswerResponse,
  answerPagePath,
  answerShareTargetsRoute,
  answerSharePreviewRoute,
  handoffAnswerRoute,
  handoffMessage,
  pageTitle,
  shareAnswerRoute,
  type MaskedAnswer,
} from '@manythreads/shared';
import { HttpError, conflict, forbidden, invalid, json, notFound, route } from './http.ts';

// Sharing an answer of one's own conversation (SPEC §6.3, PLAN P5-17): the preview, the share to a channel, the hand-off to another bot. Save as
// page is the pages plugin's route (it owns the writer) and reads the same view. The decisions are the database's (`app.answer_share_view`, the
// answer plugin's migration 0003: who reads the target, which citations those readers may open, as the sharer); this file arranges them:
//
//   * the request names the answer by its message, in the caller's OWN conversation channel (anything else is a 404: an admin, a teammate, a
//     person who is not the asker, a message that is not an answer — all alike);
//   * the request carries NUMBERS of citations to remove and never any text: the copy is made by `maskAnswer` from the stored answer, so a
//     request can only make an answer shorter;
//   * the preview returns the copy exactly as it would be posted with a digest of it, and the share takes the digest back: what is posted is
//     what the person saw, and a copy that would now read otherwise (a reader added to the channel since) is a 409 with nothing posted;
//   * the copy is posted through the channels plugin's `messages` provider as the person (`copyOf` makes the provider check it against the
//     original again), the conversation is marked shared through its one door, and the access event carries ids and counts only.

/** The preview of a copy. `path` only for a page. */
export function previewOf(view: AnswerShareView, built: MaskedAnswer & { copy: AnswerPayload }, targetLabel: string, path: string | null): AnswerSharePreview {
  const t = view.target;
  return AnswerSharePreview.parse({
    target: {
      kind: path === null ? 'channel' : 'page',
      channelId: path === null ? (t?.channelId ?? null) : null,
      name: path === null ? (t?.name ?? null) : null,
      private: t?.private ?? false,
      path,
    },
    audience: view.reach === 'none' ? 'wider' : 'team',
    items: built.items,
    counts: built.counts,
    removedText: built.removedText,
    payload: built.copy,
    digest: shareDigest(targetLabel, view.answer.messageId, built.copy),
  });
}

/** A target channel the person may share into: a channel of a team (not a conversation or a DM), not archived, that they may post in. */
function requireChannelTarget(view: AnswerShareView): { channelId: string; name: string | null; teamId: string | null; private: boolean } {
  const t = view.target;
  if (t === null || t.channelId === null) throw forbidden('You cannot post in that channel');
  if (t.kind !== 'channel') throw invalid('target: choose a channel of a team');
  if (t.archived) throw conflict('That channel is archived');
  if (!t.canPost) throw forbidden('You can read that channel but not post in it');
  return { channelId: t.channelId, name: t.name, teamId: t.teamId, private: t.private };
}

export function registerAnswerShareRoutes(ctx: PluginContext): void {
  // The channels a copy may go to: team channels the caller may post in. Asked only for an answer that is theirs (the picker of the dialog).
  ctx.http.route({
    ...answerShareTargetsRoute,
    schema: { response: AnswerShareTargetsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = AnswerSharePathParams.parse(req.params);
      await loadShareView(tx, params, null);
      const rows = (
        await tx.query<{ id: string; name: string; private: boolean; team_slug: string | null; team_name: string | null }>(
          `SELECT c.id, c.name, c.private, t.slug AS team_slug, t.name AS team_name
             FROM app.channels c LEFT JOIN app.teams t ON t.id = c.team_id
            WHERE c.id = ANY (app.visible_channel_ids('post')) AND c.kind = 'channel' AND c.archived_at IS NULL
            ORDER BY t.name NULLS LAST, c.name
            LIMIT 200`,
        )
      ).rows;
      return json(
        AnswerShareTargetsResponse.parse({
          channels: rows.map((r) => ({ id: r.id, name: r.name, private: r.private, teamSlug: r.team_slug, teamName: r.team_name })),
        }),
      );
    }),
  });

  // What would be posted, to a channel or to the team's pages, with the claims in `remove` taken out. Writes nothing.
  ctx.http.route({
    ...answerSharePreviewRoute,
    schema: { body: AnswerPreviewRequest, response: AnswerSharePreview },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = AnswerSharePathParams.parse(req.params);
      const body = AnswerPreviewRequest.parse(req.body);
      if (body.target.kind === 'page') {
        const view = await loadShareView(tx, params, 'page');
        const payload = storedAnswer(view);
        const remove = checkRemove(payload, body.remove);
        const built = buildCopy(view, payload, remove);
        const path = answerPagePath(pageTitle(built.copy.body), params.messageId);
        return json(previewOf(view, built, 'page', path));
      }
      const view = await loadShareView(tx, params, { channelId: body.target.channelId });
      requireChannelTarget(view);
      const payload = storedAnswer(view);
      const remove = checkRemove(payload, body.remove);
      return json(previewOf(view, buildCopy(view, payload, remove), `channel:${body.target.channelId}`, null));
    }),
  });

  // Posts the masked copy into a channel as the sharer.
  ctx.http.route({
    ...shareAnswerRoute,
    schema: { body: ShareAnswerRequest, response: ShareAnswerResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = AnswerSharePathParams.parse(req.params);
      const body = ShareAnswerRequest.parse(req.body);
      const view = await loadShareView(tx, params, { channelId: body.targetChannelId });
      const target = requireChannelTarget(view);
      const payload = storedAnswer(view);
      const remove = checkRemove(payload, body.remove);
      const built = buildCopy(view, payload, remove);
      const digest = shareDigest(`channel:${target.channelId}`, params.messageId, built.copy);
      if (digest !== body.digest) {
        // the person confirmed another copy than this would be: nothing is posted, and the dialog asks again
        throw conflict('This answer would now read differently in that channel. Look at the preview again before sharing.');
      }

      // a replay (the same answer, channel, sharer and cut) finds its copy under the share's lock and posts nothing
      const existing = (
        await tx.query<{ id: string | null }>('SELECT app.answer_share_find($1::uuid, $2, $3::uuid, $4) AS id', [params.messageId, 'channel', target.channelId, digest])
      ).rows[0]?.id;
      if (existing) {
        return json(ShareAnswerResponse.parse({ messageId: existing, channelId: target.channelId, replayed: true, counts: built.counts }), 200);
      }

      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) throw new HttpError(503, 'internal', 'Messages are not available in this deployment');
      const posted = await messages.post(tx, {
        channelId: target.channelId,
        body: built.copy.body,
        meta: { answer: built.copy },
        copyOf: params.messageId,
      });
      await tx.query('SELECT app.answer_share_record($1::uuid, $2, $3::uuid, NULL, $4, $5::uuid, $6, $7::int[], $8::int[])', [
        params.messageId,
        'channel',
        target.channelId,
        digest,
        posted.id,
        built.counts.kept,
        built.maskedNumbers,
        built.removedNumbers,
      ]);
      // the conversation is the team's to list under Shared, read through this copy (a channel of another team leaves it private)
      if (view.answer.threadRootId !== null) {
        await tx.query('SELECT app.conversations_mark_shared($1::uuid, $2::uuid, $3::uuid)', [view.answer.threadRootId, target.channelId, posted.id]);
      }
      await ctx.audit.emit(tx, {
        type: 'answer.answer.shared',
        kind: 'channel',
        personId: view.answer.personId,
        botId: view.answer.botId,
        runId: payload.answeredFor.runId,
        messageId: params.messageId,
        channelId: target.channelId,
        copyMessageId: posted.id,
        keptCount: built.counts.kept,
        maskedCount: built.counts.masked,
        removedCount: built.counts.removed,
        maskedNumbers: built.maskedNumbers,
        removedNumbers: built.removedNumbers,
      });
      return json(ShareAnswerResponse.parse({ messageId: posted.id, channelId: target.channelId, replayed: false, counts: built.counts }), 201);
    }),
  });

  // "Hand to <bot>": the answer, as the person's own message in their own conversation with that bot, which starts a thread the bot answers.
  ctx.http.route({
    ...handoffAnswerRoute,
    schema: { body: HandoffAnswerRequest, response: HandoffAnswerResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = AnswerSharePathParams.parse(req.params);
      const body = HandoffAnswerRequest.parse(req.body);
      const owned = await loadShareView(tx, params, null);
      const payload = storedAnswer(owned);
      // only a hand-off the answer itself offered (the platform stamped the chip from a bot of the team that existed)
      const chip = payload.chips.find((c) => c.kind === 'handoff' && c.botId === body.botId);
      if (!chip || chip.kind !== 'handoff') throw invalid('botId: this answer does not offer to be handed to that bot');
      const bot = (
        await tx.query<{ id: string; slug: string; name: string; status: string; team_id: string; conversational: boolean }>(
          `SELECT id, slug, name, status, team_id, jsonb_path_exists(triggers, '$[*] ? (@.type == "conversation")') AS conversational
             FROM app.bots WHERE id = $1`,
          [body.botId],
        )
      ).rows[0];
      if (!bot || bot.team_id !== owned.answer.teamId || bot.id === owned.answer.botId) throw notFound('No such bot to hand this answer to');
      if (bot.status !== 'active') throw conflict(`${bot.name} is not running, so it cannot take this.`);
      if (!bot.conversational) {
        throw new HttpError(409, 'bot_has_no_conversation_trigger', `${bot.name} does not take part in conversations: its definition has no conversation trigger.`);
      }
      // the person's own conversation with that bot (made on first use): the one door every conversation goes through
      const opened = (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [bot.id])).rows[0];
      if (!opened) throw conflict('The conversation could not be opened.');
      if (opened.created) {
        await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: opened.channel_id, teamId: null, name: '', kind: 'bot_conversation', private: true });
      }
      // Who reads the destination decides what is handed over, with the very rule a channel share uses. A private conversation's only reader is
      // the asker, so nothing is lost; if somebody was given access to it (an ACL grant), the copy is masked for them like any share.
      const view = await loadShareView(tx, params, { channelId: opened.channel_id });
      const t = view.target;
      if (t === null || t.channelId === null || t.kind !== 'bot_conversation' || !t.canPost) throw forbidden('You cannot post in that conversation');
      const built = buildCopy(view, payload, []);
      const question = owned.answer.threadRootId === null
        ? ''
        : ((await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE id = $1 AND deleted_at IS NULL', [owned.answer.threadRootId])).rows[0]?.body ?? '');
      const text = handoffMessage({ fromBot: await botName(tx, owned.answer.botId), question, copy: built.copy });
      const digest = createHash('sha256').update(JSON.stringify({ handoff: bot.id, messageId: params.messageId, text })).digest('hex');

      const existing = (
        await tx.query<{ id: string | null }>('SELECT app.answer_share_find($1::uuid, $2, $3::uuid, $4) AS id', [params.messageId, 'handoff', opened.channel_id, digest])
      ).rows[0]?.id;
      if (existing) {
        return json(
          HandoffAnswerResponse.parse({ channelId: opened.channel_id, threadRootId: existing, botSlug: bot.slug, botName: bot.name, replayed: true }),
          200,
        );
      }
      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) throw new HttpError(503, 'internal', 'Messages are not available in this deployment');
      // a plain message of the person's own: the router starts the bot's run for it (the `conversation` trigger), as it does for anything typed there
      const posted = await messages.post(tx, { channelId: opened.channel_id, body: text });
      await tx.query('SELECT app.answer_share_record($1::uuid, $2, $3::uuid, NULL, $4, $5::uuid, $6, $7::int[], $8::int[])', [
        params.messageId,
        'handoff',
        opened.channel_id,
        digest,
        posted.id,
        built.counts.kept,
        built.maskedNumbers,
        built.removedNumbers,
      ]);
      await ctx.audit.emit(tx, {
        type: 'answer.answer.shared',
        kind: 'handoff',
        personId: owned.answer.personId,
        botId: owned.answer.botId,
        runId: payload.answeredFor.runId,
        messageId: params.messageId,
        channelId: opened.channel_id,
        copyMessageId: posted.id,
        keptCount: built.counts.kept,
        maskedCount: built.counts.masked,
        removedCount: 0,
        maskedNumbers: built.maskedNumbers,
        removedNumbers: [],
      });
      return json(
        HandoffAnswerResponse.parse({ channelId: opened.channel_id, threadRootId: posted.id, botSlug: bot.slug, botName: bot.name, replayed: false }),
        201,
      );
    }),
  });
}

/** The name of the bot that answered (the chip names the bot it hands TO). */
async function botName(tx: PluginTx, botId: string): Promise<string> {
  return (await tx.query<{ name: string }>('SELECT name FROM app.bots WHERE id = $1', [botId])).rows[0]?.name ?? 'the bot';
}
