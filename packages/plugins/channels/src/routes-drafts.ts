import type { PluginTx } from '@manythreads/sdk';
import {
  DeleteDraftQuery,
  DeleteDraftResponse,
  DraftChannelPathParams,
  ListDraftsResponse,
  SaveDraftRequest,
  SaveDraftResponse,
  deleteDraftRoute,
  listDraftsRoute,
  saveDraftRoute,
} from '@manythreads/shared';
import { forbidden, invalid, json, notFound, route } from './http.ts';
import { DRAFT_COLUMNS, toMessageDraft, type DraftRow } from './rows.ts';
import { myPersonId, requireChannel, requirePost, type Deps } from './service.ts';

/** The signed-in person (people.id); drafts belong to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const id = await myPersonId(tx);
  if (!id) throw forbidden('Drafts belong to people');
  return id;
}

const NIL = '00000000-0000-0000-0000-000000000000';

/**
 * Deletes the caller's draft of one box (a channel's own, or one thread's reply box). Called by the delete route and by the post route, so a message sent
 * from one device takes the draft away from the others too. Answers whether there was one.
 */
export async function clearDraft(tx: PluginTx, channelId: string, threadRootId: string | null | undefined): Promise<boolean> {
  const res = await tx.query(
    'DELETE FROM app.message_drafts WHERE person_id = app.person_id() AND channel_id = $1 AND thread_key = coalesce($2::uuid, $3::uuid) RETURNING id',
    [channelId, threadRootId ?? null, NIL],
  );
  return res.rows.length > 0;
}

/**
 * Drafts kept on the server (PLAN P14-02): the text a person typed in a box and did not send, one per channel box and one per thread reply box, so it is
 * there again on another device. Each row is the caller's own and row-level security enforces it. Nothing is announced to anyone, so no event is emitted
 * and nothing is pushed; the composer reads the draft when a box opens and saves it a moment after typing stops.
 */
export function registerDraftRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...listDraftsRoute,
    schema: { response: ListDraftsResponse },
    rateLimit: { limit: 300, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = DraftChannelPathParams.parse(req.params);
      await callerPerson(tx);
      // the channel need not be readable now: a draft left in a channel the person lost can still be found and thrown away (the policy limits this to their own rows)
      const res = await tx.query<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM app.message_drafts WHERE channel_id = $1 AND person_id = app.person_id() ORDER BY updated_at DESC, id DESC`,
        [channelId],
      );
      return json(ListDraftsResponse.parse({ items: res.rows.map(toMessageDraft) }));
    }),
  });

  ctx.http.route({
    ...saveDraftRoute,
    schema: { body: SaveDraftRequest, response: SaveDraftResponse },
    // a composer saves a moment after typing stops: a person typing in three boxes at once stays well below this
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = DraftChannelPathParams.parse(req.params);
      const body = SaveDraftRequest.parse(req.body);
      await callerPerson(tx);
      // nothing but spaces is not a draft: it clears the box, even where posting is no longer allowed
      if (body.body.trim() === '') {
        await clearDraft(tx, channelId, body.threadRootId);
        return json(SaveDraftResponse.parse({ draft: null }));
      }
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      if (channel.kind === 'bot_conversation' && body.threadRootId) throw invalid('A conversation with a bot has no threads');
      if (body.threadRootId) {
        const root = (
          await tx.query<{ thread_root_id: string | null }>('SELECT thread_root_id FROM app.messages WHERE id = $1 AND channel_id = $2', [body.threadRootId, channelId])
        ).rows[0];
        if (!root) throw notFound('No such message to reply to in this channel');
        if (root.thread_root_id) throw invalid('threadRootId: a draft belongs to the first message of a thread, not to a reply');
      }
      const res = await tx.query<DraftRow>(
        `INSERT INTO app.message_drafts (workspace_id, person_id, channel_id, thread_root_id, body)
         VALUES (app.workspace_id(), app.person_id(), $1, $2, $3)
         ON CONFLICT (person_id, channel_id, thread_key) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
         RETURNING ${DRAFT_COLUMNS}`,
        [channelId, body.threadRootId ?? null, body.body],
      );
      return json(SaveDraftResponse.parse({ draft: toMessageDraft(res.rows[0]!) }));
    }),
  });

  ctx.http.route({
    ...deleteDraftRoute,
    schema: { query: DeleteDraftQuery, response: DeleteDraftResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = DraftChannelPathParams.parse(req.params);
      const q = DeleteDraftQuery.parse(req.query);
      await callerPerson(tx);
      return json(DeleteDraftResponse.parse({ deleted: await clearDraft(tx, channelId, q.threadRootId) }));
    }),
  });
}
