import { definePlugin } from '@manythreads/sdk';
import { registerDeliverJob } from './deliver.ts';
import { registerChatRoute } from './routes.ts';

/**
 * slack-compat (SPIKE, P5-01, docs/spikes/slack-compat.md): one public `chat.postMessage` route plus the SYSTEM job
 * that lands the message. The pairing token in the request body is the only credential; the route resolves it to a
 * bot actor and enqueues, the job validates and inserts. No tables, so no migrations. Spike quality, clearly marked:
 * the job handler writes `app.messages` directly (see deliver.ts) — P5-10 must not copy that.
 */
export default definePlugin({
  manifest: {
    name: 'slack-compat',
    version: '0.1.0',
    kind: 'server',
    dependsOn: ['channels', 'bots'],
    extends: ['job.register', 'event.emit'],
    events: {
      emits: ['channel.message.posted'],
      consumes: [],
    },
  },
  register(ctx) {
    registerChatRoute(ctx);
    registerDeliverJob(ctx);
  },
});
