import {
  HttpError,
  UnreadCounterMissingError,
  definePlugin,
  type PluginTx,
} from '@manythreads/sdk';
import {
  GetReadStateRequest,
  GetReadStateResponse,
  GetUnreadSummaryResponse,
  MarkReadRequest,
  MarkReadResponse,
  getReadStateRoute,
  getUnreadSummaryRoute,
  markReadRoute,
  parseReadStateTargets,
} from '@manythreads/shared';

/** The signed-in person's own id (people.id); read state belongs to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Read state belongs to people');
  return row.id;
}

/**
 * HTTP face of the kernel read-state service (`ctx.readState`, P3-03): the client asks for the state of the targets on screen,
 * the unread badges, and reports how far a person has read. All three act on the caller's own rows; RLS (policy P) enforces it.
 * Marking read counts the messages newer than the position with the counter the plugin that owns the messages registered.
 */
export default definePlugin({
  manifest: { name: 'read-state', version: '0.1.0', kind: 'server' },
  register(ctx) {
    ctx.http.route({
      method: getReadStateRoute.method,
      path: getReadStateRoute.path,
      schema: { query: GetReadStateRequest, response: GetReadStateResponse },
      handler: async (req, tx) => {
        const query = GetReadStateRequest.parse(req.query);
        const person = await callerPerson(tx);
        return { body: { states: await ctx.readState.get(tx, person, parseReadStateTargets(query.targets)) } };
      },
    });

    ctx.http.route({
      method: getUnreadSummaryRoute.method,
      path: getUnreadSummaryRoute.path,
      schema: { response: GetUnreadSummaryResponse },
      handler: async (_req, tx) => ({ body: await ctx.readState.unreadSummary(tx, await callerPerson(tx)) }),
    });

    ctx.http.route({
      method: markReadRoute.method,
      path: markReadRoute.path,
      // The client marks as the person scrolls; a generous limit keeps a runaway tab from hammering the row lock.
      rateLimit: { limit: 600, windowMs: 60_000 },
      schema: { body: MarkReadRequest, response: MarkReadResponse },
      handler: async (req, tx) => {
        const body = MarkReadRequest.parse(req.body);
        const person = await callerPerson(tx);
        try {
          const entry = await ctx.readState.markRead(tx, person, { targetType: body.targetType, targetId: body.targetId }, body.upTo);
          return { body: entry };
        } catch (err) {
          if (err instanceof UnreadCounterMissingError) throw new HttpError(501, 'internal', `Marking ${body.targetType} targets read is not available`);
          throw err;
        }
      },
    });
  },
});
