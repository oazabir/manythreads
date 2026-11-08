import { HttpError, createFakeMediaProvider, definePlugin, route, type FakeMediaProvider } from '@manythreads/sdk';
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
    // Work package S4 (P15-19): make a person "speak" into the fake listener of a room. STUB: 501 until S4.
    ctx.http.route({
      ...fakeMediaSpeakRoute,
      schema: { body: FakeMediaSpeakRequest, response: FakeMediaSpeakResponse },
      handler: route(async () => {
        throw new HttpError(501, 'internal', 'Not built yet');
      }),
    });
  },
});
