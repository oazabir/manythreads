import { HttpError, createFakeMediaProvider, definePlugin, json, makeFakeAsrWav, route, type FakeMediaProvider } from '@manythreads/sdk';
import { FakeMediaSpeakRequest, FakeMediaSpeakResponse, fakeMediaSpeakRoute } from '@manythreads/shared';

/**
 * A deterministic `provider.media` for tests (PLAN P15-02). Loaded only by test servers (`TEST_ONLY_PLUGIN_DIRS`), never in a real deployment. The meetings
 * plugin picks it when `MANYTHREADS_MEDIA_PROVIDER=fake`; a test reads `lastFakeMedia()` to see every room, token and kick, to switch it off, or to sign a webhook.
 * The clock is the server's (`ctx.runtime.now`), so a test that moves the clock moves token expiry too.
 */
// On globalThis, not in the module: the server loads this file by its path and a test imports it by its package name, and those can be two module instances.
const KEY = Symbol.for('manythreads.media-fake.latest');
const slot = globalThis as unknown as Record<symbol, FakeMediaProvider | undefined>;

/** The fake of the most recently started test server. Throws when none has started. */
export function lastFakeMedia(): FakeMediaProvider {
  const latest = slot[KEY];
  if (!latest) throw new Error('no test server with the media-fake plugin has started');
  return latest;
}

export default definePlugin({
  manifest: {
    name: 'media-fake',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.media'],
    capabilities: [],
    events: { emits: [], consumes: [] },
  },
  register(ctx) {
    const fake = createFakeMediaProvider({ now: () => ctx.runtime.now() });
    slot[KEY] = fake;
    ctx.providers.register('media', fake);
    // P15-19: make a person "speak" into the room's fake listener. The fake delivers one WAV whose data carries `FAKEASR:<text>`, as if the person had just said it.
    // `delivered` is false when the room has no listener or the listener is not subscribed to that person (somebody who did not say yes never is), so a test learns
    // from the answer that nothing of a declined person reached the server. The route answers 404 in production, where this plugin is never loaded anyway.
    ctx.http.route({
      ...fakeMediaSpeakRoute,
      schema: { body: FakeMediaSpeakRequest, response: FakeMediaSpeakResponse },
      handler: route(async (req) => {
        if (process.env['NODE_ENV'] === 'production') throw new HttpError(404, 'not_found', 'Not found');
        const body = FakeMediaSpeakRequest.parse(req.body);
        const listener = fake.listeners.get(body.meetingId);
        if (!listener) return json(FakeMediaSpeakResponse.parse({ delivered: false }));
        const delivered = listener.deliver({
          identity: body.actorId,
          wav: makeFakeAsrWav(body.text, body.durationMs),
          startedAt: new Date(ctx.runtime.now().getTime() - body.durationMs),
          durationMs: body.durationMs,
        });
        return json(FakeMediaSpeakResponse.parse({ delivered }));
      }),
    });
  },
});
