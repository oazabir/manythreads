import { definePlugin } from '@manythreads/sdk';
import { createLivekitProvider } from './livekit.ts';

export {
  LivekitApiError,
  createLivekitProvider,
  livekitConfigFromEnv,
  livekitConfigProblem,
  signJwt,
  verifyJwt,
  type LivekitConfig,
  type LivekitOptions,
} from './livekit.ts';

/**
 * The LiveKit `provider.media` plugin (PLAN P15-02): tokens, rooms, kicks and signed webhooks for a self-hosted LiveKit server. It is loaded always and says
 * "not configured" until `MANYTHREADS_LIVEKIT_URL`, `MANYTHREADS_LIVEKIT_API_KEY` and `MANYTHREADS_LIVEKIT_API_SECRET` are set (read on every call, so setting
 * them needs no code change). It never installs or starts LiveKit: docs/spikes/voice.md and docs/plugins/media-livekit.md.
 */
export default definePlugin({
  manifest: {
    name: 'media-livekit',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.media'],
    capabilities: [],
    events: { emits: [], consumes: [] },
  },
  register(ctx) {
    ctx.providers.register('media', createLivekitProvider());
  },
});
