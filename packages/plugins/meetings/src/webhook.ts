import { HttpError, json, type MediaProvider, type PluginContext } from '@manythreads/sdk';
import { abuseLimit, mediaWebhookRoute } from '@manythreads/shared';
import { z } from 'zod';
import { bestEffort, currentMedia } from './media.ts';
import { dropParticipants } from './service.ts';

// The media server's signed notices. The route is public (the media server has no session): the signature is the credential, checked by the provider, and a body
// without a valid one changes nothing. What a notice may do is narrow on purpose:
//   participant_left / room_finished  mark the people as gone (the database wanted that state anyway)
//   participant_joined                never adds anyone. A person who is not in the room's list (kicked, or removed from the channel) is dropped again, so an
//                                     old token cannot be used to come back before it expires.

const MAX_BODY_BYTES = 64 * 1024;
const Uuid = z.uuid();

async function readBody(stream: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function registerMediaWebhook(ctx: PluginContext): void {
  ctx.http.route({
    ...mediaWebhookRoute,
    public: true,
    // the media server sends no cookie, so there is nothing for a forged page to ride on
    csrfExempt: true,
    rawBody: true,
    rateLimit: abuseLimit('POST', mediaWebhookRoute.path),
    rateLimitBy: 'address',
    handler: async (req) => {
      const provider = currentMedia(ctx);
      const bytes = await readBody(req.stream);
      const notice = provider && bytes ? provider.verifyWebhook(req.headers, bytes) : null;
      if (!notice) throw new HttpError(401, 'unauthenticated', 'The notice is not signed by the media server');
      if (!Uuid.safeParse(notice.room).success) return json({ ok: true });
      const media: MediaProvider = provider!;
      await ctx.db.system(async (tx) => {
        const room = (await tx.query<{ state: string }>('SELECT state FROM app.meetings WHERE id = $1::uuid', [notice.room])).rows[0];
        if (!room) return;
        if (notice.kind === 'participant_left' && notice.identity && Uuid.safeParse(notice.identity).success && room.state === 'live') {
          await dropParticipants(ctx, tx, { where: 'p.meeting_id = $1::uuid AND p.actor_id = $2::uuid', params: [notice.room, notice.identity] }, 'dropped');
        } else if (notice.kind === 'room_finished' && room.state === 'live') {
          await dropParticipants(ctx, tx, { where: 'p.meeting_id = $1::uuid', params: [notice.room] }, 'dropped');
        } else if (notice.kind === 'participant_joined' && notice.identity && Uuid.safeParse(notice.identity).success) {
          const here =
            room.state === 'live' &&
            (await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL', [notice.room, notice.identity])).rows.length > 0;
          if (!here) await bestEffort(undefined, 'dropping a person who is not in the room', () => media.kick(notice.room, notice.identity!));
        }
      });
      return json({ ok: true });
    },
  });
}
